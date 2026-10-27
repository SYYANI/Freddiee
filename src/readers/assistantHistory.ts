import type { AssistantHistoryAnchor } from '../../shared/types'

/** Locate text without inserting wrappers that would change HTML note anchors or PDF text layers. */
export function historyQuoteRange(root: Element | readonly Element[], quote: string, pdf = false): Range | null {
  // Prefer the exact spacing when the same page also contains a spacing-tolerant match.
  if (pdf) {
    const exact = historyQuoteRange(root, quote)
    if (exact) return exact
  }
  const roots: readonly Element[] = Array.isArray(root) ? root : [root as Element]
  if (!roots.length) return null
  const document = roots[0].ownerDocument
  const positions: Array<{ node: Text; start: number; end: number }> = []
  let text = ''
  let previousBlock: Element | null = null
  for (const root of roots) {
    // Translation text is searchable only when explicitly targeted, never as part of source text.
    const translation = root.closest('.rp-translation-block')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement
        return parent?.closest('script, style, [data-rp-reader], [data-rp-hidden="true"]') || parent?.closest('.rp-translation-block') !== translation
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      }
    })
    let node: Node | null
    while ((node = walker.nextNode())) {
      const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, figcaption, blockquote, td, th, dd, dt, pre') ?? translation
      if (!pdf && text && block !== previousBlock && !text.endsWith(' ')) {
        text += ' '
        positions.push({ node: node as Text, start: 0, end: 0 })
      }
      previousBlock = block
      const value = node.textContent ?? ''
      let offset = 0
      for (const original of value) {
        const character = pdf ? original.normalize('NFKC') : original
        for (const part of character) {
          if (pdf && /[\s\u00ad]/u.test(part)) continue
          const normalized = /\s/u.test(part) ? ' ' : part
          if (normalized === ' ' && text.endsWith(' ')) continue
          text += normalized
          // String indices and DOM Range offsets both use UTF-16, including unnormalized emoji.
          for (let unit = 0; unit < normalized.length; unit += 1) {
            positions.push({ node: node as Text, start: offset, end: offset + original.length })
          }
        }
        offset += original.length
      }
    }
  }
  const normalized = pdf ? Array.from(quote, (character) => character.normalize('NFKC')).join('').replace(/[\s\u00ad]/gu, '') : quote.replace(/\s+/gu, ' ').trim()
  if (!normalized) return null
  const start = text.indexOf(normalized)
  if (start < 0) return null
  const first = positions[start], last = positions[start + normalized.length - 1]
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, first.start)
  range.setEnd(last.node, last.end)
  return range
}

/** Keep cross-paragraph matching local; a stale quote still leaves its saved paragraph clickable. */
export function htmlHistoryRange(target: Element, quote: string, translation: Element | null): Range {
  const translatedOnly = target.ownerDocument.documentElement.getAttribute('data-rp-display-mode') === 'translated'
  const translations = translation && !translation.closest('[data-rp-hidden="true"]') ? [translation] : []
  const searchTranslations = translations.length > 0
  // The reader CSS hides source blocks in translated-only mode; keep their histories on the translation.
  const sources = translatedOnly && searchTranslations && target.closest('[data-rp-source="true"]') ? [] : [target]
  const exact = historyQuoteRange(sources, quote) ?? (searchTranslations ? historyQuoteRange(translations, quote) : null)
  if (exact) return exact
  let sibling = target.nextElementSibling
  for (let count = 0; sibling && count < 8; count += 1, sibling = sibling.nextElementSibling) {
    if (sibling.closest('[data-rp-hidden="true"]')) break
    if (sibling.classList.contains('rp-translation-block')) {
      if (searchTranslations && !translations.includes(sibling)) translations.push(sibling)
    } else if (sources.length && !sibling.hasAttribute('data-rp-reader')) sources.push(sibling)
  }
  for (const roots of [sources, translations]) {
    if (!roots.length) continue
    const range = historyQuoteRange(roots, quote)
    if (range && roots[0].contains(range.startContainer)) return range
  }
  const range = target.ownerDocument.createRange()
  range.selectNodeContents(translatedOnly && translation && translations[0] === translation ? translation : target)
  return range
}

export interface HistoryRange {
  anchor: AssistantHistoryAnchor
  range: Range
}

/** All code runs in the host renderer, including when root belongs to the sandboxed HTML frame. */
export function bindAssistantHistory(root: Element, entries: HistoryRange[], options: {
  name: string
  selectionGraceUntil: { current: number }
  enabled?: () => boolean
  activate: (anchor: AssistantHistoryAnchor, range: Range) => void
}): () => void {
  const document = root.ownerDocument
  const view = document.defaultView as (Window & { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown }) | null
  const registry = view?.CSS?.highlights
  const style = document.createElement('style')
  style.setAttribute('data-rp-reader', 'true')
  style.textContent = `::highlight(${options.name}) { background-color: rgba(0, 122, 255, 0.08); text-decoration: underline rgba(0, 122, 255, 0.58) 1px; }`
  document.head.appendChild(style)
  if (registry && view?.Highlight) registry.set(options.name, new view.Highlight(...entries.map((entry) => entry.range)))

  const entryAt = (event: MouseEvent): HistoryRange | undefined => {
    if (options.enabled && !options.enabled()) return undefined
    return entries.find(({ range }) => Array.from(range.getClientRects()).some((rect) =>
      rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom))
  }
  let down: { x: number; y: number; entry: HistoryRange; dragged: boolean } | undefined
  const pointerDown = (event: PointerEvent): void => {
    down = undefined
    if (event.button !== 0) return
    options.selectionGraceUntil.current = 0
    const entry = entryAt(event)
    if (!entry) return
    down = { x: event.clientX, y: event.clientY, entry, dragged: false }
    options.selectionGraceUntil.current = Date.now() + 700
  }
  const pointerMove = (event: PointerEvent): void => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) {
      down.dragged = true
      options.selectionGraceUntil.current = 0
    }
  }
  const click = (event: MouseEvent): void => {
    const gesture = down
    down = undefined
    if (!gesture || gesture.dragged || event.button !== 0 || event.detail > 1 || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) return
    const entry = entryAt(event)
    if (entry !== gesture.entry) return
    event.preventDefault()
    event.stopImmediatePropagation()
    options.selectionGraceUntil.current = Date.now() + 700
    options.activate(entry.anchor, entry.range)
  }
  const cancel = (): void => { down = undefined; options.selectionGraceUntil.current = 0 }
  root.addEventListener('pointerdown', pointerDown as EventListener, true)
  root.addEventListener('pointermove', pointerMove as EventListener, true)
  root.addEventListener('pointercancel', cancel, true)
  root.addEventListener('keydown', cancel, true)
  root.addEventListener('click', click as EventListener, true)
  return () => {
    root.removeEventListener('pointerdown', pointerDown as EventListener, true)
    root.removeEventListener('pointermove', pointerMove as EventListener, true)
    root.removeEventListener('pointercancel', cancel, true)
    root.removeEventListener('keydown', cancel, true)
    root.removeEventListener('click', click as EventListener, true)
    registry?.delete(options.name)
    style.remove()
  }
}
