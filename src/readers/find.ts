export interface FindOptions {
  matchCase: boolean
  wholeWords: boolean
}

export interface FindRequest {
  query: string
  options: FindOptions
  navigationToken: number
  direction: 'forward' | 'backward'
}

export interface FindStatus {
  query: string
  options: FindOptions
  isSearching: boolean
  matchCount: number
  currentIndex?: number
}

export function buildMatcher(query: string, options: FindOptions): RegExp {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const source = options.wholeWords ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped
  return new RegExp(source, `gu${options.matchCase ? '' : 'i'}`)
}
