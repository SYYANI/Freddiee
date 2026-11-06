import type { PDFPageProxy } from 'pdfjs-dist'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
const svgNS = 'http://www.w3.org/2000/svg'

/** Dense translated figures otherwise create thousands of individual HTML style/transform contexts.
 * SVG text shares font styles while retaining native, character-accurate ranges and text selection.
 * Its positional attributes are PDF viewport coordinates, never reflowed or inferred from pixels.
 */
export async function renderDensePdfText(content: TextContent, viewport: Viewport, container: HTMLElement,
  cancelled: () => boolean, target: HTMLElement = container): Promise<boolean> {
  if (content.items.length < 1500 || content.items.some((item) => !('str' in item) || item.dir === 'rtl' || content.styles[item.fontName]?.vertical)) return false
  const document = container.ownerDocument
  const makeSVG = (): SVGSVGElement => {
    const svg = document.createElementNS(svgNS, 'svg')
    svg.classList.add('pdf-dense-text')
    svg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`)
    svg.setAttribute('width', String(viewport.width)); svg.setAttribute('height', String(viewport.height))
    svg.setAttribute('xml:space', 'preserve')
    return svg
  }
  if (cancelled()) return true
  for (const attribute of Array.from(container.attributes)) target.setAttribute(attribute.name, attribute.value)
  const loading = document.createElement('div')
  loading.className = 'pdf-text-loading'
  target.replaceChildren(loading)
  target.setAttribute('aria-busy', 'true')
  let svg = makeSVG(), batch = 0
  let group: SVGTextElement | undefined, previous = ''
  const [va, vb, vc, vd, ve, vf] = viewport.transform
  for (let index = 0; index < content.items.length; index++) {
    if (cancelled()) return true
    const item = content.items[index]
    if (!('str' in item)) continue
    const previousItem = content.items[index - 1]
    if (batch >= 128 && ((previousItem && 'str' in previousItem && previousItem.hasEOL) || batch >= 256)) {
      target.appendChild(svg)
      // Each independent SVG fragment lays out only its own small text batch. Attach after paint,
      // instead of making a single 20,000-run SVG synchronously lay out all its text at once.
      await new Promise<void>((done) => {
        if (target.isConnected && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(done, 0))
        else setTimeout(done, 0)
      })
      if (cancelled()) return true
      svg = makeSVG(); group = undefined; previous = ''; batch = 0
    }
    if (!item.str) continue
    const [a, b, c, d, e, f] = item.transform
    const angle = Math.atan2(vb * a + vd * b, va * a + vc * b)
    const size = Math.hypot(va * c + vc * d, vb * c + vd * d)
    const family = content.styles[item.fontName]?.fontFamily ?? 'sans-serif'
    const key = `${family}|${size}|${angle}`
    if (!group || key !== previous) {
      group = document.createElementNS(svgNS, 'text')
      group.style.fontFamily = family
      group.style.fontSize = `${size}px`
      if (angle) group.setAttribute('transform', `rotate(${angle * 180 / Math.PI})`)
      svg.appendChild(group)
      previous = key
    }
    const x = va * e + vc * f + ve, y = vb * e + vd * f + vf
    const span = document.createElementNS(svgNS, 'tspan')
    span.setAttribute('x', String(Math.cos(angle) * x + Math.sin(angle) * y))
    span.setAttribute('y', String(-Math.sin(angle) * x + Math.cos(angle) * y))
    // Mirror PDF.js: ordinary single glyphs/spaces keep their font advance; multi-glyph runs
    // fit the PDF's exact advance, including nonuniformly scaled single glyphs.
    const ax = Math.abs(a), ay = Math.abs(d)
    if (item.width > 0 && (item.str.length > 1 || (item.str !== ' ' && ax !== ay && Math.max(ax, ay) / Math.min(ax, ay) > 1.5))) {
      span.setAttribute('textLength', String(item.width * viewport.scale))
      span.setAttribute('lengthAdjust', 'spacingAndGlyphs')
    }
    span.textContent = item.str
    group.appendChild(span)
    batch++
  }
  if (!cancelled()) {
    if (batch) target.appendChild(svg)
    loading.remove()
    target.removeAttribute('aria-busy')
  }
  return true
}
