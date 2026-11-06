/** Width and height (little-endian uint32) precede the straight RGBA rows; see electron/main/pdfRasterFormat.ts. */
const headerBytes = 8

/** Fetches a registered page's raw raster image and makes it a bitmap, on whichever thread calls it. */
export async function fetchRasterBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`PDF raster response ${response.status}`)
  const data = await response.arrayBuffer()
  const header = new DataView(data, 0, Math.min(headerBytes, data.byteLength))
  const width = data.byteLength >= headerBytes ? header.getUint32(0, true) : 0
  const height = data.byteLength >= headerBytes ? header.getUint32(4, true) : 0
  if (!width || !height || data.byteLength !== headerBytes + width * height * 4) throw new Error('Invalid PDF raster image')
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(data, headerBytes), width, height))
  if (signal.aborted) {
    bitmap.close()
    signal.throwIfAborted()
  }
  return bitmap
}
