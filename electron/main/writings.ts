import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { WritingMetadata } from '../../shared/types'
import { citationRecords, citedPaperIds, deriveWritingTitle, wordCount } from '../../shared/writing'
import { atomicWriteFile } from './files'

const markdownFilename = 'writing.md'
const metadataFilename = 'meta.json'
/** A save writes the Markdown just before the metadata. */
const stalenessToleranceMs = 2000

/**
 * Writings are Markdown files under `Writings/<id>/` rather than rows in library.json, so
 * a writing survives any library schema change; `meta.json` only caches what lists need.
 */
export class WritingStore {
  constructor(readonly root: string) {}

  directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid writing identifier')
    return join(this.root, id)
  }

  markdownPath(id: string): string {
    return join(this.directory(id), markdownFilename)
  }

  /** Resolves a path inside a writing's folder, such as an inserted image. */
  resolve(id: string, relativePath: string): string {
    const directory = resolve(this.directory(id))
    const candidate = resolve(directory, relativePath)
    if (!candidate.startsWith(`${directory}${sep}`)) throw new Error('Invalid writing path')
    return candidate
  }

  async loadAll(): Promise<WritingMetadata[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const writings: WritingMetadata[] = []
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}$/i.test(entry)) continue
      const metadata = await this.loadMetadata(entry).catch(() => undefined)
      if (metadata) writings.push(metadata)
    }
    return writings.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  }

  private async loadMetadata(id: string): Promise<WritingMetadata | undefined> {
    const markdownPath = this.markdownPath(id)
    let markdownStat
    try {
      markdownStat = await stat(markdownPath)
    } catch {
      return undefined
    }
    try {
      const metadataPath = join(this.directory(id), metadataFilename)
      const metadataStat = await stat(metadataPath)
      if (markdownStat.mtimeMs - metadataStat.mtimeMs <= stalenessToleranceMs) {
        const cached = JSON.parse(await readFile(metadataPath, 'utf8')) as WritingMetadata
        if (cached.id === id && Array.isArray(cached.citations)) return cached
      }
    } catch {
      // Rebuild below.
    }
    const markdown = await readFile(markdownPath, 'utf8')
    const metadata = makeMetadata(id, markdown, markdownStat.birthtime.toISOString(), markdownStat.mtime.toISOString())
    await atomicWriteFile(join(this.directory(id), metadataFilename), `${JSON.stringify(metadata, null, 2)}\n`)
    return metadata
  }

  async create(markdown = ''): Promise<WritingMetadata> {
    const id = randomUUID()
    return this.save(id, markdown, new Date().toISOString())
  }

  async loadMarkdown(id: string): Promise<string> {
    return readFile(this.markdownPath(id), 'utf8')
  }

  async save(id: string, markdown: string, createdAt: string, modifiedAt = new Date()): Promise<WritingMetadata> {
    const directory = this.directory(id)
    await mkdir(directory, { recursive: true })
    await atomicWriteFile(join(directory, markdownFilename), markdown)
    const metadata = makeMetadata(id, markdown, createdAt, modifiedAt.toISOString())
    await atomicWriteFile(join(directory, metadataFilename), `${JSON.stringify(metadata, null, 2)}\n`)
    return metadata
  }

  async delete(id: string, moveToTrash: (path: string) => Promise<void>): Promise<void> {
    const directory = this.directory(id)
    try {
      await moveToTrash(directory)
    } catch {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Copies an image into the writing's folder and returns the relative path to link it with. */
  async importImage(id: string, source: string): Promise<string> {
    const imagesDirectory = join(this.directory(id), 'images')
    await mkdir(imagesDirectory, { recursive: true })
    const extension = extname(source).toLowerCase() || '.png'
    const base = basename(source, extname(source)).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'image'
    let name = `${base}${extension}`
    let index = 2
    for (;;) {
      try {
        await stat(join(imagesDirectory, name))
        name = `${base}-${index}${extension}`
        index += 1
      } catch {
        break
      }
    }
    await copyFile(source, join(imagesDirectory, name))
    return `images/${name}`
  }
}

export function makeMetadata(id: string, markdown: string, createdAt: string, modifiedAt: string): WritingMetadata {
  return {
    id,
    title: deriveWritingTitle(markdown),
    createdAt,
    modifiedAt,
    citedPaperIds: citedPaperIds(markdown),
    wordCount: wordCount(markdown),
    citations: citationRecords(markdown)
  }
}
