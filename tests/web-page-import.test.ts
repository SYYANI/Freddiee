import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, Paper } from '../shared/types'
import { createTranslator } from '../shared/i18n'
import { PaperImporter } from '../electron/main/importer'
import { isWeChatVerificationPage, localizeHTML, needsWeChatArticleRepair } from '../electron/main/localizer'
import { FreddieStore } from '../electron/main/store'

const roots: string[] = []
const pageURL = new URL('https://mp.weixin.qq.com/s/test-article')
const imageURL = 'https://mmbiz.qpic.cn/article/640?wx_fmt=png'
const paragraph = '微信文章的正文应当完整保留，不应只导入公众号信息。'.repeat(20)
const articleHTML = `<html><head><title></title><meta property="og:title" content="微信文章标题"></head>
<body id="activity-detail"><h1 id="activity-name">微信文章标题</h1><div id="img-content">
<div id="js_content" class="rich_media_content" style="visibility: hidden; opacity: 0; text-align: left;">
<h2>第一节</h2><p>${paragraph}</p><p><img data-src="${imageURL}" onerror="alert(1)"></p>
<p hidden>这段隐藏内容不应恢复。</p><p style="display: none">这个隐藏提示也不应恢复。</p>
<h2>最后一节</h2><p>${paragraph}</p></div></div><script>alert(1)</script></body></html>`
const metadataOnlyHTML = `<html><body class="rp-readability-body"><article class="rp-readability-content">
<div id="img-content"><p><span class="rich_media_meta">${'公众号信息和页面按钮。'.repeat(10)}</span></p></div></article></body></html>`
const verificationHTML = `<html><body><div class="weui-msg"><h2>环境异常</h2><p>${'当前环境异常，完成验证后即可继续访问。'.repeat(4)}</p>
<a id="js_verify">去验证</a></div><script src="https://captcha.gtimg.com/TCaptcha.js"></script></body></html>`
const verificationMessage = 'This page requires browser verification. Open it in your browser, complete verification, then save it with the Freddie browser extension.'

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeImporter(language: 'en' | 'zh-Hans' = 'en'): Promise<{ store: FreddieStore; importer: PaperImporter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'freddie-web-import-'))
  roots.push(root)
  const store = new FreddieStore(root)
  await store.initialize()
  return { store, importer: new PaperImporter(store, () => {}, () => createTranslator(language)), root }
}

async function seedHTML(store: FreddieStore, html: string): Promise<{ paper: Paper; attachment: Attachment; file: string }> {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const paper: Paper = {
    id: randomUUID(), title: 'Old Title', abstract: 'Keep abstract', authors: ['Ada'], categories: [],
    tags: ['Keep tag'], isFavorite: true, htmlUrl: pageURL.toString(), createdAt: timestamp, modifiedAt: timestamp
  }
  const attachment: Attachment = { id: randomUUID(), paperId: paper.id, kind: 'html', source: 'webPage', filename: 'paper.html', createdAt: timestamp }
  await store.ensurePaperDirectory(paper.id)
  await store.addPaper(paper, [attachment])
  const file = store.attachmentPath(paper.id, attachment.id)
  await writeFile(file, html)
  return { paper, attachment, file }
}

function mockDownloads(html = articleHTML): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url === pageURL.toString()) return new Response(html, { headers: { 'content-type': 'text/html' } })
    if (url === imageURL) return new Response('article image', { headers: { 'content-type': 'image/png' } })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('WeChat article localization', () => {
  it('reveals only the article root and saves extensionless lazy images offline', async () => {
    const { root } = await makeImporter()
    const page = await localizeHTML(articleHTML, pageURL, {
      directory: root,
      fetchResource: async (url) => {
        expect(url).toBe(imageURL)
        return { data: new TextEncoder().encode('article image'), contentType: 'image/png' }
      }
    })
    const $ = cheerio.load(page.html)
    const text = $('.rp-readability-content').text()
    expect(page.title).toBe('微信文章标题')
    expect(text).toContain('第一节')
    expect(text).toContain('最后一节')
    expect(text).toContain(paragraph)
    expect(text).not.toContain('隐藏')
    expect($('script, [onerror]')).toHaveLength(0)
    expect($('meta[charset]').attr('charset')?.toLowerCase()).toBe('utf-8')
    const image = $('.rp-readability-content img').attr('src')!
    expect(image).toMatch(/^Resources\/.+\.png$/)
    expect(await readFile(join(root, image), 'utf8')).toBe('article image')
    expect(needsWeChatArticleRepair(page.html, pageURL)).toBe(false)
  })

  it('keeps full-page clips and selections in their chosen layout and scopes the repair to WeChat', async () => {
    const { root } = await makeImporter()
    for (const extraction of ['original', 'clip'] as const) {
      const page = await localizeHTML(articleHTML, pageURL, { directory: root, extraction })
      expect(cheerio.load(page.html)('#js_content').attr('style')).toContain('visibility: hidden')
    }
    const page = await localizeHTML(articleHTML, new URL('https://mp.weixin.qq.com.example.com/article'), { directory: root })
    expect(cheerio.load(page.html)('.rp-readability-content').text()).not.toContain(paragraph)
    expect(needsWeChatArticleRepair(metadataOnlyHTML, new URL('https://example.com/article'))).toBe(false)
  })

  it('recognizes verification redirects and DOM markers without mistaking an article for a challenge', () => {
    expect(isWeChatVerificationPage(verificationHTML, pageURL)).toBe(true)
    expect(isWeChatVerificationPage('<p>Verify</p>', new URL('https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=test'))).toBe(true)
    expect(isWeChatVerificationPage(articleHTML, pageURL)).toBe(false)
    expect(isWeChatVerificationPage(verificationHTML, new URL('https://mp.weixin.qq.com.example.com/mp/wappoc_appmsgcaptcha'))).toBe(false)
  })
})

