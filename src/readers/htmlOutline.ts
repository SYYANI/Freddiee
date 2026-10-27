import type { DocumentOutlineEntry } from '../../shared/outline'
import { elementPath } from './htmlAnchors'

const headingSelector = 'h1,h2,h3,h4,h5,h6'
const translationSelector = '.rp-translation-block'
const excluded = '.rp-translation-block,.rp-tex-math,[data-rp-region-hidden="true"],[data-rp-hidden="true"],[hidden],script,style,nav'
const clean = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim()

function translationIndex(document: Document): Map<string, Element> {
  const result = new Map<string, Element>()
  for (const block of document.querySelectorAll('.rp-translation-block[data-rp-source-segment-id]')) {
    const id = block.getAttribute('data-rp-source-segment-id')!
    if (!result.has(id)) result.set(id, block)
  }
  return result
}

export function headingTranslation(element: Element, translations = translationIndex(element.ownerDocument)): Element | null {
  const id = element.getAttribute('data-rp-segment-id')
  if (id && translations.has(id)) return translations.get(id)!
  return element.nextElementSibling?.classList.contains('rp-translation-block') ? element.nextElementSibling : null
}

export function visibleHeadingTarget(element: Element, translation = headingTranslation(element)): Element | null {
  if (element.getClientRects().length) return element
  return translation?.getClientRects().length ? translation : null
}

export function htmlOutlineHeadings(document: Document): Array<{ element: Element; translation: Element | null; entry: DocumentOutlineEntry }> {
  const translations = translationIndex(document)
  const headings = Array.from(document.querySelectorAll(headingSelector)).filter((element) => !element.closest(excluded)).flatMap((element) => {
    const clone = element.cloneNode(true) as Element
    clone.querySelectorAll('.rp-translation-block,.rp-tex-math,script,style').forEach((node) => node.remove())
    const anchor = elementPath(element)
    const title = clean(clone.textContent)
    const translation = headingTranslation(element, translations)
    if (!anchor || !title || !visibleHeadingTarget(element, translation)) return []
    return [{ element, translation, entry: { id: anchor, anchor, title, translation: clean(translation?.textContent ?? null) || undefined, level: Number(element.tagName.slice(1)) } }]
  })
  const minimum = Math.min(6, ...headings.map(({ entry }) => entry.level))
  for (const { entry } of headings) entry.level -= minimum - 1
  return headings
}

// Reader decorations do not affect heading text, visibility or stable anchors.
const decorationClasses = new Set(['rp-region-hover', 'rp-note-anchor-target'])
const contentClasses = (value: string | null): string => (value ?? '').split(/\s+/).filter((name) => name && !decorationClasses.has(name)).sort().join(' ')
function affectsHeadings(mutation: MutationRecord): boolean {
  const element = mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement
  if (!element || element.closest('[data-rp-reader]')) return false
  if (mutation.type === 'characterData') return Boolean(element.closest(`${headingSelector},${translationSelector},style`))
  if (mutation.type === 'childList') {
    if (element.matches('style')) return true
    // Element insertions can change the stable paths of later headings.
    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === 1 && !(node as Element).hasAttribute('data-rp-reader')) ||
      Boolean(element.closest(`${headingSelector},${translationSelector}`))
  }
  if (mutation.attributeName === 'class' && contentClasses(mutation.oldValue) === contentClasses(element.getAttribute('class'))) return false
  return element.matches(`${headingSelector},${translationSelector}`) || Boolean(element.querySelector(`${headingSelector},${translationSelector}`)) ||
    Boolean(element.closest(`${headingSelector},${translationSelector}`))
}

export function observeHtmlOutline(document: Document, publish: (entries: DocumentOutlineEntry[], currentID?: string) => void): () => void {
  const view = document.defaultView!
  let headings: ReturnType<typeof htmlOutlineHeadings> = []
  let rebuild = true
  let frame = 0
  let mutationTimer: ReturnType<typeof setTimeout> | undefined
  let maximumTimer: ReturnType<typeof setTimeout> | undefined
  let lastEntries = ''
  let lastCurrent: string | undefined
  const update = (): void => {
    frame = 0
    if (rebuild) { headings = htmlOutlineHeadings(document); rebuild = false }
    let current: string | undefined
    for (const { element, translation, entry } of headings) {
      const target = visibleHeadingTarget(element, translation)
      if (target && target.getBoundingClientRect().top <= Math.min(120, view.innerHeight * 0.22)) current = entry.id
    }
    current ??= headings[0]?.entry.id
    const entries = headings.map(({ entry }) => entry)
    const serialized = JSON.stringify(entries)
    if (lastEntries !== serialized || lastCurrent !== current) publish(entries, current)
    lastEntries = serialized; lastCurrent = current
  }
  const schedule = (needsRebuild = false): void => {
    rebuild ||= needsRebuild
    if (!frame) frame = view.requestAnimationFrame(update)
  }
  const scroll = (): void => schedule()
  const resize = (): void => schedule(true)
  const flushMutations = (): void => {
    clearTimeout(mutationTimer); clearTimeout(maximumTimer)
    mutationTimer = maximumTimer = undefined
    schedule(true)
  }
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some(affectsHeadings)) { schedule(); return }
    clearTimeout(mutationTimer)
    mutationTimer = setTimeout(flushMutations, 100)
    maximumTimer ??= setTimeout(flushMutations, 500)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['data-rp-hidden', 'data-rp-region-hidden', 'data-rp-source', 'data-rp-segment-id', 'data-rp-source-segment-id', 'data-rp-display-mode', 'class', 'style', 'hidden'] })
  view.addEventListener('scroll', scroll, { passive: true })
  view.addEventListener('resize', resize, { passive: true })
  document.addEventListener('load', resize, true)
  schedule(true)
  return () => {
    observer.disconnect()
    view.cancelAnimationFrame(frame)
    clearTimeout(mutationTimer); clearTimeout(maximumTimer)
    view.removeEventListener('scroll', scroll)
    view.removeEventListener('resize', resize)
    document.removeEventListener('load', resize, true)
  }
}
