export interface ArxivIdentifier {
  baseId: string
  version?: string
}

export class InvalidIdentifierError extends Error {}

export function arxivQueryId(identifier: ArxivIdentifier): string {
  return identifier.version ? identifier.baseId + identifier.version : identifier.baseId
}

function isValidArxivBaseId(value: string): boolean {
  return /^\d{4}\.\d{4,5}$/.test(value) || /^[a-zA-Z-]+(?:\.[A-Z]{2})?\/\d{7}$/.test(value)
}

/** Accepts `2303.08774`, `arXiv:2303.08774v2`, legacy `hep-th/9901001`, and abs/pdf/html URLs. */
export function normalizeArxivIdentifier(rawValue: string): ArxivIdentifier {
  let value = rawValue.trim()
  if (value.toLowerCase().startsWith('arxiv:')) value = value.slice('arxiv:'.length)

  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host.includes('arxiv.org')) {
      const components = url.pathname.split('/').filter(Boolean)
      const marker = components.findIndex((component) => ['abs', 'pdf', 'html'].includes(component))
      if (marker >= 0 && components[marker + 1]) value = components.slice(marker + 1).join('/')
      else if (components.length) value = components[components.length - 1]
    }
  } catch {
    // Not a URL: treat it as an identifier.
  }

  value = value.replace(/\.pdf/g, '').replace(/^[/ ]+|[/ ]+$/g, '')
  const versioned = value.match(/v\d+$/)
  if (versioned) {
    const base = value.slice(0, versioned.index)
    if (!isValidArxivBaseId(base)) throw new InvalidIdentifierError(rawValue)
    return { baseId: base, version: versioned[0] }
  }
  if (!isValidArxivBaseId(value)) throw new InvalidIdentifierError(rawValue)
  return { baseId: value }
}

/**
 * Only explicit arXiv context counts (`arXiv:2303.08774`, arxiv.org or ar5iv links), so DOIs
 * and other numbers inside a PDF are never mistaken for an arXiv ID.
 */
export function extractArxivIdentifier(text: string): ArxivIdentifier | undefined {
  const explicit = text.match(/\barxiv\s*:?\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-zA-Z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/i)
  if (explicit) {
    try {
      return normalizeArxivIdentifier(explicit[1])
    } catch {
      // Fall through to links.
    }
  }
  const link = text.match(/\bhttps?:\/\/(?:www\.)?(?:arxiv\.org|ar5iv\.labs\.arxiv\.org)\/\S+/i)
  if (link) {
    try {
      return normalizeArxivIdentifier(link[0].replace(/^[[\](){}<>.,;"']+|[[\](){}<>.,;"']+$/g, ''))
    } catch {
      return undefined
    }
  }
  return undefined
}

export function extractDOI(text: string): string | undefined {
  const normalized = text
    .replace(/(10\.)\s+/g, '$1')
    .replace(/(doi(?:\.org\/|:))\s+/gi, '$1')
    .replace(/\/\s+/g, '/')
  const patterns = [
    /\b(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i,
    /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) return match[1]
  }
  return undefined
}

export type WebURLError = 'invalid' | 'unsupportedScheme'

/** Adds https when missing and drops the fragment. */
export function normalizeWebPageURL(rawValue: string): URL {
  const trimmed = rawValue.trim()
  if (!trimmed) throw Object.assign(new Error('invalid'), { code: 'invalid' as WebURLError })
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw Object.assign(new Error('invalid'), { code: 'invalid' as WebURLError })
  }
  if (!url.hostname) throw Object.assign(new Error('invalid'), { code: 'invalid' as WebURLError })
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('unsupportedScheme'), { code: 'unsupportedScheme' as WebURLError })
  }
  url.hash = ''
  return url
}

export function fallbackWebPageTitle(url: URL, untitled: string): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim()
  if (last) return last.replace(/-/g, ' ')
  return url.hostname || untitled
}
