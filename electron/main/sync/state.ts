import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../files'
import { entriesEqual, recordKey, sha256, SyncError, type Scope, type SyncConfiguration, type SyncEntry, type SyncInfo, type SyncMutation, type SyncRecord } from './types'

export interface KnownRecord {
  revision: number
  /** Undefined when the record is deleted on the server. */
  entry?: SyncEntry
  scope: Scope
}

export interface PendingPush {
  request: { requestID: string; mutations: SyncMutation[] }
  entries: Record<string, SyncEntry>
  deviceID: string
}

export interface SyncConflict {
  id: string
  title: string
  local?: SyncEntry
  remote: SyncRecord
}

/** Per server and library; the counterpart of native `LibrarySyncState`. */
export interface SyncState {
  version: 1
  info?: SyncInfo
  cursor: number
  known: Record<string, KnownRecord>
  incoming: Record<string, SyncRecord>
  outbox: SyncMutation[]
  inFlight?: PendingPush
  conflicts: Record<string, SyncConflict>
  explicitRestores: string[]
  lastSuccess?: string
}

export const emptyState = (): SyncState => ({ version: 1, cursor: 0, known: {}, incoming: {}, outbox: [], conflicts: {}, explicitRestores: [] })

export function acceptRecord(state: SyncState, record: SyncRecord, entry: SyncEntry | undefined, scope: Scope): void {
  const key = recordKey(record)
  state.known[key] = { revision: record.revision, ...(entry ? { entry } : {}), scope }
  delete state.incoming[key]
  delete state.conflicts[key]
  state.explicitRestores = state.explicitRestores.filter((item) => item !== key)
}

export function priority(kind: string, deleted: boolean): number {
  if (deleted) return kind === 'paper' || kind === 'writing' ? 30 : 20
  switch (kind) {
    case 'paper':
    case 'folder':
      return 0
    case 'htmlState':
      return 1
    case 'attachment':
    case 'writing':
      return 2
    default:
      return 3
  }
}

const byPriority = <T extends { kind: string; id: string; deleted: boolean }>(a: T, b: T): number => {
  const difference = priority(a.kind, a.deleted) - priority(b.kind, b.deleted)
  if (difference) return difference
  const left = recordKey(a)
  const right = recordKey(b)
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Captures the current intent before a request is sent. Deletion is only inferred for
 * records this installation previously applied or uploaded.
 */
export function stage(state: SyncState, entries: Map<string, SyncEntry>, protectedKeys: Set<string>): void {
  const mutations: SyncMutation[] = []
  for (const [key, entry] of entries) {
    if (protectedKeys.has(key) || state.conflicts[key]) continue
    const previous = state.known[key]
    if (previous && entriesEqual(previous.entry, entry)) continue
    if (previous && !previous.entry && !state.explicitRestores.includes(key)) continue
    mutations.push({
      kind: entry.kind,
      id: entry.id,
      baseRevision: previous?.revision ?? 0,
      deleted: false,
      restore: Boolean(previous && !previous.entry),
      payload: entry.payload,
      blobs: entry.blobs
    })
  }
  for (const [key, previous] of Object.entries(state.known)) {
    if (!previous.entry || entries.has(key) || protectedKeys.has(key) || state.conflicts[key]) continue
    mutations.push({ kind: previous.entry.kind, id: previous.entry.id, baseRevision: previous.revision, deleted: true, restore: false, blobs: [] })
  }
  // Dependencies first; paper and writing deletions follow their children.
  state.outbox = mutations.sort(byPriority)
}

export function sortIncoming(records: SyncRecord[]): SyncRecord[] {
  const paperDeletion = (record: SyncRecord): boolean => record.kind === 'paper' && record.deleted
  return [...records].sort((a, b) => (paperDeletion(a) !== paperDeletion(b) ? (paperDeletion(a) ? -1 : 1) : byPriority(a, b)))
}

export class SyncStateStore {
  constructor(readonly root: string) {}

  private get configurationPath(): string {
    return join(this.root, 'Sync', 'configuration.json')
  }

  statePath(configuration: SyncConfiguration): string {
    return join(this.root, 'Sync', `State-${sha256(`${configuration.baseURL}|${configuration.libraryID}`)}.json`)
  }

  async loadConfiguration(): Promise<SyncConfiguration | undefined> {
    try {
      return JSON.parse(await readFile(this.configurationPath, 'utf8')) as SyncConfiguration
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async saveConfiguration(configuration: SyncConfiguration): Promise<void> {
    await atomicWriteFile(this.configurationPath, JSON.stringify(configuration, null, 2), 0o600)
  }

  async load(configuration: SyncConfiguration): Promise<SyncState> {
    let decoded: SyncState
    try {
      decoded = JSON.parse(await readFile(this.statePath(configuration), 'utf8')) as SyncState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
    if (decoded.version !== 1) throw new SyncError('This sync state was created by a newer version of Freddie.')
    return decoded
  }

  async save(state: SyncState, configuration: SyncConfiguration): Promise<void> {
    await atomicWriteFile(this.statePath(configuration), JSON.stringify(state), 0o600)
  }

  async archive(state: SyncState, name: string): Promise<void> {
    await atomicWriteFile(join(this.root, 'Sync', 'Recovery', name), JSON.stringify(state), 0o600)
  }
}

/**
 * One syncing process per library. Electron has no portable `flock`, so the lock file
 * records its owner's PID and a stale lock from a crashed process is taken over.
 */
export class SyncLease {
  private constructor(private readonly path: string) {}

  static async acquire(root: string): Promise<SyncLease> {
    const path = join(root, 'Sync', 'session.lock')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600)
        await handle.writeFile(String(process.pid))
        await handle.close()
        return new SyncLease(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = Number((await readFile(path, 'utf8').catch(() => '')).trim())
        if (owner && owner !== process.pid && isRunning(owner)) break
        await rm(path, { force: true })
      }
    }
    throw new SyncError('Another Freddie process is already syncing this library.')
  }

  async release(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
