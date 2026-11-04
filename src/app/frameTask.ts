/** Coalesces high-frequency input while preserving the final position on pointer-up. */
export function frameTask<T extends unknown[]>(run: (...args: T) => void): { schedule: (...args: T) => void; flush: () => void; cancel: () => void } {
  let frame: number | undefined
  let latest: T | undefined
  const cancel = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    latest = undefined
  }
  const flush = (): void => {
    const args = latest
    cancel()
    if (args) run(...args)
  }
  return {
    schedule: (...args) => {
      latest = args
      frame ??= requestAnimationFrame(flush)
    },
    flush,
    cancel
  }
}
