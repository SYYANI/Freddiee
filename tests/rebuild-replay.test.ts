import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { RebuildPipeline } from '../RebuildPDFKit/src/pipeline'
import { TesseractTextRecognizer } from '../RebuildPDFKit/src/textRecognition'
import { simplifiedChinese } from '../RebuildPDFKit/src/translation'
import { XeLaTeXCompiler } from '../RebuildPDFKit/src/xelatex'
import { ScriptedModel, pageCount, pageText, temporaryDirectory, xelatexPath } from './rebuild-support'

/**
 * Real scans rebuilt offline from answers a model gave before, with Tesseract measuring the
 * pages. Needs the local rebuild-pdf scan corpus (REBUILD_SCAN_CORPUS, or ../rebuild-pdf next to
 * this repository) and XeLaTeX; no API is called.
 */
const upstream = resolve(__dirname, '..', '..', 'rebuild-pdf')
const corpus = process.env.REBUILD_SCAN_CORPUS ?? join(upstream, 'ocr-papers')
const live = join(upstream, 'robustness.rebuild', 'live')
const thompson = join(corpus, 'Thompson_1984_Reflections on Trusting Trust.pdf')
const royceName = 'Royce_1970_Managing the Development of Large Software Systems'
const royce = join(corpus, `${royceName}.pdf`)
const royceArtifacts = join(live, royceName, 'artifacts')

const compiler = new XeLaTeXCompiler(xelatexPath ?? 'xelatex')
const recognizer = new TesseractTextRecognizer()
const directories: Array<{ cleanup(): void }> = []
afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup()
})
afterAll(() => recognizer.close())

describe.skipIf(!xelatexPath || !existsSync(thompson))('RebuildPDFKit Thompson replay', { timeout: 600_000 }, () => {
  it('typesets all three pages from their original model answers without transcription retries', async () => {
    const directory = temporaryDirectory()
    directories.push(directory)
    const answers = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'rebuild-pdf', 'thompson-transcriptions.json'), 'utf8')) as Record<string, string>
    const transcriber = new ScriptedModel((request) => request.label.startsWith('review')
      ? '<changes></changes><unchanged/>'
      : answers[String(Number(request.label.slice(-4)))], 'thompson-replay')
    const output = join(directory.path, 'rebuilt.pdf')
    const result = await new RebuildPipeline({ transcriber, recognizer, compiler, configuration: { maximumConcurrentPages: 1 } })
      .run(thompson, output, join(directory.path, 'artifacts'))
    expect(Object.fromEntries(result.fallbacks)).toEqual({})
    expect(result.rebuiltPages).toEqual([1, 2, 3])
    expect(await pageCount(output)).toBe(3)
    expect(await pageText(output, 0)).toContain('Reflections')
    expect(await pageText(output, 0)).toContain('¢')
    expect(await pageText(output, 1)).toContain('compiler')
    expect(await pageText(output, 2)).toContain('compiler')
    for (const number of [1, 2, 3]) expect(transcriber.labels.filter((label) => label === `typeset-page-000${number}`).length).toBe(1)
  })
})

describe.skipIf(!xelatexPath || !existsSync(royce) || !existsSync(royceArtifacts))('RebuildPDFKit Royce translation replay', { timeout: 600_000 }, () => {
  it('rebuilds and translates a page with a figure from the answers of a Python run', async () => {
    const directory = temporaryDirectory()
    directories.push(directory)
    const source = JSON.parse(await readFile(join(royceArtifacts, 'typeset', 'page-0002.json'), 'utf8')) as { final: string }
    const responses = (await import('node:fs/promises')).readdir(join(royceArtifacts, 'responses'))
    const translationFile = (await responses).find((file) => file.startsWith('translate-zh-page-0002-'))!
    const translation = (JSON.parse(await readFile(join(royceArtifacts, 'responses', translationFile), 'utf8')) as {
      choices: Array<{ message: { content: string } }>
    }).choices[0].message.content
    const transcriber = new ScriptedModel((request) => request.label.startsWith('review') ? '<changes></changes><unchanged/>' : source.final, 'royce-transcriber')
    const translator = new ScriptedModel(() => translation, 'royce-translator')
    const output = join(directory.path, 'royce.zh.pdf')
    const transcription = join(directory.path, 'royce.rebuilt.pdf')
    const result = await new RebuildPipeline({
      transcriber, translator, recognizer, compiler, configuration: { pages: [2], translation: simplifiedChinese }
    }).run(royce, output, join(directory.path, 'artifacts'), transcription)
    expect(Object.fromEntries(result.fallbacks)).toEqual({})
    expect(result.rebuiltPages).toEqual([2])
    expect(result.sourceRebuiltPages).toEqual([2])
    expect(translator.labels).toEqual(['translate-zh-page-0002'])
    expect((await pageText(output, 1)).replace(/\s/g, '')).toContain('图2.')
    expect(await pageText(transcription, 1)).toContain('Figure 2.')
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8')) as { page_reports: Array<{ figures: string[]; translation_layout?: unknown }>; ocr: string }
    expect(manifest.ocr).toBe('tesseract')
    expect(manifest.page_reports[0].figures).toEqual(['f1'])
    expect(manifest.page_reports[0].translation_layout).toBeDefined()
    expect(existsSync(join(directory.path, 'artifacts', 'translations', 'zh', 'typeset', 'build-0002', 'fig-f1.png'))).toBe(true)
  })
})
