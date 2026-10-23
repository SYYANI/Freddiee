import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas'
import { PythonNumber, roundHalfAway } from './pattern'

/** An 8-bit RGB raster with the origin at the top-left, like a Pillow image. */
export class RGBImage {
  private grayCache?: Uint8Array

  /** `pixels` holds row-major RGB triples. */
  constructor(readonly width: number, readonly height: number, readonly pixels: Uint8Array) {
    if (pixels.length !== width * height * 3) throw new Error('pixel buffer does not match the image size')
  }

  static blank(width: number, height: number, fill = 255): RGBImage {
    return new RGBImage(width, height, new Uint8Array(width * height * 3).fill(fill))
  }

  /** RGBA drawn over white, as CoreGraphics composites an image onto a white canvas. */
  static fromRGBA(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): RGBImage {
    const pixels = new Uint8Array(width * height * 3)
    for (let index = 0; index < width * height; index += 1) {
      const alpha = rgba[index * 4 + 3]
      for (let channel = 0; channel < 3; channel += 1) {
        const value = rgba[index * 4 + channel]
        pixels[index * 3 + channel] = alpha === 255 ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255)
      }
    }
    return new RGBImage(width, height, pixels)
  }

  static fromCanvas(canvas: Canvas): RGBImage {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    return RGBImage.fromRGBA(canvas.width, canvas.height, data)
  }

  /** Decodes a PNG or JPEG file's bytes. */
  static async decode(bytes: Uint8Array): Promise<RGBImage> {
    const image = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, image.width, image.height)
    context.drawImage(image, 0, 0)
    return RGBImage.fromCanvas(canvas)
  }

  toCanvas(): Canvas {
    const canvas = createCanvas(Math.max(1, this.width), Math.max(1, this.height))
    const context = canvas.getContext('2d')
    const data = context.createImageData(Math.max(1, this.width), Math.max(1, this.height))
    for (let index = 0; index < this.width * this.height; index += 1) {
      data.data[index * 4] = this.pixels[index * 3]
      data.data[index * 4 + 1] = this.pixels[index * 3 + 1]
      data.data[index * 4 + 2] = this.pixels[index * 3 + 2]
      data.data[index * 4 + 3] = 255
    }
    context.putImageData(data, 0, 0)
    return canvas
  }

  /** JPEG bytes; `quality` from 0 to 100 as in Pillow. */
  async jpegData(quality: number): Promise<Uint8Array> {
    return new Uint8Array(await this.toCanvas().encode('jpeg', quality))
  }

  async pngData(): Promise<Uint8Array> {
    return new Uint8Array(await this.toCanvas().encode('png'))
  }

  /** `image.crop((left, top, right, bottom))`, clamped to the image. */
  cropped(left: number, top: number, right: number, bottom: number): RGBImage {
    const x0 = Math.max(0, Math.min(this.width, left))
    const y0 = Math.max(0, Math.min(this.height, top))
    const x1 = Math.max(x0, Math.min(this.width, right))
    const y1 = Math.max(y0, Math.min(this.height, bottom))
    const output = new Uint8Array((x1 - x0) * (y1 - y0) * 3)
    for (let row = 0; row < y1 - y0; row += 1) {
      const start = ((y0 + row) * this.width + x0) * 3
      output.set(this.pixels.subarray(start, start + (x1 - x0) * 3), row * (x1 - x0) * 3)
    }
    return new RGBImage(x1 - x0, y1 - y0, output)
  }

  /** Resized with high-quality interpolation. */
  resized(width: number, height: number): RGBImage {
    if (width <= 0 || height <= 0 || this.width === 0 || this.height === 0) return this
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(this.toCanvas(), 0, 0, width, height)
    return RGBImage.fromCanvas(canvas)
  }

  /** `image.thumbnail((maxWidth, maxHeight))`: shrink to fit, keeping the aspect ratio. */
  thumbnail(maxWidth: number, maxHeight: number): RGBImage {
    if (!(this.width > maxWidth || this.height > maxHeight)) return this
    const ratio = Math.min(maxWidth / this.width, maxHeight / this.height)
    return this.resized(Math.max(1, PythonNumber.round(this.width * ratio)), Math.max(1, PythonNumber.round(this.height * ratio)))
  }

  /** `ImageOps.autocontrast(image, cutoff=)` per channel; `cutoff` is a percentage cut from each end. */
  autocontrasted(cutoff: number): RGBImage {
    const output = new Uint8Array(this.pixels)
    for (let channel = 0; channel < 3; channel += 1) {
      const histogram = new Array<number>(256).fill(0)
      for (let index = channel; index < this.pixels.length; index += 3) histogram[this.pixels[index]] += 1
      const lookup = autocontrastTable(histogram, cutoff)
      if (!lookup) continue
      for (let index = channel; index < this.pixels.length; index += 3) output[index] = lookup[this.pixels[index]]
    }
    return new RGBImage(this.width, this.height, output)
  }

  /** Luma as Pillow's `convert("L")`: (299 R + 587 G + 114 B) / 1000, rounded. */
  grayscale(): Uint8Array {
    if (this.grayCache) return this.grayCache
    const gray = new Uint8Array(this.width * this.height)
    for (let index = 0; index < gray.length; index += 1) {
      const r = this.pixels[index * 3]
      const g = this.pixels[index * 3 + 1]
      const b = this.pixels[index * 3 + 2]
      gray[index] = (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16
    }
    this.grayCache = gray
    return gray
  }

  /** The mean HSV saturation (0-255), as `ImageStat.Stat(image.convert("HSV")).mean[1]`. */
  meanSaturation(): number {
    const count = this.width * this.height
    if (count <= 0) return 0
    let total = 0
    for (let index = 0; index < count; index += 1) {
      const r = this.pixels[index * 3]
      const g = this.pixels[index * 3 + 1]
      const b = this.pixels[index * 3 + 2]
      const high = Math.max(r, g, b)
      const low = Math.min(r, g, b)
      // Pillow: int(255 * (max - min) / max) in single precision.
      if (high > low) total += Math.trunc(Math.fround(Math.fround(Math.fround(high - low) / Math.fround(high)) * 255))
    }
    return total / count
  }
}

