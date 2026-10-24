// Stage 8 backend: writes the translated document through the wasm MuPDF
// writer (the shim's writer entry points), ported from Swift NativePDFBackend
// and its PDFContentStreamRenderer. Formats mirror Swift's en_US_POSIX printf.
import { boxCoordinates, pythonBool, type ILBox, type ILDocument, type ILPage, type ILPdfCharacter, type ILPdfCurve, type ILPdfForm, type ILPdfParagraph, type ILPdfParagraphComposition, type ILPdfPath, type ILPdfStyle, type PythonDebugInfo } from './il'
import { babelDocWasm, type BabelDocWasmModule, type SourcePlanBuffers } from './wasmModule'
import {
  SourcePreservingPlanner, makeSourceParagraphSnapshot,
  type SourcePreservingDocumentPlan, type SourcePreservingPagePlan
} from './sourcePreservingPlan'
import { ensureWriterFontsLoaded, fontDirectory, type FontTable } from './pdfBackendFonts'
import { isolateSharedPageStreams } from './pdfPageIsolation'

export type NativePDFRenderingMode = 'rebuild' | 'source-preserving'

export interface NativePDFBackendConfiguration {
  targetFontDirectory?: string | null
  skipForms: boolean
  skipCurves: boolean
  onlyIncludeTranslatedPages: boolean
  renderingMode: NativePDFRenderingMode
  maximumUnmatchedGlyphFraction: number
}

export const defaultBackendConfiguration: NativePDFBackendConfiguration = {
  targetFontDirectory: null,
  skipForms: false,
  skipCurves: false,
  onlyIncludeTranslatedPages: false,
  renderingMode: 'rebuild',
  maximumUnmatchedGlyphFraction: 0.01
}

export const pipelineRenderingMode: NativePDFRenderingMode = 'source-preserving'

export type BackendOutcome = 'source-preserved' | 'unchanged' | 'rebuilt'
export type BackendFallbackReason = 'missing-plan' | 'filter-error' | 'glyph-sequence' | 'glyph-match' | 'page-geometry' | 'glyph-position'

export interface BackendPageReport {
  pageNumber: number
  outcome: BackendOutcome
  fallbackReason?: BackendFallbackReason
  glyphCount: number
  requiredGlyphCount: number
  matchedRequiredGlyphCount: number
  unmatchedPlacedGlyphCount: number
  removedGlyphCount: number
  placedGlyphCount: number
  adoptedGlyphCount: number
  removedGraphicCount: number
  placedGraphicCount: number
  placementCount: number
  layerCount: number
  misplacedGlyphCount: number
}

export interface NativePDFBackendReport {
  renderingMode: NativePDFRenderingMode
  pages: BackendPageReport[]
}

export class BabelDocBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocBackendError'
  }
}

interface PDFRenderedFont {
  id: string
  ownerXref: number | null
}

interface PDFRenderedStreams {
  pageContent: Uint8Array
  xobjectContent: Map<number, Uint8Array>
  fonts: PDFRenderedFont[]
}

const encoder = new TextEncoder()

function printf6(value: number): string {
  return value.toFixed(6)
}

function printfF(value: number): string {
  return value.toFixed(6)
}

function hexGlyph(glyph: number, encodingLength: number): string {
  return glyph.toString(16).toUpperCase().padStart(encodingLength * 2, '0')
}

