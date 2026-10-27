import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { pdfjsResourceBase } from './pdfjsResources'
import type { DocumentOutlineWorkerData, DocumentOutlineWorkerEvent, DocumentOutlineWorkerInput, DocumentOutlineWorkerResult } from './documentOutlineWorkerProtocol'

export type DocumentOutlineWorkerRunner = (input: DocumentOutlineWorkerInput, signal: AbortSignal) => Promise<DocumentOutlineWorkerResult>

/** One short-lived worker per extraction. Termination also cancels a synchronous PDF.js stage. */
export function runDocumentOutlineWorker(input: DocumentOutlineWorkerInput, signal: AbortSignal,
  workerPath = join(__dirname, 'documentOutlineWorker.cjs')): Promise<DocumentOutlineWorkerResult> {
  signal.throwIfAborted()
  const resources = dirname(require.resolve('pdfjs-dist/package.json')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const data: DocumentOutlineWorkerData = { ...input,
    pdfjsModuleURL: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
    standardFontDataURL: pdfjsResourceBase(join(resources, 'standard_fonts')),
    cMapURL: pdfjsResourceBase(join(resources, 'cmaps')),
    wasmURL: pdfjsResourceBase(join(resources, 'wasm')) }
  const worker = new Worker(workerPath, { workerData: data, transferList: [input.pdf.buffer as ArrayBuffer] })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result?: DocumentOutlineWorkerResult, error?: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      // Wait for termination before settling, so shutdown and per-paper queues cannot
      // leave a parser behind or overlap the cancelled parser with its successor.
      void worker.terminate().then(() => {
        if (signal.aborted) reject(signal.reason ?? new DOMException('Outline cancelled', 'AbortError'))
        else if (error !== undefined) reject(error)
        else resolve(result!)
      }, reject).finally(() => worker.removeAllListeners())
    }
    const abort = (): void => finish(undefined, signal.reason ?? new DOMException('Outline cancelled', 'AbortError'))
    worker.once('message', (message: DocumentOutlineWorkerEvent) => {
      if (message.type === 'result') finish(message.result)
      else finish(undefined, new Error(message.message))
    })
    worker.once('error', (error) => finish(undefined, error))
    worker.once('exit', (code) => finish(undefined, new Error(`Document outline worker stopped with exit code ${code}.`)))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
