import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { WritingStore } from '../electron/main/writings'
import { atomicWriteFile } from '../electron/main/files'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'freddie-writings-cache-'))
  roots.push(root)
  const store = new WritingStore(root)
  const metadata = await store.create('# Original\n\nText')
  return { store, metadata }
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('writing metadata cache', () => {
  it('reuses metadata but detects saves, sync replacements, and external deletion', async () => {
    const { store, metadata } = await fixture()
    const [first] = await store.loadAll()
    expect((await store.loadAll())[0]).toBe(first)
    await store.save(metadata.id, '# Saved', metadata.createdAt)
    expect((await store.loadAll())[0].title).toBe('Saved')

    const path = join(store.directory(metadata.id), 'meta.json')
    const synced = JSON.parse(await readFile(path, 'utf8'))
    synced.title = 'Synced'
    await atomicWriteFile(path, JSON.stringify(synced))
    expect((await store.loadAll())[0].title).toBe('Synced')
    await rm(store.directory(metadata.id), { recursive: true })
    expect(await store.loadAll()).toEqual([])
  })

  it('rebuilds metadata when Markdown was edited outside the app', async () => {
    const { store, metadata } = await fixture()
    await store.loadAll()
    await writeFile(store.markdownPath(metadata.id), '# External edit\n\nMore text')
    const future = new Date(Date.now() + 5000)
    await utimes(store.markdownPath(metadata.id), future, future)
    const [changed] = await store.loadAll()
    expect(changed.title).toBe('External edit')
    expect(changed.wordCount).toBeGreaterThan(0)
  })
})
