// Geometry types and the letterbox transforms the layout pipeline shares. The
// float arithmetic mirrors the Swift Float (32-bit) math exactly through
// Math.fround, because the box mappings and histogram stages compare against
// Swift fixtures.

const f = Math.fround

export interface IntSize { width: number; height: number }

export interface FloatBox { x0: number; y0: number; x1: number; y1: number }

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value))
}

export interface LetterboxTransform {
  originalSize: IntSize
  resizedSize: IntSize
  targetSize: number
  scale: number
  padX: number
  padY: number
}

export const LetterboxTransform = {
  fit(originalSize: IntSize, targetSize: number): LetterboxTransform {
    const scale = f(Math.min(f(f(targetSize) / f(originalSize.width)), f(f(targetSize) / f(originalSize.height))))
    const resizedWidth = Math.round(f(f(originalSize.width) * scale))
    const resizedHeight = Math.round(f(f(originalSize.height) * scale))
    const padX = f(Math.trunc((targetSize - resizedWidth) / 2))
    const padY = f(Math.trunc((targetSize - resizedHeight) / 2))
    return {
      originalSize, resizedSize: { width: resizedWidth, height: resizedHeight },
      targetSize, scale, padX, padY
    }
  },

  scaleBoxToOriginal(transform: LetterboxTransform, box: FloatBox): FloatBox {
    const widthLimit = f(transform.originalSize.width - 1)
    const heightLimit = f(transform.originalSize.height - 1)
    return {
      x0: clamp(f(f(box.x0 - transform.padX) / transform.scale), 0, widthLimit),
      y0: clamp(f(f(box.y0 - transform.padY) / transform.scale), 0, heightLimit),
      x1: clamp(f(f(box.x1 - transform.padX) / transform.scale), 0, widthLimit),
      y1: clamp(f(f(box.y1 - transform.padY) / transform.scale), 0, heightLimit)
    }
  }
}

export const PageCoordinateConverter = {
  /** Image (top-left origin) to PDF page box (bottom-left origin), with the
   * project's int truncation, ±1 expansion and clamping. */
  imageBoxToPDFBox(imageBox: FloatBox, pageSize: IntSize): FloatBox {
    const widthLimit = f(pageSize.width - 1)
    const heightLimit = f(pageSize.height - 1)
    return {
      x0: clamp(f(Math.trunc(f(imageBox.x0 - 1))), 0, widthLimit),
      y0: clamp(f(Math.trunc(f(f(pageSize.height) - imageBox.y1 - 1))), 0, heightLimit),
      x1: clamp(f(Math.trunc(f(imageBox.x1 + 1))), 0, widthLimit),
      y1: clamp(f(Math.trunc(f(f(pageSize.height) - imageBox.y0 + 1))), 0, heightLimit)
    }
  }
}
