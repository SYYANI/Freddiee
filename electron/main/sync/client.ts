import { createWriteStream, openAsBlob } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { envelopeToWire, parseRecord, SyncError, validateHash, type SyncInfo, type SyncMutation, type SyncRecord } from './types'

export interface SyncPage {
  changes: SyncRecord[]
  cursor: number
  headRevision: number
  hasMore: boolean
}

export interface SyncPush {
  requestID: string
  mutations: SyncMutation[]
}

export interface SyncReceipt {
  requestID: string
  revisions: number[]
}

export interface SyncTransport {
  info(): Promise<SyncInfo>
  changes(after: number, until?: number): Promise<SyncPage>
  push(request: SyncPush): Promise<SyncReceipt>
  hasBlob(hash: string): Promise<boolean>
  upload(path: string, hash: string): Promise<void>
  /** Downloads into `directory` and returns the temporary file. */
  download(hash: string, directory: string): Promise<string>
}

/** HTTPS only, without credentials, query or fragment; always ends with a slash. */
export function validatedBaseURL(value: unknown): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new SyncError('Enter an HTTPS server URL without credentials, query, or fragment.')
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || String(value).includes('?') || String(value).includes('#')) {
    throw new SyncError('Enter an HTTPS server URL without credentials, query, or fragment.')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class SyncClient implements SyncTransport {
  private readonly baseURL: string

  constructor(baseURL: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.baseURL = validatedBaseURL(baseURL)
    if (!/^fs1_[0-9a-f]{64}$/.test(token)) throw new SyncError('The device credential is not valid.')
  }

  async info(): Promise<SyncInfo> {
    const value = await this.json('v1/info') as Record<string, unknown>
    if (!integer(value.protocolVersion) || typeof value.storeID !== 'string' || typeof value.libraryID !== 'string' || typeof value.deviceID !== 'string') {
      throw new SyncError('The sync server response is not valid.')
    }
    return { protocolVersion: value.protocolVersion, storeID: value.storeID, libraryID: value.libraryID, deviceID: value.deviceID }
  }

  async changes(after: number, until?: number): Promise<SyncPage> {
    const query = new URLSearchParams({ after: String(after), limit: '100', ...(until !== undefined ? { until: String(until) } : {}) })
    const value = await this.json(`v1/changes?${query}`) as Record<string, unknown>
    if (!Array.isArray(value.changes) || !integer(value.cursor) || !integer(value.headRevision) || typeof value.hasMore !== 'boolean') {
      throw new SyncError('The sync server response is not valid.')
    }
    return { changes: value.changes.map(parseRecord), cursor: value.cursor, headRevision: value.headRevision, hasMore: value.hasMore }
  }

  async push(request: SyncPush): Promise<SyncReceipt> {
    const body = JSON.stringify({
      requestID: request.requestID,
      mutations: request.mutations.map((mutation) => ({
        kind: mutation.kind,
        id: mutation.id,
        baseRevision: mutation.baseRevision,
        deleted: mutation.deleted,
        restore: mutation.restore,
        ...(mutation.payload ? { payload: envelopeToWire(mutation.payload) } : {}),
        blobs: mutation.blobs
      }))
    })
    const value = await this.json('v1/changes', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }) as Record<string, unknown>
    if (typeof value.requestID !== 'string' || !Array.isArray(value.revisions) || !value.revisions.every(integer)) {
      throw new SyncError('The sync server response is not valid.')
    }
    return { requestID: value.requestID, revisions: value.revisions as number[] }
  }

  async hasBlob(hash: string): Promise<boolean> {
    validateHash(hash)
    return this.retry(async () => {
      const response = await this.request(`v1/blobs/${hash}`, { method: 'HEAD' })
      if (response.status === 404) return false
      await this.check(response)
      return true
    })
  }

  async upload(path: string, hash: string): Promise<void> {
    validateHash(hash)
    const size = (await stat(path)).size
    await this.retry(async () => {
      const response = await this.request(`v1/blobs/${hash}`, {
        method: 'PUT',
        body: await openAsBlob(path),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }
      }, 900_000)
      await this.check(response)
    })
  }

  async download(hash: string, directory: string): Promise<string> {
    validateHash(hash)
    return this.retry(async () => {
      const response = await this.request(`v1/blobs/${hash}`, {}, 900_000)
      await this.check(response)
      if (!response.body) throw new SyncError('The sync server response is not valid.')
      const file = join(directory, `.download-${randomUUID()}`)
      try {
        await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(file, { mode: 0o600 }))
        return file
      } catch (error) {
        await rm(file, { force: true })
        throw error
      }
    })
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.retry(async () => {
      const response = await this.request(path, init)
      await this.check(response)
      const text = await response.text()
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new SyncError('The sync server response is too large.')
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new SyncError('The sync server response is not valid.')
      }
    })
  }

  private request(path: string, init: RequestInit, timeout = 90_000): Promise<Response> {
    // Authorization never follows a redirect, not even to another HTTPS host.
    return this.fetcher(new URL(path, this.baseURL), {
      ...init,
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeout),
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.token}`, Accept: 'application/json' }
    })
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        let wait: number
        const status = error instanceof SyncError ? error.detail?.status : undefined
        if (status === 429 || status === 503) wait = (error as SyncError).detail?.retryAfter ?? 2 ** attempt
        else if (!(error instanceof SyncError) && attempt < 2) wait = 2 ** attempt // Dropped connections and timeouts.
        else throw error
        if (attempt >= 5 || wait > 30) throw error
        await delay((Math.max(0.2, wait) + Math.random() * 0.3) * 1000)
      }
    }
  }

  private async check(response: Response): Promise<void> {
    if (response.status >= 200 && response.status < 300) return
    let details: { code?: unknown; current?: unknown } | undefined
    try {
      details = (await response.json() as { error?: { code?: unknown; current?: unknown } }).error
    } catch {
      details = undefined
    }
    const code = typeof details?.code === 'string' ? details.code : 'http_error'
    if (response.status === 409 && code === 'revision_conflict') {
      let current: SyncRecord | null = null
      try {
        current = details?.current ? parseRecord(details.current) : null
      } catch {
        current = null
      }
      throw new SyncError('Some changes need conflict resolution.', { status: 409, code, current })
    }
    const header = Number(response.headers.get('Retry-After'))
    const retryAfter = Number.isFinite(header) && response.headers.has('Retry-After') ? header : undefined
    const message = response.status === 401 ? 'This device credential is invalid or has been revoked. Import a new credential.'
      : response.status === 429 || response.status === 503 ? 'The sync server is busy. Freddie will retry shortly.'
        : response.status === 507 ? 'The sync server has reached its storage limit.'
          : 'Sync server returned HTTP %d.'
    throw new SyncError(message, { status: response.status, code, retryAfter, args: [response.status] })
  }
}
