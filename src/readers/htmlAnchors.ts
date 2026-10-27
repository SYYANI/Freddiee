/** A stable path to an element through original (non-reader) children, starting at <body>. */
export function elementPath(element: Element): string | undefined {
  const parts: number[] = []
  let current: Element | null = element
  const body = element.ownerDocument.body
  while (current && current !== body) {
    const parent: Element | null = current.parentElement
    if (!parent) return undefined
    const siblings = Array.from(parent.children).filter((child) => !child.classList.contains('rp-translation-block') && !child.hasAttribute('data-rp-reader'))
    parts.unshift(siblings.indexOf(current))
    current = parent
  }
  return current === body ? `rp-path:${parts.join('/')}` : undefined
}

export function resolveElementPath(document: Document, path: string): Element | undefined {
  if (!path.startsWith('rp-path:')) {
    try {
      return document.querySelector(path) ?? undefined
    } catch {
      return undefined
    }
  }
  let current: Element = document.body
  for (const part of path.slice('rp-path:'.length).split('/').filter(Boolean)) {
    const siblings = Array.from(current.children).filter((child) => !child.classList.contains('rp-translation-block') && !child.hasAttribute('data-rp-reader'))
    const next = siblings[Number(part)]
    if (!next) return undefined
    current = next
  }
  return current
}

