import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import { applyTranslation, isMathOnly, outputIssue, prepareHTML, renderTranslation, userPrompt } from '../electron/main/translation'
import { applyHiddenRegions, sanitize } from '../electron/main/localizer'
import { parseArxivAtom } from '../electron/main/importer'
import { parseResponse } from '../electron/main/llm'
import { assistantMessages } from '../electron/main/assistant'
import { protectLatex, restoreLatex } from '../LaTeXTransKit'
import { FreddieRebuildModelClient, lastRebuiltPage } from '../RebuildPDFKit'

describe('HTML translation pipeline', () => {
  const page = `<html><head></head><body class="rp-readability-body"><main><h2>Method</h2>
    <p>This paragraph explains the method in detail <math><mi>x</mi></math> carefully.</p>
    <p>x = y</p>
    <ul><li>A list item that is long enough</li></ul>
    <p data-rp-hidden="true">This hidden paragraph is never translated at all.</p>
    <div class="rp-translation-block" data-rp-translation="true">old</div></main></body></html>`

  it('marks candidates, protects math, and skips hidden regions', () => {
    const $ = cheerio.load(page)
    const candidates = prepareHTML($)
    expect(candidates.map((candidate) => candidate.tagName)).toEqual(['h2', 'p', 'li'])
    expect(candidates[1].sourceText).toBe('This paragraph explains the method in detail [PROTECTED_0] carefully.')
    expect(candidates[1].sectionTitle).toBe('Method')
    expect(candidates[1].previousSourceText).toBe('Method')
    expect($('.rp-translation-block').length).toBe(0)
    expect($('#rp-translation-display-style').length).toBe(1)
  })

  it('inserts escaped translations after their source and restores protected fragments', () => {
    const $ = cheerio.load(page)
    const candidates = prepareHTML($)
    applyTranslation($, candidates[1], '方法 [PROTECTED_0] <script>')
    const block = $(`[data-rp-segment-id="${candidates[1].segmentId}"]`).next()
    expect(block.hasClass('rp-translation-block')).toBe(true)
    expect(block.find('math').length).toBe(1)
    expect(block.html()).toContain('&lt;script&gt;')
    expect(renderTranslation('a', candidates[0])).toMatch(/^<h2 class="rp-translation-block"/)
  })

  it('treats formula-only text as untranslatable', () => {
    expect(isMathOnly('[PROTECTED_0] = [PROTECTED_1]')).toBe(true)
    expect(isMathOnly('$$x^2$$ where x is')).toBe(false)
  })

  it('rejects echoed prompts and sources but keeps placeholder mismatches as usable', () => {
    const source = 'The quick brown fox jumps over the lazy dog'
    expect(outputIssue(`<<<SOURCE_SEGMENT_TO_TRANSLATE>>>\n${source}`, source, {})).toBe('promptEcho')
    expect(outputIssue(source, source, {})).toBe('sourceEcho')
    expect(outputIssue('译文 [PROTECTED_1]', 'Text [PROTECTED_0]', {})).toBe('placeholderMismatch')
    expect(outputIssue('译文 [PROTECTED_0]', 'Text [PROTECTED_0]', {})).toBeUndefined()
    expect(userPrompt('Hello', { documentTitle: 'Doc' })).toBe('<<<DOCUMENT_TITLE>>>\nDoc\n<<<END_DOCUMENT_TITLE>>>\n\n<<<SOURCE_SEGMENT_TO_TRANSLATE>>>\nHello\n<<<END_SOURCE_SEGMENT_TO_TRANSLATE>>>')
  })
})

describe('LaTeXTransKit port', () => {
  it('restores protected LaTeX only when every token keeps its order', () => {
    const value = protectLatex(String.raw`\textbf{Proof} uses $x+y$ and \cite{a}.`)
    expect(restoreLatex(value.template.replace('Proof', '证明').replace('uses', '使用'), value)).toBe(String.raw`\textbf{证明} 使用 $x+y$ and \cite{a}.`)
    expect(restoreLatex(value.template.replace('[PROTECTED_LATEX_0]', ''), value)).toBeUndefined()
    expect(restoreLatex(value.template.replace('[PROTECTED_LATEX_0]', '[PROTECTED_LATEX_1]'), value)).toBeUndefined()
  })
})

