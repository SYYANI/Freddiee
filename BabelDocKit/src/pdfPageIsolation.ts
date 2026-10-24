import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib'
import type { ILDocument } from './il'

/** Give pages their own copies of shared streams before the backend rewrites
 * them. Keep original object numbers elsewhere, including in cached IL. */
export async function isolateSharedPageStreams(pdf: Uint8Array, document: ILDocument): Promise<{ pdf: Uint8Array; document: ILDocument }> {
  const candidates = new Set((document.page ?? []).flatMap((page) =>
    (page.pdf_xobject ?? []).flatMap((object) => object.xref_id === undefined ? [] : [object.xref_id])))
  if (candidates.size === 0 || document.total_pages === 1) return { pdf, document }

  // ignoreEncryption only skips pdf-lib's refusal; it decrypts nothing. An
  // encrypted document must not be cloned at all — stream keys are bound to
  // the original object numbers — and MuPDF downstream opens permission-
  // protected files with an empty password, so fall back to the pre-isolation
  // order instead of failing after the LLM calls.
  const source = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true })
  if (source.isEncrypted) return { pdf, document }
  const context = source.context
  const pages = source.getPages()
  const resourcesKey = PDFName.of('Resources')
  const appearanceKey = PDFName.of('AP')
  const parents = new Map<PDFObject, Set<PDFObject>>()
  const users = new Map<PDFObject, Set<number>>()
  const references = new Map<number, PDFRef>()
  const roots = pages.map((page) => [
    page.node.Resources(),
    ...(page.node.Annots()?.asArray() ?? []).map((ref) => {
      const annotation = context.lookup(ref)
      return annotation instanceof PDFDict ? annotation.get(appearanceKey) : undefined
    })
  ].filter((object): object is PDFObject => object !== undefined))

  const children = (object: PDFObject): PDFObject[] => {
    if (object instanceof PDFRef) {
      const resolved = context.lookup(object)
      return resolved ? [resolved] : []
    }
    if (object instanceof PDFRawStream) return [object.dict]
    if (object instanceof PDFDict) return object.values()
    if (object instanceof PDFArray) return object.asArray()
    return []
  }
  for (const [pageIndex, pageRoots] of roots.entries()) {
    const visited = new Set<PDFObject>()
    const pending = [...pageRoots]
    while (pending.length > 0) {
      const object = pending.pop()!
      if (visited.has(object)) continue
      visited.add(object)
      if (object instanceof PDFRef && candidates.has(object.objectNumber)) {
        references.set(object.objectNumber, object)
        const pageUsers = users.get(object) ?? new Set<number>()
        pageUsers.add(pageIndex)
        users.set(object, pageUsers)
      }
      for (const child of children(object)) {
        const ancestors = parents.get(child) ?? new Set<PDFObject>()
        ancestors.add(object)
        parents.set(child, ancestors)
        pending.push(child)
      }
    }
  }

  let changed = false
  // Original → clone for annotations this isolation replaced. Their references
  // elsewhere must follow, or form fields and popups detach from the page.
  const clonedAnnotations = new Map<PDFObject, PDFRef>()
  const isolatedPages = (document.page ?? []).map((page) => {
    const pageIndex = page.page_number
    if (pageIndex === undefined || !pages[pageIndex]) return page
    const shared = (page.pdf_xobject ?? []).flatMap((object) => {
      const ref = object.xref_id === undefined ? undefined : references.get(object.xref_id)
      return ref && (users.get(ref)?.size ?? 0) > 1 ? [ref] : []
    })
    if (shared.length === 0) return page
    changed = true

    // Copy only streams that can be rewritten and the paths leading to them.
    // This also handles nested forms, shared resource dictionaries and cycles.
    const copies = new Set<PDFObject>()
    const pending: PDFObject[] = shared.flatMap((ref) => [ref, ...children(ref)])
    while (pending.length > 0) {
      const object = pending.pop()!
      if (copies.has(object)) continue
      copies.add(object)
      pending.push(...(parents.get(object) ?? []))
    }
    const cloned = new Map<PDFObject, PDFObject>()
    const copy = (object: PDFObject): PDFObject => {
      if (!copies.has(object)) return object
      const previous = cloned.get(object)
      if (previous) return previous
      if (object instanceof PDFRef) {
        const ref = context.nextRef()
        cloned.set(object, ref)
        context.assign(ref, copy(context.lookup(object)!))
        return ref
      }
      const result = object.clone(context)
      cloned.set(object, result)
      const originalDict = object instanceof PDFRawStream ? object.dict : object
      const resultDict = result instanceof PDFRawStream ? result.dict : result
      if (originalDict instanceof PDFDict && resultDict instanceof PDFDict) {
        for (const [key, value] of originalDict.entries()) {
          resultDict.set(key, key === resourcesKey ? copyResources(value) : copy(value))
        }
      } else if (object instanceof PDFArray && result instanceof PDFArray) {
        object.asArray().forEach((value, index) => result.set(index, copy(value)))
      }
      return result
    }
    const copyResources = (object: PDFObject): PDFObject => {
      const resources = context.lookup(copy(object))
      if (!(resources instanceof PDFDict)) return object
      const result = resources.clone(context)
      // Font registration adds entries in place, so this dictionary must also
      // belong to this page/form even when its existing fonts stay shared.
      const fontsKey = PDFName.of('Font')
      const fonts = resources.lookup(fontsKey)
      if (fonts instanceof PDFDict) result.set(fontsKey, fonts.clone(context))
      return result
    }
    const node = pages[pageIndex].node
    const resources = node.Resources()
    if (resources) node.set(resourcesKey, copyResources(resources))
    const annotations = node.Annots()
    if (annotations) {
      const isolated = annotations.clone(context)
      annotations.asArray().forEach((ref, index) => {
        // lookup returns a (non-conforming) inline annotation dictionary as is.
        const annotation = context.lookup(ref)
        if (!(annotation instanceof PDFDict)) return
        const appearance = annotation.get(appearanceKey)
        if (!appearance || !copies.has(appearance)) return
        const clonedAnnotation = annotation.clone(context)
        clonedAnnotation.set(appearanceKey, copy(appearance))
        const clone = context.register(clonedAnnotation)
        // Only indirect annotations can be referenced from AcroForm or a popup.
        if (ref instanceof PDFRef) clonedAnnotations.set(ref, clone)
        isolated.set(index, clone)
      })
      node.set(PDFName.of('Annots'), isolated)
    }
    return {
      ...page,
      pdf_xobject: page.pdf_xobject?.map((object) => {
        const original = object.xref_id === undefined ? undefined : references.get(object.xref_id)
        const ref = original && cloned.get(original)
        return ref instanceof PDFRef ? { ...object, xref_id: ref.objectNumber } : object
      })
    }
  })
  if (clonedAnnotations.size > 0) {
    // Widget annotations are also referenced from the AcroForm field tree, and
    // markup annotations reference their popups; repoint those references at
    // the clones so fields and popups stay attached to the annotation each
    // page actually shows.
    const remapIn = (dict: PDFDict, key: PDFName): void => {
      const value = dict.get(key)
      const mapped = value instanceof PDFRef ? clonedAnnotations.get(value) : undefined
      if (mapped) dict.set(key, mapped)
    }
    const parentKey = PDFName.of('Parent')
    const popupKey = PDFName.of('Popup')
    for (const clone of clonedAnnotations.values()) {
      const annotation = context.lookup(clone)
      if (annotation instanceof PDFDict) {
        remapIn(annotation, parentKey)
        remapIn(annotation, popupKey)
      }
    }
    const kidsKey = PDFName.of('Kids')
    const visitField = (reference: PDFObject): void => {
      const field = context.lookup(reference)
      if (!(field instanceof PDFDict)) return
      const kids = field.get(kidsKey)
      if (!(kids instanceof PDFArray)) return
      kids.asArray().forEach((kid, index) => {
        const mapped = clonedAnnotations.get(kid)
        if (mapped) kids.set(index, mapped)
        else visitField(kid)
      })
    }
    const acroForm = context.lookup(source.catalog.get(PDFName.of('AcroForm')))
    const fields = acroForm instanceof PDFDict ? acroForm.get(PDFName.of('Fields')) : undefined
    if (fields instanceof PDFArray) {
      fields.asArray().forEach((field, index) => {
        const mapped = clonedAnnotations.get(field)
        if (mapped) fields.set(index, mapped)
        else visitField(field)
      })
    }
  }
  return changed
    ? { pdf: await source.save({ useObjectStreams: false }), document: { ...document, page: isolatedPages } }
    : { pdf, document }
}