export const NativePDFBackend = {
  async write(
    sourcePDF: Uint8Array,
    document: ILDocument,
    configuration: NativePDFBackendConfiguration = defaultBackendConfiguration,
    sourcePlan?: SourcePreservingDocumentPlan | null
  ): Promise<{ pdf: Uint8Array; report: NativePDFBackendReport }> {
    const isolated = await isolateSharedPageStreams(sourcePDF, document)
    document = isolated.document
    const wasm = await babelDocWasm()
    await ensureWriterFontsLoaded(configuration.targetFontDirectory ?? undefined)
    const fonts = fontDirectory(configuration.targetFontDirectory ?? undefined)
    const writer = wasm.writerOpen(isolated.pdf)

    const reports = new Map<number, BackendPageReport>()
    const rebuilt: Array<{ page: ILPage; fallback?: BackendFallbackReason }> = []
    try {
      for (const page of document.page ?? []) {
        const pageNumber = page.page_number
        if (pageNumber === undefined || pageNumber < 0) {
          throw new BabelDocBackendError(`Invalid PDF page metadata for page ${pageNumber ?? -1}.`)
        }
        if (configuration.renderingMode !== 'source-preserving') {
          rebuilt.push({ page, fallback: undefined })
          continue
        }
        const plan = sourcePlan?.pages.get(pageNumber)
        if (!plan) {
          rebuilt.push({ page, fallback: 'missing-plan' })
          continue
        }
        const report = preserveSourcePage(page, plan, writer, configuration, fonts, wasm)
        if (report.fallbackReason) {
          rebuilt.push({ page, fallback: report.fallbackReason })
        }
        reports.set(pageNumber, report)
      }
      // Each page now owns the streams it can rewrite, including fallbacks.
      for (const { page, fallback } of rebuilt) {
        rebuildPage(page, writer, configuration, fonts, wasm)
        const pageNumber = page.page_number ?? 0
        const previous = reports.get(pageNumber)
        reports.set(pageNumber, {
          pageNumber,
          outcome: 'rebuilt',
          fallbackReason: fallback,
          glyphCount: previous?.glyphCount ?? 0,
          requiredGlyphCount: previous?.requiredGlyphCount ?? 0,
          matchedRequiredGlyphCount: previous?.matchedRequiredGlyphCount ?? 0,
          unmatchedPlacedGlyphCount: previous?.unmatchedPlacedGlyphCount ?? 0,
          placementCount: previous?.placementCount ?? 0,
          removedGlyphCount: 0, placedGlyphCount: 0, adoptedGlyphCount: 0,
          removedGraphicCount: 0, placedGraphicCount: 0, layerCount: 0, misplacedGlyphCount: 0
        })
      }
      if (configuration.onlyIncludeTranslatedPages) {
        const pageIndices = (document.page ?? []).map((page) => {
          const pageNumber = page.page_number
          if (pageNumber === undefined || pageNumber < 0) {
            throw new BabelDocBackendError(`Invalid PDF page metadata for page ${pageNumber ?? -1}.`)
          }
          return pageNumber
        })
        wasm.writerKeepPages(writer, pageIndices)
      }
      const pdf = wasm.writerSave(writer)
      return {
        pdf,
        report: {
          renderingMode: configuration.renderingMode,
          pages: (document.page ?? [])
            .map((page) => (page.page_number !== undefined ? reports.get(page.page_number) : undefined))
            .filter((report): report is BackendPageReport => report !== undefined)
        }
      }
    } finally {
      wasm.writerClose(writer)
    }
  }
}

function rebuildPage(
  page: ILPage,
  writer: number,
  configuration: NativePDFBackendConfiguration,
  fonts: FontTable,
  wasm: BabelDocWasmModule
): void {
  const pageNumber = page.page_number
  if (pageNumber === undefined || pageNumber < 0) {
    throw new BabelDocBackendError(`Invalid PDF page metadata for page ${pageNumber ?? -1}.`)
  }
  const decodedXObjectOperations = new Map<number, Uint8Array>()
  for (const object of page.pdf_xobject ?? []) {
    const id = object.xobj_id
    const value = object.base_operations?.value
    if (id === undefined || !value || value.length === 0) continue
    decodedXObjectOperations.set(id, encoder.encode(wasm.decodeBaseOperations(value)))
  }
  const rendered = PDFContentStreamRenderer.render(page, configuration, fonts, decodedXObjectOperations, true)
  registerFonts(rendered.fonts, pageNumber, writer, wasm)
  wasm.writerSetPageContent(writer, pageNumber, rendered.pageContent)
  for (const [xref, content] of rendered.xobjectContent) {
    wasm.writerSetObjectContent(writer, xref, content)
  }
}

/** Keep font registration deterministic, with the larger CJK families before
 * Latin fallbacks (the shim's CID builder mutates shared font state). */
function registerFonts(fonts: PDFRenderedFont[], pageNumber: number, writer: number, wasm: BabelDocWasmModule): void {
  const ordered = [...fonts].sort((lhs, rhs) => {
    if (lhs.id !== rhs.id) return lhs.id > rhs.id ? -1 : 1
    if (lhs.ownerXref !== rhs.ownerXref) return (lhs.ownerXref ?? -1) - (rhs.ownerXref ?? -1)
    return 0
  })
  for (const font of ordered) {
    wasm.writerAddCIDFont(writer, pageNumber, font.ownerXref ?? 0, font.id, font.id)
  }
}