describe('WeChat page import', () => {
  it('imports the article and returns the same healthy entry on a second import', async () => {
    const { store, importer } = await makeImporter()
    const fetch = mockDownloads()
    const paper = await importer.importWebPage(pageURL.toString(), 'first')
    const attachment = store.attachments(paper.id)[0]
    const html = await readFile(store.attachmentPath(paper.id, attachment.id), 'utf8')
    expect(paper.title).toBe('微信文章标题')
    expect(attachment).toMatchObject({ kind: 'html', source: 'webPage', filename: 'paper.html' })
    expect(cheerio.load(html)('.rp-readability-content').text()).toContain(paragraph)
    expect((await importer.importWebPage(pageURL.toString(), 'second')).id).toBe(paper.id)
    expect(store.database.papers).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2) // Article and image, with no second download.
  })

  it.each([metadataOnlyHTML, articleHTML, verificationHTML.replace(/<script[^>]*><\/script>/, '')])(
    'repairs a previous incomplete import without replacing its identity, notes, or folder', async (oldHTML) => {
      const { store, importer } = await makeImporter()
      const { paper, attachment, file } = await seedHTML(store, oldHTML)
      const note = await store.createNote(paper.id, undefined, 'Keep note')
      const folder = await store.createFolder('Keep folder', 'Untitled', paper.id)
      mockDownloads()

      const repaired = await importer.importWebPage(pageURL.toString(), 'repair')

      expect(repaired).toMatchObject({ id: paper.id, title: '微信文章标题', authors: ['Ada'], tags: ['Keep tag'], isFavorite: true, abstract: 'Keep abstract', createdAt: paper.createdAt })
      expect(store.database.papers).toHaveLength(1)
      expect(store.attachments(paper.id).map((item) => item.id)).toEqual([attachment.id])
      expect(store.notes(paper.id)).toEqual([note])
      expect(store.database.memberships).toEqual([expect.objectContaining({ paperId: paper.id, folderId: folder.id })])
      const html = await readFile(file, 'utf8')
      expect(cheerio.load(html)('.rp-readability-content').text()).toContain(paragraph)
      expect(needsWeChatArticleRepair(html, pageURL)).toBe(false)
    }
  )

  it('keeps the existing title when the repaired page has none, and repairs a missing file', async () => {
    const { store, importer } = await makeImporter()
    const { paper, file } = await seedHTML(store, metadataOnlyHTML)
    await rm(file)
    mockDownloads(articleHTML.replace('<title></title><meta property="og:title" content="微信文章标题">', '').replace(/<h1[^>]*>.*?<\/h1>/, ''))

    const repaired = await importer.importWebPage(pageURL.toString(), 'repair')

    expect(repaired).toMatchObject({ id: paper.id, title: 'Old Title' })
    expect(cheerio.load(await readFile(file, 'utf8'))('.rp-readability-content').text()).toContain(paragraph)
  })

  it.each(['en', 'zh-Hans'] as const)('rejects HTTP 200 verification pages with a localized explanation (%s)', async (language) => {
    const { store, importer, root } = await makeImporter(language)
    mockDownloads(verificationHTML)
    await expect(importer.importWebPage(pageURL.toString(), 'blocked')).rejects.toThrow(createTranslator(language)(verificationMessage))
    expect(store.database.papers).toHaveLength(0)
    expect(store.database.attachments).toHaveLength(0)
    expect(await readdir(join(root, 'Library')).catch(() => [])).toEqual([])
  })

  it('keeps the old file and notes when a repair receives a verification page', async () => {
    const { store, importer } = await makeImporter()
    const { paper, attachment, file } = await seedHTML(store, metadataOnlyHTML)
    const note = await store.createNote(paper.id, undefined, 'Keep note')
    mockDownloads(verificationHTML)
    await expect(importer.importWebPage(pageURL.toString(), 'repair')).rejects.toThrow(verificationMessage)
    expect(await readFile(file, 'utf8')).toBe(metadataOnlyHTML)
    expect(store.attachments(paper.id).map((item) => item.id)).toEqual([attachment.id])
    expect(store.notes(paper.id)).toEqual([note])
  })

  it('keeps the old file when a repair is cancelled during image localization', async () => {
    const { store, importer } = await makeImporter()
    const { file } = await seedHTML(store, metadataOnlyHTML)
    vi.stubGlobal('fetch', vi.fn(async (input: string): Promise<Response> => {
      if (input === pageURL.toString()) return new Response(articleHTML, { headers: { 'content-type': 'text/html' } })
      importer.cancel('repair')
      throw new DOMException('Cancelled', 'AbortError')
    }))
    await expect(importer.importWebPage(pageURL.toString(), 'repair')).rejects.toThrow('Import cancelled')
    expect(await readFile(file, 'utf8')).toBe(metadataOnlyHTML)
  })
})
