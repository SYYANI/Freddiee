// Model input preparation: letterbox to 1024 with grey 114 fill, an OpenCV-style
// bilinear resize (the Swift pipeline's own implementation), then BGR CHW /255.
// Swift computes in Float32 throughout; Math.fround reproduces the same values.
import { LetterboxTransform, type FloatBox, type IntSize, type LetterboxTransform as Transform } from './geometry'
import { BabelDocModelMetadata } from './modelMetadata'

const f = Math.fround

export interface ModelInput {
  tensor: Float32Array
  shape: [number, number, number, number]
  transform: Transform
}

function resizeBilinearLikeOpenCV(source: Uint8Array, sourceSize: IntSize, outputSize: IntSize): Uint8Array {
  const { width: sw, height: sh } = sourceSize
  const { width: ow, height: oh } = outputSize
  if (sw === ow && sh === oh) return source
  const scaleX = f(f(sw) / f(ow))
  const scaleY = f(f(sh) / f(oh))
  const info = (coordinate: number, size: number) => {
    let lower = Math.floor(coordinate)
    let weight = f(coordinate - f(lower))
    if (lower < 0) { lower = 0; weight = 0 }
    if (lower >= size - 1) { lower = size - 1; weight = 0 }
    return { lower, upper: Math.min(lower + 1, size - 1), weight }
  }
  const roundToByte = (value: number) => {
    const rounded = Math.round(value)
    return Math.max(0, Math.min(255, rounded | 0))
  }
  const output = new Uint8Array(ow * oh * 4)
  for (let y = 0; y < oh; y += 1) {
    const sourceY = f(f(f(f(y) + 0.5) * scaleY) - 0.5)
    const rows = info(sourceY, sh)
    for (let x = 0; x < ow; x += 1) {
      const sourceX = f(f(f(f(x) + 0.5) * scaleX) - 0.5)
      const columns = info(sourceX, sw)
      const topLeft = ((rows.lower * sw) + columns.lower) * 4
      const topRight = ((rows.lower * sw) + columns.upper) * 4
      const bottomLeft = ((rows.upper * sw) + columns.lower) * 4
      const bottomRight = ((rows.upper * sw) + columns.upper) * 4
      const target = ((y * ow) + x) * 4
      const oneMinusX = f(1 - columns.weight)
      const oneMinusY = f(1 - rows.weight)
      for (let channel = 0; channel < 4; channel += 1) {
        const top = f(f(f(source[topLeft + channel] * oneMinusX)) + f(f(source[topRight + channel]) * columns.weight))
        const bottom = f(f(f(source[bottomLeft + channel] * oneMinusX)) + f(f(source[bottomRight + channel]) * columns.weight))
        output[target + channel] = roundToByte(f(f(f(top * oneMinusY)) + f(f(bottom) * rows.weight)))
      }
    }
  }
  return output
}

/** RGB top-left raster (MuPDF pixmap) to the 1x3x1024x1024 float tensor. */
export function makeModelInput(rgb: Uint8Array, size: IntSize, targetSize: number = BabelDocModelMetadata.inputSize): ModelInput {
  const transform = LetterboxTransform.fit(size, targetSize)
  const rgba = new Uint8Array(size.width * size.height * 4)
  for (let pixel = 0; pixel < size.width * size.height; pixel += 1) {
    rgba[pixel * 4] = rgb[pixel * 3]
    rgba[pixel * 4 + 1] = rgb[pixel * 3 + 1]
    rgba[pixel * 4 + 2] = rgb[pixel * 3 + 2]
    rgba[pixel * 4 + 3] = 255
  }
  const resized = resizeBilinearLikeOpenCV(rgba, size, transform.resizedSize)
  const padded = new Uint8Array(targetSize * targetSize * 4).fill(114)
  for (let pixel = 0; pixel < targetSize * targetSize; pixel += 1) padded[pixel * 4 + 3] = 255
  const left = Math.trunc(transform.padX)
  const top = Math.trunc(transform.padY)
  for (let y = 0; y < transform.resizedSize.height; y += 1) {
    for (let x = 0; x < transform.resizedSize.width; x += 1) {
      const source = ((y * transform.resizedSize.width) + x) * 4
      const target = (((top + y) * targetSize) + left + x) * 4
      padded[target] = resized[source]
      padded[target + 1] = resized[source + 1]
      padded[target + 2] = resized[source + 2]
      padded[target + 3] = 255
    }
  }
  const plane = targetSize * targetSize
  const tensor = new Float32Array(plane * 3)
  for (let pixel = 0; pixel < plane; pixel += 1) {
    tensor[pixel] = f(f(padded[pixel * 4 + 2]) / 255.0)
    tensor[plane + pixel] = f(f(padded[pixel * 4 + 1]) / 255.0)
    tensor[plane * 2 + pixel] = f(f(padded[pixel * 4]) / 255.0)
  }
  return { tensor, shape: [1, 3, targetSize, targetSize], transform }
}

export type { FloatBox }
