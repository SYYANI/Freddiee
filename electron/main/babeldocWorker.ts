import { parentPort, workerData } from 'node:worker_threads'
import {
  ILTranslationOutputError,
  createPipeline,
  echoesPromptEnvelope,
  type AsyncILTextTranslator,
  type ILTranslationContext
} from '../../BabelDocKit'
import type { BabelDocWorkerData, BabelDocWorkerEvent, BabelDocWorkerRequest } from './babeldocWorkerProtocol'

const port = parentPort
if (!port) throw new Error('BabelDOC worker requires a parent port.')

const data = workerData as BabelDocWorkerData
process.env.FREDDIE_APP_PATH = data.appPath

let requestID = 0
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
const cancellation = new AbortController()

port.on('message', (message: BabelDocWorkerRequest) => {
  if (message.type === 'cancel') {
    const reason = new DOMException('Translation cancelled', 'AbortError')
    cancellation.abort(reason)
    for (const request of pending.values()) request.reject(reason)
    pending.clear()
    return
  }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.type === 'translation_result') request.resolve(message.text)
  else request.reject(new Error(message.message))
})

const translator: AsyncILTextTranslator = {
  maximumConcurrentTranslations: data.maximumConcurrentTranslations,
  formulaPlaceholder: (id) => `[BABELDOC_FORMULA_${id}]`,
  translate: async (text) => translator.translateWithContext!(text, {}),
  async translateWithContext(text: string, context: ILTranslationContext): Promise<string> {
    cancellation.signal.throwIfAborted()
    const id = ++requestID
    const translated = await new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      port.postMessage({ type: 'translate', id, text, context } satisfies BabelDocWorkerEvent)
    })
    if (echoesPromptEnvelope(translated, text)) throw new ILTranslationOutputError()
    if (!translated.trim()) throw new Error('The translation service returned an empty response.')
    return translated.trim()
  }
}

void (async () => {
  try {
    const pipeline = createPipeline(data.pdf, data.pages, data.configuration, cancellation.signal)
    const onProgress = (progress: Parameters<NonNullable<Parameters<typeof pipeline.translatePDF>[1]>>[0]): void => {
      cancellation.signal.throwIfAborted()
      port.postMessage({ type: 'progress', progress } satisfies BabelDocWorkerEvent)
    }
    let result
    if (data.structuredDocument) {
      for (const [index, stage] of (['frontend', 'layout', 'paragraph', 'styles'] as const).entries()) {
        onProgress({ stage, stageCompleted: 1, stageTotal: 1, overallProgress: (index + 1) / 8 * 100 })
      }
      result = await pipeline.translateStructuredDocument(data.structuredDocument, translator, onProgress)
    } else {
      result = await pipeline.translatePDF(translator, onProgress, (document) => {
        port.postMessage({ type: 'structured_document', document } satisfies BabelDocWorkerEvent)
      })
    }
    const pdf = result.pdf
    port.postMessage(
      { type: 'result', pdf, diagnostics: result.diagnostics } satisfies BabelDocWorkerEvent,
      [pdf.buffer as ArrayBuffer]
    )
  } catch (error) {
    if (cancellation.signal.aborted) {
      port.postMessage({ type: 'cancelled' } satisfies BabelDocWorkerEvent)
      return
    }
    const value = error instanceof Error ? error : new Error(String(error))
    port.postMessage({ type: 'error', message: value.message, stack: value.stack } satisfies BabelDocWorkerEvent)
  }
})()
