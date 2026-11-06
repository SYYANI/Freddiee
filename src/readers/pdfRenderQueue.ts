interface RenderJob {
  run: () => Promise<void>
  priority: number
  resolve: () => void
  reject: (error: unknown) => void
}

export interface QueuedPdfRender {
  promise: Promise<void>
  /** Removes pending work. The owner must also cancel any running PDF.js task. */
  cancel(): void
  setPriority(priority: number): void
}

/** A bounded number of pages at a time across both panes, with on-screen pages ahead of prefetch work. */
export class PdfRenderQueue {
  private pending: RenderJob[] = []
  private running = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly concurrency = 1) {}

  enqueue(run: () => Promise<void>, priority: number): QueuedPdfRender {
    let job: RenderJob
    const promise = new Promise<void>((resolve, reject) => {
      job = { run, priority, resolve, reject }
      this.pending.push(job)
    })
    this.schedule()
    return {
      promise,
      cancel: () => {
        const index = this.pending.indexOf(job)
        if (index < 0) return
        this.pending.splice(index, 1)
        job.resolve()
      },
      setPriority: (next) => { job.priority = next }
    }
  }

  private schedule(): void {
    if (this.running >= this.concurrency || this.timer !== undefined || !this.pending.length) return
    // Collect this render's requests and give input/painting a turn between pages.
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.pending.sort((a, b) => a.priority - b.priority)
      const job = this.pending.shift()
      if (!job) return
      this.running += 1
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.running -= 1
        this.schedule()
      })
      this.schedule()
    }, 0)
  }
}

/** Runs one task at a time, in call order; a failed task does not stop later ones. */
export class PdfExclusive {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

// Bitmaps come from the main process's two raster workers; the renderer only waits for them, so two
// requests are in flight, one for each worker.
export const pdfRenderQueue = new PdfRenderQueue(2)
// The browser fallback draws on this thread. It stays one page at a time across both panes.
export const pdfBrowserRaster = new PdfExclusive()
// Text measurement can take much longer than painting on translated figures. Its cooperative
// batches must not hold the bitmap queue and leave the other pane blank.
export const pdfTextQueue = new PdfRenderQueue()
