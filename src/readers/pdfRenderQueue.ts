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

/** One page at a time across both panes, with on-screen pages ahead of prefetch work. */
export class PdfRenderQueue {
  private pending: RenderJob[] = []
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined

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
    if (this.running || this.timer !== undefined || !this.pending.length) return
    // Collect this render's requests and give input/painting a turn between pages.
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.pending.sort((a, b) => a.priority - b.priority)
      const job = this.pending.shift()
      if (!job) return
      this.running = true
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.running = false
        this.schedule()
      })
    }, 0)
  }
}

export const pdfRenderQueue = new PdfRenderQueue()
// Text measurement can take much longer than painting on translated figures. Its cooperative
// batches must not hold the bitmap queue and leave the other pane blank.
export const pdfTextQueue = new PdfRenderQueue()
