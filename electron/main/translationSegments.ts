import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMAPIStyle, LLMReasoningEffort, LLMThinkingMode } from '../../shared/types'
import { atomicWriteFile } from './files'
import type { FreddieStore } from './store'
import { formatSwiftDouble } from './sync/swiftJSON'
import { promptVersion } from './translation'

/**
 * Native Freddie's `TranslationSegment`, one list per paper. Field names, values and the
 * cache identity are native Freddie's, so a cache written by either app hits in both and
 * syncs as it is: UUIDs are uppercase and dates are milliseconds since 1970.
 */
export interface TranslationSegment {
  id: string
  /** `html`, `abstract` or `pdf-summary`. */
  sourceType: string
  targetLanguage: string
  sourceHash: string
  sourceText: string
  translatedText: string
  /** Native Freddie's route cache identity, not only the model name. */
  modelName: string
  createdAt: number
  modifiedAt: number
  providerProfileID?: string
  modelProfileID?: string
}

export interface CacheRoute {
  providerId: string
  modelId: string
  modelName: string
  apiStyle: LLMAPIStyle
  temperature?: number
  topP?: number
  maxTokens?: number
  thinkingMode?: LLMThinkingMode
  reasoningEffort?: LLMReasoningEffort
}

/** Swift's `String(describing: Double)`: like its JSON form, but whole numbers keep `.0`. */
function swiftDescription(value: number): string {
  return Number.isInteger(value) && Math.abs(value) < 1e16 ? `${formatSwiftDouble(value)}.0` : formatSwiftDouble(value)
}

/** Native `LLMModelRouteSnapshot.translationCacheIdentity`, plus the glossary like `TranslationPreferencesSnapshot`. */
export function translationCacheIdentity(route: CacheRoute, glossary = ''): string {
  const base = [
    `model=${route.modelName}`,
    `api=${route.apiStyle}`,
    `temperature=${route.temperature === undefined ? 'default' : swiftDescription(route.temperature)}`,
    `topP=${route.topP === undefined ? 'default' : swiftDescription(route.topP)}`,
    `maxTokens=${route.maxTokens === undefined ? 'default' : String(Math.trunc(route.maxTokens))}`,
    `thinking=${route.thinkingMode ?? 'default'}`,
    `reasoning=${route.reasoningEffort ?? 'default'}`,
    `prompt=${promptVersion}`
  ].join('|')
  return glossary ? `${base}|glossary=${createHash('sha256').update(glossary).digest('hex')}` : base
}

const sameUUID = (a: string | undefined, b: string | undefined): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

export function matchesRoute(segment: TranslationSegment, sourceType: string, targetLanguage: string, route: CacheRoute, identity: string): boolean {
  return segment.sourceType === sourceType && segment.targetLanguage === targetLanguage && segment.modelName === identity &&
    sameUUID(segment.providerProfileID, route.providerId) && sameUUID(segment.modelProfileID, route.modelId)
}

export function newSegment(fields: Omit<TranslationSegment, 'id' | 'createdAt' | 'modifiedAt' | 'providerProfileID' | 'modelProfileID'>, route: CacheRoute): TranslationSegment {
  const now = Date.now()
  return { id: randomUUID().toUpperCase(), ...fields, createdAt: now, modifiedAt: now, providerProfileID: route.providerId.toUpperCase(), modelProfileID: route.modelId.toUpperCase() }
}

/** The identity native Freddie deduplicates a paper's cache by. */
export function segmentCacheKey(segment: TranslationSegment): string {
  return [segment.sourceType, segment.targetLanguage, segment.sourceHash, (segment.providerProfileID ?? '').toLowerCase(), (segment.modelProfileID ?? '').toLowerCase(), segment.modelName].join('|')
}

/** Updates of one file, shared by every service that writes the cache. */
const queues = new Map<string, Promise<unknown>>()

/** Per-paper cache files with serialized updates. */
export class TranslationSegmentStore {
  constructor(private readonly store: FreddieStore) {}

  path(paperId: string): string {
    return join(this.store.paperDirectory(paperId), 'translations', 'segments.json')
  }

  async read(paperId: string): Promise<TranslationSegment[]> {
    try {
      const value = JSON.parse(await readFile(this.path(paperId), 'utf8')) as { segments?: unknown }
      return Array.isArray(value.segments) ? value.segments.filter(isSegment) : []
    } catch {
      return []
    }
  }

  /** Replaces the list with `change(current)`; a newer segment wins for the same cache key. */
  update(paperId: string, change: (segments: TranslationSegment[]) => TranslationSegment[]): Promise<void> {
    const path = this.path(paperId)
    const next = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // A result arriving after deletion must not recreate the paper's folder.
      if (!this.store.database.papers.some((paper) => paper.id === paperId)) return
      await this.write(paperId, change(await this.read(paperId)))
    })
    queues.set(path, next)
    return next.finally(() => {
      if (queues.get(path) === next) queues.delete(path)
    })
  }

  async write(paperId: string, segments: TranslationSegment[]): Promise<void> {
    const byKey = new Map<string, TranslationSegment>()
    for (const segment of segments) {
      const key = segmentCacheKey(segment)
      const existing = byKey.get(key)
      if (!existing || segment.modifiedAt >= existing.modifiedAt) byKey.set(key, segment)
    }
    await atomicWriteFile(this.path(paperId), `${JSON.stringify({ segments: [...byKey.values()] })}\n`)
  }
}

function isSegment(value: unknown): value is TranslationSegment {
  const segment = value as TranslationSegment
  return Boolean(segment) && typeof segment === 'object' && typeof segment.id === 'string' && typeof segment.sourceType === 'string' &&
    typeof segment.targetLanguage === 'string' && typeof segment.sourceHash === 'string' && typeof segment.sourceText === 'string' &&
    typeof segment.translatedText === 'string' && typeof segment.modelName === 'string' &&
    Number.isSafeInteger(segment.createdAt) && Number.isSafeInteger(segment.modifiedAt)
}
