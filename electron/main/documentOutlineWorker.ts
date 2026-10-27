import { parentPort, workerData } from 'node:worker_threads'
import type { DocumentOutlineWorkerData, DocumentOutlineWorkerEvent, DocumentOutlineWorkerResult } from './documentOutlineWorkerProtocol'
import { assessOutline, embeddedOutline, enrichOutlineFonts, heuristicOutline, latexOutline, pdfOutlinePages, scanOutline, withHeadingLocations } from './outlineExtraction'

const port = parentPort
if (!port) throw new Error('Document outline worker requires a parent port.')
const data = workerData as DocumentOutlineWorkerData

void (async () => {
  try {
    const pdfjs = await import(data.pdfjsModuleURL) as typeof import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: data.pdf, standardFontDataUrl: data.standardFontDataURL,
      cMapUrl: data.cMapURL, cMapPacked: true, wasmUrl: data.wasmURL, useSystemFonts: false })
    let result: DocumentOutlineWorkerResult
    try {
      const document = await task.promise
      const signal = new AbortController().signal
      const pages = await pdfOutlinePages(document, signal)
      const variants: DocumentOutlineWorkerResult['variants'] = []
      let goodEmbedded = false
      let preferredSource: DocumentOutlineWorkerResult['preferredSource']
      if (!data.candidatesOnly) {
        const raw = withHeadingLocations(await embeddedOutline(document, signal), pages)
        const assessment = assessOutline(raw, pages)
        goodEmbedded = assessment.isGood
        const same = JSON.stringify(raw) === JSON.stringify(assessment.repaired)
        if (raw.length) variants.push({ source: 'pdf', entries: raw })
        if (assessment.repaired.length && !same) variants.push({ source: 'repairedPDF', entries: assessment.repaired })
        if (goodEmbedded) preferredSource = same ? 'pdf' : 'repairedPDF'
        const latex = latexOutline(data.semanticHeadings, pages)
        if (latex.length) variants.push({ source: 'latex', entries: latex })
        const scan = data.scanSources.filter(({ pageIndex }) => pageIndex >= 0 && pageIndex < document.numPages)
          .flatMap(({ source, pageIndex }) => scanOutline(source, pageIndex))
        if (scan.length) variants.push({ source: 'scan', entries: scan })
      }
      const needsCandidates = data.candidatesOnly || data.generateAutomatic || !goodEmbedded
      if (needsCandidates) await enrichOutlineFonts(document, pages, signal)
      const candidates = needsCandidates ? heuristicOutline(pages) : []
      if (candidates.length >= 3) variants.push({ source: 'automatic', entries: candidates })
      preferredSource ??= (['latex', 'scan', 'automatic'] as const).find((source) => variants.some((variant) => variant.source === source))
      result = { variants, candidates, deferredCandidates: !needsCandidates, preferredSource }
    } finally { await task.destroy() }
    port.postMessage({ type: 'result', result } satisfies DocumentOutlineWorkerEvent)
  } catch (error) {
    port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies DocumentOutlineWorkerEvent)
  } finally { port.close() }
})()
