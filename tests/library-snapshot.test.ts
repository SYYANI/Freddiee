import { describe, expect, it, vi } from 'vitest'
import { LibrarySnapshotCache } from '../electron/main/librarySnapshot'
import { defaultSettings } from '../electron/main/store'
import { SnapshotLoader } from '../src/app/snapshotLoader'
import type { LibrarySnapshot, Paper } from '../shared/types'

function fixture(): LibrarySnapshot {
  return {
    papers: [], notes: [], attachments: [], folders: [], memberships: [], itemTypeAssignments: [], readingStates: [],
    providers: [], models: [], writings: [], htmlTranslatedPaperIds: [], settings: defaultSettings(), platform: 'darwin', systemDarkMode: false
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('library snapshot delivery', () => {
  it('rechecks external files on a later read even without a library notification', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      const state = fixture()
      const cache = new LibrarySnapshotCache(async () => structuredClone(state), () => 'unchanged-library')
      const first = await cache.read()
      state.writingError = 'Externally changed writing'
      clock.mockReturnValue(1001)
      const update = await cache.read(first.revision)
      expect(update.changes.writingError).toBe('Externally changed writing')
    } finally {
      clock.mockRestore()
    }
  })

  it('shares loads across windows and transfers only changed sections', async () => {
    const state = fixture()
    let version = 0
    const load = vi.fn(async () => structuredClone(state))
    const cache = new LibrarySnapshotCache(load, () => String(version))
    const [first, other] = await Promise.all([cache.read(), cache.read()])
    expect(load).toHaveBeenCalledTimes(1)
    expect(first).toEqual(other)
    expect(first.full).toBe(true)

    state.settings.inspectorCollapsed = !state.settings.inspectorCollapsed
    version++
    const [update] = await Promise.all([cache.read(first.revision), cache.read(other.revision)])
    expect(load).toHaveBeenCalledTimes(2)
    expect(update.full).toBe(false)
    expect(Object.keys(update.changes)).toEqual(['settings'])
    expect((await cache.read(update.revision)).changes).toEqual({})
  })

  it('discards a read invalidated by a concurrent save or sync', async () => {
    const state = fixture()
    const gate = deferred<void>()
    let version = 0
    const load = vi.fn(async () => {
      const snapshot = structuredClone(state)
      if (version === 0) await gate.promise
      return snapshot
    })
    const cache = new LibrarySnapshotCache(load, () => String(version))
    const pending = cache.read()
    state.settings.htmlFontSize = 22
    version++
    gate.resolve()
    expect((await pending).changes.settings?.htmlFontSize).toBe(22)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('returns after a bounded number of loads while saves keep landing', async () => {
    const state = fixture()
    let version = 0
    const load = vi.fn(async () => {
      const snapshot = structuredClone(state)
      // Every load is overtaken by another save, as during a long sync or import on a slow machine.
      state.settings.htmlFontSize++
      version++
      return snapshot
    })
    const cache = new LibrarySnapshotCache(load, () => String(version))
    const update = await cache.read()
    expect(load).toHaveBeenCalledTimes(2)
    expect(update.full).toBe(true)
    expect(update.changes.settings?.htmlFontSize).toBe(defaultSettings().htmlFontSize + 1)
  })

  it('recovers old revisions with a full snapshot and clears optional fields', async () => {
    const state = fixture()
    state.writingError = 'Disk unavailable'
    let version = 0
    const cache = new LibrarySnapshotCache(async () => structuredClone(state), () => String(version))
    const first = await cache.read()
    delete state.writingError
    version++
    const cleared = await cache.read(first.revision)
    expect(cleared.changes).toHaveProperty('writingError', undefined)
    for (let i = 0; i < 5; i++) {
      state.settings.htmlFontSize++
      version++
      await cache.read()
    }
    expect((await cache.read(first.revision)).full).toBe(true)
  })

  it('preserves unchanged records through IPC copies, edits, and sorting', async () => {
    const state = fixture()
    state.papers = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] as Paper[]
    let version = 0
    const cache = new LibrarySnapshotCache(async () => structuredClone(state), () => String(version))
    const publish = vi.fn()
    const loader = new SnapshotLoader(async (since) => structuredClone(await cache.read(since)), publish)
    await loader.reload()
    const original = publish.mock.lastCall![0] as LibrarySnapshot
    state.settings.htmlFontSize++
    version++
    await loader.reload()
    const settingsEdit = publish.mock.lastCall![0] as LibrarySnapshot
    expect(settingsEdit.papers).toBe(original.papers)
    expect(settingsEdit.notes).toBe(original.notes)
    expect(settingsEdit.settings).not.toBe(original.settings)

    state.papers = [{ ...state.papers[1], title: 'Edited B' }, state.papers[0]]
    version++
    await loader.reload()
    const reordered = publish.mock.lastCall![0] as LibrarySnapshot
    expect(reordered.papers[1]).toBe(original.papers[0])
    expect(reordered.papers[0].title).toBe('Edited B')
    await loader.reload()
    expect(publish).toHaveBeenCalledTimes(3)
  })

  it('serializes refreshes and follows an in-flight change with one trailing request', async () => {
    const state = fixture()
    const gate = deferred<void>()
    const read = vi.fn(async (since?: number) => {
      if (since === undefined) {
        await gate.promise
        return { revision: 1, full: true as const, changes: state }
      }
      return { revision: 2, full: false as const, changes: { settings: { ...state.settings, htmlFontSize: 24 } } }
    })
    const publish = vi.fn()
    const loader = new SnapshotLoader(read, publish)
    const first = loader.reload()
    const second = loader.reload()
    loader.reload()
    expect(read).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([first, second])
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.lastCall).toEqual([1])
    expect(publish.mock.lastCall![0].settings.htmlFontSize).toBe(24)
  })

  it('can retry after a failed request', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue({ revision: 1, full: true, changes: fixture() })
    const publish = vi.fn()
    const loader = new SnapshotLoader(read, publish)
    await expect(loader.reload()).rejects.toThrow('Read failed')
    await loader.reload()
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