describe('RebuildPDFKit integration', () => {
  it('ends a translation before failed pages at its end and keeps failed pages within it', () => {
    expect(lastRebuiltPage([1, 2, 3, 4, 5], 6, new Set([2, 5]))).toBe(4)
    expect(lastRebuiltPage(undefined, 6, new Set([6]))).toBe(5)
    expect(lastRebuiltPage(undefined, 3, new Set())).toBe(3)
    expect(lastRebuiltPage([1, 2], 3, new Set([1, 2]))).toBeUndefined()
  })

  it('sends text-only messages as strings and images as JPEG parts', () => {
    const jpeg = new Uint8Array([0xff, 0xd8])
    expect(FreddieRebuildModelClient.message({ role: 'user', parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual({ role: 'user', content: 'ab' })
    expect(FreddieRebuildModelClient.message({ role: 'user', parts: [{ type: 'text', text: 'Page 1.' }, { type: 'jpeg', data: jpeg }] })).toEqual({
      role: 'user', content: [{ type: 'text', text: 'Page 1.' }, { type: 'image', data: jpeg, mediaType: 'image/jpeg' }]
    })
  })
})

describe('HTML localization', () => {
  it('strips active content and makes links absolute', () => {
    const $ = cheerio.load('<body><script>x()</script><a href="/p" onclick="x()">a</a><a href="javascript:alert(1)">b</a><iframe src="https://x"></iframe><link rel="preload" href="a.js"><img src="i.png" onerror="x()"></body>')
    sanitize($, new URL('https://example.com/dir/page'))
    expect($('script, iframe, link').length).toBe(0)
    expect($('a').first().attr('href')).toBe('https://example.com/p')
    expect($('a').first().attr('onclick')).toBeUndefined()
    expect($('a').eq(1).attr('href')).toBeUndefined()
    expect($('img').attr('onerror')).toBeUndefined()
  })

  it('marks hidden regions by their reader path', () => {
    const $ = cheerio.load('<body><main><p>a</p><div class="rp-translation-block">t</div><p>b</p></main></body>')
    applyHiddenRegions($, ['rp-path:0/1'])
    expect($('p').eq(1).attr('data-rp-hidden')).toBe('true')
    expect($('p').eq(0).attr('data-rp-hidden')).toBeUndefined()
  })
})

describe('arXiv metadata', () => {
  it('parses the Atom API entry', () => {
    const metadata = parseArxivAtom(`<feed><entry><id>http://arxiv.org/abs/2303.08774v6</id><title>GPT-4
      Technical Report</title><summary> Abstract text. </summary><published>2023-03-15T17:15:04Z</published>
      <author><name>OpenAI</name></author><category term="cs.CL"/><link title="pdf" href="http://arxiv.org/pdf/2303.08774v6"/></entry></feed>`)
    expect(metadata).toMatchObject({ arxivId: '2303.08774', version: 'v6', title: 'GPT-4 Technical Report', abstract: 'Abstract text.', authors: ['OpenAI'], categories: ['cs.CL'], pdfUrl: 'https://arxiv.org/pdf/2303.08774v6' })
    expect(parseArxivAtom('<feed><entry><id>http://arxiv.org/api/errors</id><title>Error</title></entry></feed>')).toBeUndefined()
  })
})

describe('LLM wire protocols', () => {
  it('reads text and web sources from each API style', () => {
    expect(parseResponse('chat-completions', { choices: [{ message: { content: ' hi ' } }] }).text).toBe('hi')
    const responses = parseResponse('responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'a', annotations: [{ type: 'url_citation', url: 'https://x', title: 'X' }] }] }] })
    expect(responses).toEqual({ text: 'a', sources: [{ url: 'https://x', title: 'X' }] })
    const anthropic = parseResponse('anthropic-messages', { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://y' }] }, { type: 'text', text: 'b' }] })
    expect(anthropic).toEqual({ text: 'b', sources: [{ url: 'https://y', title: undefined }] })
  })
})

describe('reading assistant prompt', () => {
  it('delimits untrusted fields and replays the conversation', () => {
    const messages = assistantMessages({
      requestId: 'r', paperId: 'p', action: 'ask', question: 'Why?',
      selection: { quote: 'Selected', context: 'Around' },
      conversation: [{ question: 'Before?', answer: 'Earlier answer', sources: [] }]
    }, 'Title', 'Simplified Chinese', '', '', [{ id: 's', kind: 'paperPDF', title: 'Page 2', excerpt: 'Evidence', pageIndex: 1 }], false)
    expect(messages[0].content).toContain('Answer QUESTION in Simplified Chinese')
    expect(messages[1].content).toContain('<<<SELECTED_TEXT>>>\nSelected')
    expect(messages[1].content).toContain('[S1] Page 2\nPAGE: 2\nLOW_CONFIDENCE_PDF_TEXT: true')
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'user'])
  })
})
