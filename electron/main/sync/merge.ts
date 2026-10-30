import { encodeSwiftJSON, SwiftDouble, type SwiftJSONValue } from './swiftJSON'
import { translationCacheKey, type DocumentValue, type SyncDocument } from './types'

/**
 * Merges a local and a remote change of the same record, as native `LibrarySyncMerge`
 * does. Undefined means the two versions conflict and the user decides.
 */
export function mergeDocuments(base: SyncDocument | undefined, local: SyncDocument, remote: SyncDocument): SyncDocument | undefined {
  if (local.tag !== remote.tag) return undefined
  if (local.tag === 'reading') {
    const a = Number(local.value.modifiedAt)
    const b = Number(remote.value.modifiedAt)
    if (a !== b) return a > b ? local : remote
    // Equal times: both apps pick the version whose encoding sorts last.
    return readingBytes(local.value) < readingBytes(remote.value) ? remote : local
  }
  if (local.tag === 'translations') {
    if (String(local.value.paperID).toLowerCase() !== String(remote.value.paperID).toLowerCase()) return undefined
    // The union by cache identity; the newer segment wins, ties go to the encoding that sorts last.
    const merged = new Map((remote.value.segments as DocumentValue[]).map((segment) => [translationCacheKey(segment), segment]))
    for (const segment of local.value.segments as DocumentValue[]) {
      const key = translationCacheKey(segment)
      const other = merged.get(key)
      const a = Number(segment.modifiedAt)
      const b = Number(other?.modifiedAt)
      if (!other || a > b || (a === b && encodeSwiftJSON(other as Record<string, SwiftJSONValue>) < encodeSwiftJSON(segment as Record<string, SwiftJSONValue>))) merged.set(key, segment)
    }
    const segments = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, segment]) => segment)
    return { tag: 'translations', value: { paperID: local.value.paperID, segments } }
  }
  if ((local.tag === 'paper' || local.tag === 'folder') && base?.tag === local.tag) {
    const value = mergeFields(base.value, local.value, remote.value)
    return value ? { tag: local.tag, value } : undefined
  }
  return undefined
}

function readingBytes(value: DocumentValue): string {
  return encodeSwiftJSON({ ...(value as Record<string, SwiftJSONValue>), scrollRatio: new SwiftDouble(Number(value.scrollRatio)) })
}

function mergeFields(base: DocumentValue, local: DocumentValue, remote: DocumentValue): DocumentValue | undefined {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const result: DocumentValue = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const [b, l, r] = [base[key], local[key], remote[key]]
    if (same(l, r)) result[key] = l
    else if (same(l, b)) result[key] = r
    else if (same(r, b)) result[key] = l
    else if (key === 'modifiedAt' && typeof l === 'number' && typeof r === 'number') result[key] = Math.max(l, r)
    else return undefined
  }
  for (const key of Object.keys(result)) if (result[key] === undefined || result[key] === null) delete result[key]
  return result
}
