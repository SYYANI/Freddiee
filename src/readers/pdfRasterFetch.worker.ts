// Receives a page's raw pixels and makes the bitmap off the UI thread: a page is several megabytes,
// and reading and copying it there delayed scrolling frames. Only URLs from the preload come in.
import { fetchRasterBitmap } from './pdfRasterImage'

export type RasterFetchRequest = { type: 'fetch'; id: number; url: string } | { type: 'cancel'; id: number }
export type RasterFetchReply = { id: number; bitmap: ImageBitmap } | { id: number; error: string }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RasterFetchRequest>) => void) | null
  postMessage(message: RasterFetchReply, transfer?: Transferable[]): void
}
const requests = new Map<number, AbortController>()

scope.onmessage = ({ data }) => {
  if (data.type === 'cancel') {
    requests.get(data.id)?.abort()
    return
  }
  const controller = new AbortController()
  requests.set(data.id, controller)
  void fetchRasterBitmap(data.url, controller.signal).then(
    (bitmap) => {
      if (controller.signal.aborted) bitmap.close()
      else scope.postMessage({ id: data.id, bitmap }, [bitmap])
    },
    (error: unknown) => { if (!controller.signal.aborted) scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }) }
  ).finally(() => requests.delete(data.id))
}
