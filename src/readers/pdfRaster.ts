/** Fetch a registered page rendered outside the UI process; no paths or drawing commands cross the bridge. */
export async function rasterPdfPage(paperId: string, attachmentId: string, index: number, scale: number, ratio: number,
  paperTone: boolean, revision: string, signal: AbortSignal): Promise<HTMLCanvasElement | undefined> {
  const makeURL = window.freddie.shell?.pdfPageURL
  if (!makeURL) return undefined
  const response = await fetch(makeURL(paperId, attachmentId, index, scale, ratio, paperTone, revision), { signal })
  if (!response.ok) throw new Error(`PDF raster response ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  try {
    signal.throwIfAborted()
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d', { alpha: false })!.drawImage(bitmap, 0, 0)
    return canvas
  } finally { bitmap.close() }
}
