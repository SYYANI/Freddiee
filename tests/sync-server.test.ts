import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTranslator } from '../shared/i18n'
import type { SyncStatus } from '../shared/sync'
import { FreddieStore } from '../electron/main/store'
import { WritingStore } from '../electron/main/writings'
import { SyncClient } from '../electron/main/sync/client'
import { SyncController } from '../electron/main/sync/controller'

// Runs this app's HTTP client against a real Freddie Sync Server. Build the server from
// ../freddie-sync-server (`go build -o /tmp/freddie-sync .`) and set
// FREDDIE_SYNC_SERVER_BINARY to run it; it listens on loopback HTTP, so requests to the
// credential's HTTPS address are routed there.
const binary = process.env.FREDDIE_SYNC_SERVER_BINARY
const run = promisify(execFile)

describe.skipIf(!binary)('library sync with the Freddie Sync Server', () => {
  let server: ChildProcess
  let root: string
  let socket: string
  const port = 20000 + Math.floor(Math.random() * 20000)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'freddie-sync-server-'))
    socket = join(root, 'admin.sock')
    server = spawn(binary!, ['serve', '--data', join(root, 'data'), '--listen', `127.0.0.1:${port}`, '--host', 'sync.example.com', '--socket', socket], { stdio: 'ignore' })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('The sync server did not start')
  })

  afterAll(async () => {
    server?.kill()
    await rm(root, { recursive: true, force: true })
  })

  const local: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    return fetch(`http://127.0.0.1:${port}${url.pathname.replace(/^\/freddie-sync/, '')}${url.search}`, init)
  }

  async function device(): Promise<{ store: FreddieStore; writings: WritingStore; controller: SyncController; status: () => SyncStatus }> {
    const { stdout } = await run(binary!, ['device-add', '--label', `Device ${randomUUID().slice(0, 4)}`, '--socket', socket])
    const credential = JSON.parse(stdout) as { baseURL: string }
    expect(credential.baseURL).toBe('https://sync.example.com/freddie-sync/')
    const directory = await mkdtemp(join(root, 'device-'))
    const store = new FreddieStore(directory)
    await store.initialize()
    const writings = new WritingStore(store.writingsRoot)
    const tokens = new Map<string, string>()
    let status: SyncStatus | undefined
    const controller = new SyncController({
      root: directory,
      store,
      writings,
      tokens: { setSyncToken: async (key, token) => void tokens.set(key, token), syncToken: async (key) => tokens.get(key) },
      translator: () => createTranslator('en'),
      busyPapers: () => new Set(),
      busyWritings: () => new Set(),
      openPapers: () => new Set(),
      editingNotes: () => new Set(),
      onStatus: (value) => {
        status = value
      },
      onApplied: () => {},
      makeTransport: (baseURL, token) => new SyncClient(baseURL, token, local)
    })
    await controller.initialize()
    expect(await controller.connect(stdout)).toBe(true)
    return { store, writings, controller, status: () => status! }
  }

  it('round-trips a library through the server', async () => {
    const a = await device()
    const b = await device()
    const paperId = randomUUID()
    const now = new Date().toISOString()
    const directory = await a.store.ensurePaperDirectory(paperId)
    const pdf = Buffer.alloc(3 * 1024 * 1024, 7)
    await writeFile(join(directory, 'paper.pdf'), pdf)
    await a.store.addPaper({ id: paperId, title: 'Over the wire', abstract: '', authors: ['A', 'B'], categories: [], tags: [], isFavorite: false, createdAt: now, modifiedAt: now },
      [{ id: randomUUID(), paperId, kind: 'pdf', source: 'localImport', filename: 'paper.pdf', createdAt: now }])
    await a.store.createNote(paperId, undefined, '中文旁注')
    const writing = await a.writings.create('# Remote draft')

    await a.controller.syncNow()
    expect(a.status().errorMessage).toBeUndefined()
    await b.controller.syncNow()
    expect(b.status().errorMessage).toBeUndefined()
    expect(b.store.database.papers[0]?.title).toBe('Over the wire')
    expect(b.store.database.notes[0]?.body).toBe('中文旁注')
    expect(await readFile(join(b.store.paperDirectory(paperId), 'paper.pdf'))).toEqual(pdf)
    expect(await b.writings.loadMarkdown(writing.id)).toBe('# Remote draft')

    // A conflicting edit is rejected by the server and merged on the next pass.
    await a.store.updatePaper(paperId, { title: 'Renamed on A' }, false)
    await b.store.updatePaper(paperId, { isFavorite: true }, false)
    await a.controller.syncNow()
    await b.controller.syncNow()
    expect(b.status().errorMessage).toBeUndefined()
    expect(b.store.database.papers[0]).toEqual(expect.objectContaining({ title: 'Renamed on A', isFavorite: true }))
    await a.controller.syncNow()
    expect(a.store.database.papers[0].isFavorite).toBe(true)
    expect(a.status().statusKey).toBe('Up to date')
    expect(b.status().pendingCount).toBe(0)
  })
})