/** Pillow's autocontrast mapping for one band, or undefined when the band is flat. */
export function autocontrastTable(source: readonly number[], cutoff: number): Uint8Array | undefined {
  const histogram = [...source]
  const total = histogram.reduce((sum, value) => sum + value, 0)
  if (cutoff > 0) {
    // Remove `cutoff` percent from the dark end...
    let cut = Math.trunc(total * cutoff / 100)
    for (let level = 0; level < 256 && cut > 0; level += 1) {
      if (cut > histogram[level]) {
        cut -= histogram[level]
        histogram[level] = 0
      } else {
        histogram[level] -= cut
        cut = 0
      }
    }
    // ...and from the light end.
    cut = Math.trunc(total * cutoff / 100)
    for (let level = 255; level >= 0 && cut > 0; level -= 1) {
      if (cut > histogram[level]) {
        cut -= histogram[level]
        histogram[level] = 0
      } else {
        histogram[level] -= cut
        cut = 0
      }
    }
  }
  const low = histogram.findIndex((value) => value !== 0)
  let high = 255
  while (high >= 0 && histogram[high] === 0) high -= 1
  if (low < 0 || !(high > low)) return undefined
  const scale = 255 / (high - low)
  const offset = -low * scale
  const lookup = new Uint8Array(256)
  for (let level = 0; level < 256; level += 1) lookup[level] = Math.max(0, Math.min(255, Math.trunc(level * scale + offset)))
  return lookup
}

/** A one-band 8-bit raster. */
export class GrayImage {
  constructor(readonly width: number, readonly height: number, readonly pixels: Uint8Array) {}

  static from(image: RGBImage): GrayImage {
    return new GrayImage(image.width, image.height, image.grayscale())
  }

