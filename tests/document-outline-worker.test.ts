import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runDocumentOutlineWorker } from '../electron/main/documentOutlineWorkerClient'
import type { DocumentOutlineWorkerInput } from '../electron/main/documentOutlineWorkerProtocol'
import { compileOutlineWorker } from './document-outline-worker-support'

let root: string, workerPath: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'freddie-outline-thread-'))
  workerPath = await compileOutlineWorker(root)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const input = (): DocumentOutlineWorkerInput => ({ pdf: new Uint8Array([37, 80, 68, 70]), candidatesOnly: false, generateAutomatic: false, semanticHeadings: [], scanSources: [] })
async function script(name: string, source: string): Promise<string> {
  const path = join(root, `${name}.cjs`)
  await writeFile(path, source)
  return path
}

describe('document outline worker lifecycle', () => {
  it('rejects before launching a worker when already cancelled', () => {
    const controller = new AbortController(); controller.abort()
    const data = input(), terminate = vi.spyOn(Worker.prototype, 'terminate')
    expect(() => runDocumentOutlineWorker(data, controller.signal, workerPath)).toThrow()
    expect(data.pdf.byteLength).toBe(4)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('terminates and awaits worker exit after a successful reply', async () => {
    const path = await script('success', `const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ type: 'result', result: {variants: [], candidates: [], deferredCandidates: false} });
      setInterval(() => {}, 1000);`)
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const data = input()
    await expect(runDocumentOutlineWorker(data, new AbortController().signal, path)).resolves.toEqual({ variants: [], candidates: [], deferredCandidates: false })
    expect(data.pdf.byteLength).toBe(0)
    expect(terminate).toHaveBeenCalledOnce()
    expect((terminate.mock.contexts[0] as Worker).threadId).toBe(-1)
  })

  it('handles reported errors, worker exceptions and exit without a reply without hanging', async () => {
    const cases = [
      ['reported', `require('node:worker_threads').parentPort.postMessage({ type:'error', message:'PDF could not be opened' });`, 'PDF could not be opened'],
      ['exception', `throw new Error('worker exception')`, 'worker exception'],
      ['exit', 'process.exit(0)', 'exit code 0']
    ]
    for (const [name, source, message] of cases) {
      await expect(runDocumentOutlineWorker(input(), new AbortController().signal, await script(name, source))).rejects.toThrow(message)
    }
  })

  it('cancels a synchronously busy parser while the parent event loop remains responsive', async () => {
    const ready = new SharedArrayBuffer(4)
    const path = await script('busy', `const {workerData} = require('node:worker_threads');
      Atomics.store(new Int32Array(workerData.ready), 0, 1);
      while (true) { Math.sqrt(Math.random()); }`)
    const controller = new AbortController(), terminate = vi.spyOn(Worker.prototype, 'terminate')
    const data = { ...input(), ready }
    const pending = runDocumentOutlineWorker(data, controller.signal, path)
    const rejection = expect(pending).rejects.toThrow('Outline cancelled')
    await vi.waitFor(() => expect(Atomics.load(new Int32Array(ready), 0)).toBe(1))
    let heartbeat = false
    await new Promise<void>((resolve) => setImmediate(() => { heartbeat = true; resolve() }))
    expect(heartbeat).toBe(true)
    controller.abort(new DOMException('Outline cancelled', 'AbortError'))
    await rejection
    expect((terminate.mock.contexts[0] as Worker).threadId).toBe(-1)
  })

  it('parses a many-page real PDF on the built worker without blocking parent timers', async () => {
    const pdf = await PDFDocument.create(), body = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    for (let i = 0; i < 200; i += 1) {
      const page = pdf.addPage([500, 700])
      page.drawText(`${i + 1} Methods`, { x: 30, y: 580, size: 16, font: bold })
      for (let line = 0; line < 15; line += 1) page.drawText('A body paragraph with several words and a period.', { x: 30, y: 530 - line * 20, size: 11, font: body })
    }
    const bytes = new Uint8Array(await pdf.save())
    let ticks = 0
    const interval = setInterval(() => { ticks += 1 }, 10)
    try {
      const result = await runDocumentOutlineWorker({ ...input(), pdf: bytes }, new AbortController().signal, workerPath)
      expect(result.candidates).toHaveLength(200)
      expect(result.candidates[199].pageIndex).toBe(199)
      expect(result.preferredSource).toBe('automatic')
      expect(ticks).toBeGreaterThan(3)
    } finally { clearInterval(interval) }
  }, 15000)
})