function preserveSourcePage(
  page: ILPage,
  plan: SourcePreservingPagePlan,
  writer: number,
  configuration: NativePDFBackendConfiguration,
  fonts: FontTable,
  wasm: BabelDocWasmModule
): BackendPageReport {
  const pageNumber = page.page_number
  if (pageNumber === undefined) throw new BabelDocBackendError('Invalid PDF page metadata for page -1.')
  const underlayPage: ILPage = {
    mediabox: page.mediabox,
    cropbox: page.cropbox,
    pdf_font: page.pdf_font,
    page_number: pageNumber,
    pdf_curve: plan.underlayCurves.map((curve) => ({ ...curve, xobj_id: undefined })),
    pdf_character: [],
    pdf_paragraph: []
  }
  const overlayPage: ILPage = {
    ...underlayPage,
    pdf_curve: [],
    pdf_character: plan.overlayCharacters.map((character) => ({ ...character, xobj_id: undefined }))
  }
  const underlay = plan.underlayCurves.length > 0
    ? PDFContentStreamRenderer.render(underlayPage, configuration, fonts, new Map(), false)
    : null
  const overlay = plan.overlayCharacters.length > 0
    ? PDFContentStreamRenderer.render(overlayPage, configuration, fonts, new Map(), false)
    : null
  const underlayContent = underlay?.pageContent ?? new Uint8Array(0)
  const overlayContent = overlay?.pageContent ?? new Uint8Array(0)

  const anchors = new Float64Array(plan.glyphs.length * 8)
  plan.glyphs.forEach((glyph, index) => {
    const offset = index * 8
    anchors[offset] = glyph.anchor.x
    anchors[offset + 1] = glyph.anchor.y
    anchors[offset + 2] = glyph.anchor.y2
    anchors[offset + 3] = glyph.anchor.orientation
    anchors[offset + 4] = glyph.anchor.unicode ?? -1
    anchors[offset + 5] = glyph.role
    anchors[offset + 6] = glyph.placement ?? -1
    anchors[offset + 7] = glyph.anchor.isOptional ? 1 : 0
  })
  const rects: number[] = []
  const placements = new Float64Array(plan.placements.length * 7)
  plan.placements.forEach((placement, index) => {
    const offset = index * 7
    const first = rects.length / 5
    for (const [rectList, isGraphic] of [[placement.glyphRects, 0], [placement.graphicRects, 1]] as Array<[ILBox[], number]>) {
      for (const rect of rectList) {
        const coordinates = boxCoordinates(rect)
        rects.push(coordinates?.x ?? 0, coordinates?.y ?? 0, coordinates?.x2 ?? 0, coordinates?.y2 ?? 0, isGraphic)
      }
    }
    const transform = placement.transform.length === 6 ? placement.transform : [1, 0, 0, 1, 0, 0]
    placements[offset] = transform[0]
    placements[offset + 1] = transform[1]
    placements[offset + 2] = transform[2]
    placements[offset + 3] = transform[3]
    placements[offset + 4] = transform[4]
    placements[offset + 5] = transform[5]
    placements[offset + 6] = first
  })
  const removedValues = (boxes: ILBox[]): Float64Array => {
    const values = new Float64Array(boxes.length * 4)
    boxes.forEach((box, index) => {
      const coordinates = boxCoordinates(box)
      const offset = index * 4
      values[offset] = coordinates ? Math.min(coordinates.x, coordinates.x2) : 0
      values[offset + 1] = coordinates ? Math.min(coordinates.y, coordinates.y2) : 0
      values[offset + 2] = coordinates ? Math.max(coordinates.x, coordinates.x2) : 0
      values[offset + 3] = coordinates ? Math.max(coordinates.y, coordinates.y2) : 0
    })
    return values
  }
  const buffers: SourcePlanBuffers = {
    anchors,
    placements,
    rects: new Float64Array(rects),
    removedRegions: removedValues(plan.removedRegions),
    removedTextRegions: removedValues(plan.removedTextRegions),
    underlay: underlayContent,
    overlay: overlayContent
  }

  const result = wasm.writerApplySourcePreservingPage(writer, pageNumber, buffers, configuration.maximumUnmatchedGlyphFraction)
  const applied = 0
  const unchanged = 1
  const fallbackCodes: Record<number, BackendFallbackReason> = {
    2: 'glyph-sequence',
    3: 'glyph-match',
    4: 'page-geometry',
    5: 'glyph-position'
  }
  let outcome: BackendOutcome
  let fallback: BackendFallbackReason | undefined
  if (result.status === applied) {
    outcome = 'source-preserved'
    registerFonts([...(underlay?.fonts ?? []), ...(overlay?.fonts ?? [])], pageNumber, writer, wasm)
  } else if (result.status === unchanged) {
    outcome = 'unchanged'
  } else {
    outcome = 'rebuilt'
    fallback = fallbackCodes[result.fallbackReason] ?? 'filter-error'
  }
  return {
    pageNumber,
    outcome,
    fallbackReason: fallback,
    glyphCount: result.glyphCount,
    requiredGlyphCount: result.requiredAnchorCount,
    matchedRequiredGlyphCount: result.requiredAnchorCount - result.unmatchedRequiredAnchorCount,
    unmatchedPlacedGlyphCount: result.unmatchedPlacementAnchorCount,
    removedGlyphCount: result.removedGlyphCount,
    placedGlyphCount: result.placedGlyphCount,
    adoptedGlyphCount: result.adoptedGlyphCount,
    removedGraphicCount: result.removedGraphicCount,
    placedGraphicCount: result.placedGraphicCount,
    placementCount: plan.placements.length,
    layerCount: result.layerCount,
    misplacedGlyphCount: result.misplacedGlyphCount
  }
}