  /** The figure-crop cleanup: `autocontrast(cutoff=0.5)`, then near-white to white. */
  cleanedForPrint(): GrayImage {
    const histogram = new Array<number>(256).fill(0)
    for (const value of this.pixels) histogram[value] += 1
    const lookup = autocontrastTable(histogram, 0.5)
    const output = lookup ? this.pixels.map((value) => lookup[value]) : new Uint8Array(this.pixels)
    return new GrayImage(this.width, this.height, output.map((value) => value > 205 ? 255 : value))
  }

  async pngData(): Promise<Uint8Array> {
    const rgb = new Uint8Array(this.width * this.height * 3)
    this.pixels.forEach((value, index) => rgb.fill(value, index * 3, index * 3 + 3))
    return new RGBImage(this.width, this.height, rgb).pngData()
  }
}

export interface InkBox { left: number; top: number; right: number; bottom: number }

/** Ink pixels (darker than a threshold) with Pillow-style `getbbox` queries. */
export class InkMask {
  readonly width: number
  readonly height: number
  private readonly ink: Uint8Array

  constructor(image: RGBImage, threshold = 150) {
    this.width = image.width
    this.height = image.height
    this.ink = image.grayscale().map((value) => value < threshold ? 1 : 0)
  }

  /** `ink.crop(box).getbbox()` in crop coordinates, or undefined when the region has no ink. */
  boundingBox(left: number, top: number, right: number, bottom: number): InkBox | undefined {
    const x0 = Math.max(0, left)
    const y0 = Math.max(0, top)
    const x1 = Math.min(this.width, right)
    const y1 = Math.min(this.height, bottom)
    if (!(x0 < x1 && y0 < y1)) return undefined
    let minX = Number.MAX_SAFE_INTEGER
    let minY = Number.MAX_SAFE_INTEGER
    let maxX = -1
    let maxY = -1
    for (let y = y0; y < y1; y += 1) {
      const row = y * this.width
      for (let x = x0; x < x1; x += 1) {
        if (!this.ink[row + x]) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        maxY = y
      }
    }
    if (maxX < 0) return undefined
    // Coordinates relative to the crop's own origin, which Pillow places at (left, top).
    return { left: minX - left, top: minY - top, right: maxX + 1 - left, bottom: maxY + 1 - top }
  }

  /** `ink.crop(box).histogram()[255]`: the number of ink pixels in a region. */
  count(left: number, top: number, right: number, bottom: number): number {
    let total = 0
    const y0 = Math.max(0, top)
    const x0 = Math.max(0, left)
    for (let y = y0; y < Math.max(y0, Math.min(this.height, bottom)); y += 1) {
      const row = y * this.width
      for (let x = x0; x < Math.max(x0, Math.min(this.width, right)); x += 1) total += this.ink[row + x]
    }
    return total
  }
}

/** `split_rows`: cut a page into horizontal bands at the whitest rows near equal divisions. */
export function splitRows(image: RGBImage, parts: number): Array<{ top: number; bottom: number }> {
  const gray = image.grayscale()
  // Pillow's BOX resize to one column: the rounded mean of each row.
  const profile = new Array<number>(image.height)
  for (let row = 0; row < image.height; row += 1) {
    let total = 0
    for (let column = 0; column < image.width; column += 1) total += gray[row * image.width + column]
    profile[row] = image.width === 0 ? 255 : roundHalfAway(total / image.width)
  }
  const height = image.height
  const window = PythonNumber.round(height * 0.06)
  const cuts = [0]
  for (let index = 1; index < Math.max(parts, 1); index += 1) {
    const target = Math.trunc(height * index / parts)
    const low = Math.max(cuts[cuts.length - 1] + 1, target - window)
    const high = Math.min(height - 1, target + window)
    if (low >= high) {
      cuts.push(Math.max(cuts[cuts.length - 1] + 1, target))
      continue
    }
    // The whitest row; ties go to the row nearest the target, then the first such row.
    let best = low
    for (let row = low; row <= high; row += 1) {
      if (profile[row] > profile[best] || (profile[row] === profile[best] && -Math.abs(row - target) > -Math.abs(best - target))) best = row
    }
    cuts.push(best)
  }
  cuts.push(height)
  return cuts.slice(1).map((bottom, index) => ({ top: cuts[index], bottom }))
}