interface RenderUnit {
  order: number
  suborder: number
  insertion: number
  xobjectID: number | null
  bytes: Uint8Array
  fontID: string | null
}

export const PDFContentStreamRenderer = {
  render(
    page: ILPage,
    configuration: NativePDFBackendConfiguration,
    fonts: FontTable,
    decodedXObjectBaseOperations: Map<number, Uint8Array>,
    includesPageTranslation: boolean
  ): PDFRenderedStreams {
    const pageNumber = page.page_number
    const crop = boxCoordinates(page.cropbox?.box)
    if (pageNumber === undefined || !crop) {
      throw new BabelDocBackendError(`Invalid PDF page metadata for page ${pageNumber ?? -1}.`)
    }
    const xobjects = new Map<number, { xref: number; object: NonNullable<ILPage['pdf_xobject']>[number] }>()
    for (const object of page.pdf_xobject ?? []) {
      if (object.xobj_id !== undefined && object.xref_id !== undefined) {
        xobjects.set(object.xobj_id, { xref: object.xref_id, object })
      }
    }
    const pageEncoding = new Map<string, number>()
    const pageFonts = new Map<string, NonNullable<ILPage['pdf_font']>[number]>()
    for (const font of page.pdf_font ?? []) {
      if (font.font_id !== undefined && font.encoding_length !== undefined) pageEncoding.set(font.font_id, font.encoding_length)
      if (font.font_id !== undefined) pageFonts.set(font.font_id, font)
    }
    const targetEncoding = new Map<string | null, Map<string, number>>([['__page__', pageEncoding]])
    const targetFonts = new Map<string | null, Map<string, NonNullable<ILPage['pdf_font']>[number]>>([['__page__', pageFonts]])
    const targetKey = (id: number | null): string => (id === null ? '__page__' : `x${id}`)
    for (const [id, entry] of xobjects) {
      const encoding = new Map(pageEncoding)
      const fontMap = new Map(pageFonts)
      for (const font of entry.object.pdf_font ?? []) {
        if (font.font_id !== undefined && font.encoding_length !== undefined) encoding.set(font.font_id, font.encoding_length)
        if (font.font_id !== undefined) fontMap.set(font.font_id, font)
      }
      targetEncoding.set(targetKey(id), encoding)
      targetFonts.set(targetKey(id), fontMap)
    }

    const units: RenderUnit[] = []
    let insertion = 0
    const append = (bytes: Uint8Array, order?: number, suborder?: number, xobjectID: number | null = null, fontID: string | null = null): void => {
      units.push({
        order: order ?? Number.MAX_SAFE_INTEGER,
        suborder: suborder ?? Number.MAX_SAFE_INTEGER,
        insertion,
        xobjectID,
        bytes,
        fontID
      })
      insertion += 1
    }

    const characters = [...(page.pdf_character ?? [])]
    for (const paragraph of page.pdf_paragraph ?? []) {
      for (const composition of paragraph.pdf_paragraph_composition ?? []) {
        if (composition.pdf_character) {
          characters.push(composition.pdf_character)
        } else if (composition.pdf_formula) {
          characters.push(...(composition.pdf_formula.pdf_character ?? []))
        }
      }
    }
    characters.forEach((character, index) => {
      if (character.char_unicode === '\n' || character.pdf_character_id === undefined) return
      const target = xobjects.get(character.xobj_id ?? -1) === undefined ? null : character.xobj_id ?? null
      const key = targetKey(target)
      const encodings = new Map(targetEncoding.get(key) ?? pageEncoding)
      const fontID = character.pdf_style?.font_id
      if (!fontID) throw new BabelDocBackendError('Invalid render character: missing font id')
      if (!encodings.has(fontID) && fonts.has(fontID)) {
        encodings.set(fontID, 2)
        targetEncoding.set(key, encodings)
      }
      const encoding = encodings.get(fontID)
      if (encoding === undefined) throw new BabelDocBackendError(`PDF font resource is unavailable: ${fontID}.`)
      append(
        renderCharacter(character, encoding, targetFonts.get(key)?.get(fontID)),
        character.render_order,
        character.sub_render_order ?? index,
        target,
        fontID
      )
    })

    if (!configuration.skipForms) {
      (page.pdf_form ?? []).forEach((form, index) => {
        append(
          renderForm(form),
          form.render_order,
          index,
          xobjects.get(form.xobj_id ?? -1) === undefined ? null : form.xobj_id ?? null
        )
      })
    }
    if (!configuration.skipCurves) {
      (page.pdf_curve ?? []).forEach((curve, index) => {
        if (!pythonBool(curve.passthrough_paint) && !truthyDebug(curve.debug_info)) return
        const curveTarget = xobjects.get(curve.xobj_id ?? -1) === undefined ? null : curve.xobj_id ?? null
        let curveOrder = curve.render_order
        const curveBox = boxCoordinates(curve.box)
        if (pythonBool(curve.fill_background) && curveBox) {
          const firstContainedTextOrder = Math.min(...characters
            .map((character) => {
              const characterTarget = xobjects.get(character.xobj_id ?? -1) === undefined ? null : character.xobj_id ?? null
              if (characterTarget !== curveTarget || character.render_order === undefined) return Number.POSITIVE_INFINITY
              const box = boxCoordinates(character.visual_bbox?.box ?? character.box)
              if (!box) return Number.POSITIVE_INFINITY
              const centerX = (box.x + box.x2) / 2
              const centerY = (box.y + box.y2) / 2
              return centerX >= curveBox.x && centerX <= curveBox.x2
                && centerY >= curveBox.y && centerY <= curveBox.y2 ? character.render_order : Number.POSITIVE_INFINITY
            }))
          if (Number.isFinite(firstContainedTextOrder)
            && (curveOrder === undefined || curveOrder >= firstContainedTextOrder)) {
            curveOrder = firstContainedTextOrder - 1
          }
        }
        append(renderCurve(curve), curveOrder, index, curveTarget)
      })
    }
    units.sort((lhs, rhs) => (lhs.order - rhs.order) || (lhs.suborder - rhs.suborder) || (lhs.insertion - rhs.insertion))

    const translation = pageContentTranslation(page, crop)
    const chunks: Uint8Array[] = []
    if (includesPageTranslation) {
      chunks.push(encoder.encode(` ${printf6(1.0)} ${printf6(0.0)} ${printf6(0.0)} ${printf6(1.0)} ${printf6(translation.x)} ${printf6(translation.y)} cm \n`))
    }
    const xobjectChunks = new Map<number, Uint8Array[]>()
    for (const [id, entry] of xobjects) {
      const operations = decodedXObjectBaseOperations.get(id)
      if (operations) xobjectChunks.set(entry.xref, [operations])
    }
    const renderedFonts = new Map<string, PDFRenderedFont>()
    for (const unit of units) {
      if (unit.xobjectID !== null) {
        const entry = xobjects.get(unit.xobjectID)
        if (!entry) throw new BabelDocBackendError(`PDF render unit references missing XObject id ${unit.xobjectID}.`)
        const value = entry.object.base_operations?.value ?? ''
        if (value.length > 0 && !decodedXObjectBaseOperations.has(unit.xobjectID)) {
          throw new BabelDocBackendError(`Native XObject base-operation decoding is not implemented for XObject id ${unit.xobjectID}.`)
        }
        xobjectChunks.set(entry.xref, [...(xobjectChunks.get(entry.xref) ?? []), unit.bytes])
      } else {
        chunks.push(unit.bytes)
      }
      if (unit.fontID && !pageEncoding.has(unit.fontID) && fonts.has(unit.fontID)) {
        const ownerXref = unit.xobjectID !== null ? xobjects.get(unit.xobjectID)?.xref ?? null : null
        renderedFonts.set(unit.fontID, { id: unit.fontID, ownerXref })
      }
    }
    return {
      pageContent: concat(chunks),
      xobjectContent: new Map([...xobjectChunks].map(([xref, list]) => [xref, concat(list)])),
      fonts: [...renderedFonts.values()]
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** The frontend exposes unrotated crop-local text through a zero-origin
 * mediabox of crop size; translating again would move text off the page. */
function pageContentTranslation(
  page: ILPage,
  crop: NonNullable<ReturnType<typeof boxCoordinates>>
): { x: number; y: number } {
  const tolerance = 0.001
  const media = boxCoordinates(page.mediabox?.box)
  if (!media
    || Math.abs(media.x) > tolerance || Math.abs(media.y) > tolerance
    || Math.abs(Math.abs(media.x2 - media.x) - Math.abs(crop.x2 - crop.x)) > tolerance
    || Math.abs(Math.abs(media.y2 - media.y) - Math.abs(crop.y2 - crop.y)) > tolerance) {
    return { x: -crop.x, y: -crop.y }
  }
  return { x: 0, y: 0 }
}

function renderCharacter(character: ILPdfCharacter, encodingLength: number, font: NonNullable<ILPage['pdf_font']>[number] | undefined): Uint8Array {
  const glyph = character.pdf_character_id
  const style = character.pdf_style
  const box = boxCoordinates(character.box)
  if (glyph === undefined || !style || style.font_id === undefined || style.font_size === undefined || !box) {
    throw new BabelDocBackendError('Invalid render character: missing glyph/style/box')
  }
  const pdfFontSize = font?.font_subtype === 'Type3' && font.type3_em_height !== undefined
    && Number.isFinite(font.type3_em_height) && (font.type3_em_height ?? 0) > 0
    ? style.font_size / (font.type3_em_height as number)
    : style.font_size
  let value = 'q '
  const perCharInstruction = style.graphic_state?.passthrough_per_char_instruction
  if (perCharInstruction !== undefined) value += `${perCharInstruction} \n`
  if (pythonBool(character.vertical)) {
    value += `BT /${style.font_id} ${printfF(pdfFontSize)} Tf 0 1 -1 0 ${printfF(box.x2)} ${printfF(box.y)} Tm `
  } else if (pythonBool(character.y_flipped)) {
    value += `BT /${style.font_id} ${printfF(pdfFontSize)} Tf 1 0 0 -1 ${printfF(box.x)} ${printfF(box.y2)} Tm `
  } else {
    value += `BT /${style.font_id} ${printfF(pdfFontSize)} Tf 1 0 0 1 ${printfF(box.x)} ${printfF(box.y)} Tm `
  }
  value += `<${hexGlyph(glyph, encodingLength)}> Tj ET Q \n`
  return encoder.encode(value)
}

function matrix(values: number[] | undefined): string {
  if (!values || values.length !== 6) return ''
  return ` ${values.map((value) => printf6(value)).join(' ')} cm `
}

function renderForm(form: ILPdfForm): Uint8Array {
  const pdfMatrix = form.pdf_matrix
  const subtype = form.pdf_form_subtype
  if (!pdfMatrix || !subtype) throw new BabelDocBackendError('PDF form is missing its matrix, graphic state, or subtype.')
  let value = 'q '
  if (form.relocation_transform?.length === 6) value += matrix(form.relocation_transform)
  value += matrix([pdfMatrix.a ?? 0, pdfMatrix.b ?? 0, pdfMatrix.c ?? 0, pdfMatrix.d ?? 0, pdfMatrix.e ?? 0, pdfMatrix.f ?? 0])
  value += ` ${form.graphic_state?.passthrough_per_char_instruction ?? ''} `
  const xobject = subtype.pdf_xobj_form
  if (xobject?.do_args) {
    return encoder.encode(`${value}/${xobject.do_args} Do Q\n`)
  }
  const inline = subtype.pdf_inline_form
  if (inline) {
    const head = encoder.encode(`${value}BI ${inlineParameters(inline.image_parameters)}ID `)
    const decoded = inline.form_data ? Buffer.from(inline.form_data, 'base64') : Buffer.alloc(0)
    const tail = encoder.encode(' EI Q\n')
    return concat([head, new Uint8Array(decoded), tail])
  }
  return encoder.encode(`${value}Q\n`)
}

function renderCurve(curve: ILPdfCurve): Uint8Array {
  let value = 'q n '
  if (curve.relocation_transform?.length === 6) value += matrix(curve.relocation_transform)
  if (curve.ctm?.length === 6) value += matrix(curve.ctm)
  const graphicState = curve.graphic_state?.passthrough_per_char_instruction ?? ''
  const fillColor = inspectNonStrokingColor(graphicState)
  value += ` ${graphicState} `
  if (pythonBool(curve.fill_background) && fillColor.lightNamedGray !== null) {
    value += `${printf6(fillColor.lightNamedGray as number)} g `
  }
  if (pythonBool(curve.passthrough_paint)) return encoder.encode(`${value}Q\n`)
  let path: string
  if (curve.pdf_original_path_primitive?.op === 're' && curve.pdf_original_path_primitive.args?.length === 4) {
    path = curve.pdf_original_path_primitive.args.map((argument) => printfF(argument)).join(' ') + ' re '
  } else {
    path = (curve.pdf_original_path ?? [])
      .map((entry) => entry.pdf_path)
      .filter((pdfPath): pdfPath is ILPdfPath => pdfPath !== undefined)
      .map(pathOperation)
      .join('')
  }
  if (pythonBool(curve.fill_background) && fillColor.hasColor) {
    value += path + (pythonBool(curve.evenodd) ? 'f* ' : 'f ')
  } else {
    value += ' '
  }
  if (pythonBool(curve.stroke_path)) value += `${path}S `
  return encoder.encode(`${value}n Q\n`)
}

function pathOperation(path: ILPdfPath): string {
  if (pythonBool(path.has_xy) && path.x !== undefined && path.y !== undefined) {
    return `${printfF(path.x)} ${printfF(path.y)} ${path.op ?? ''} `
  }
  return `${path.op ?? ''} `
}

function inlineParameters(json: string | undefined): string {
  if (!json) return ''
  let dictionary: Record<string, unknown>
  try {
    dictionary = JSON.parse(json) as Record<string, unknown>
  } catch {
    return ''
  }
  return Object.keys(dictionary).sort().map((key) => `/${key.startsWith('/') ? key.slice(1) : key} ${pdfToken(dictionary[key])} `).join('')
}

function pdfToken(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (value.startsWith('/')) return value
    return `(${value.replaceAll(')', '\\)')})`
  }
  if (Array.isArray(value)) return `[${value.map(pdfToken).join(' ')}]`
  return 'null'
}

interface NonStrokingColorInspection {
  hasColor: boolean
  lightNamedGray: number | null
}

function inspectNonStrokingColor(instruction: string): NonStrokingColorInspection {
  const result: NonStrokingColorInspection = { hasColor: false, lightNamedGray: null }
  const operands: string[] = []
  let usesNamedColorSpace = false

  for (const token of instruction.split(/\s+/).filter((piece) => piece.length > 0)) {
    if (!Number.isNaN(Number(token)) || token.startsWith('/') || token.startsWith('[') || token === ']') {
      operands.push(token)
      continue
    }
    switch (token) {
      case 'cs':
        usesNamedColorSpace = operands.length === 1 && operands[0].startsWith('/')
        result.lightNamedGray = null
        break
      case 'sc':
        result.hasColor = true
        if (usesNamedColorSpace && operands.length === 1) {
          const value = Number(operands[0])
          result.lightNamedGray = value >= 0.82 && value <= 0.99 ? value : null
        } else {
          result.lightNamedGray = null
        }
        break
      case 'scn':
        result.hasColor = true
        result.lightNamedGray = null
        break
      case 'g':
      case 'rg':
      case 'k':
        result.hasColor = true
        result.lightNamedGray = null
        usesNamedColorSpace = false
        break
      default:
        break
    }
    operands.length = 0
  }
  return result
}

function truthyDebug(value: PythonDebugInfo | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 0
  return false
}

export { makeSourceParagraphSnapshot, SourcePreservingPlanner, fontDirectory }
export type { SourcePreservingDocumentPlan, SourcePreservingPagePlan, ILPdfParagraph, ILPdfParagraphComposition, ILPdfStyle }
