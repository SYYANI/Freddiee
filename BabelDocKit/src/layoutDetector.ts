// Layout detection on the upstream DocLayout-YOLO ONNX model. The model exports
// post-processed rows [x1, y1, x2, y2, score, class] with at most 300 entries,
// so the Swift two-stage anchor TopK (needed by the Core ML export of the same
// network) has no counterpart here: thresholding, class mapping, letterbox
// inverse and ordering mirror Swift LayoutDetector.detect exactly.
import * as ort from 'onnxruntime-node'
import { makeModelInput } from './imagePreprocessor'
import { BabelDocModelMetadata } from './modelMetadata'
import { LetterboxTransform, PageCoordinateConverter, type FloatBox, type IntSize } from './geometry'
import type { DocumentPageInput } from './documentLoader'

export interface LayoutDetection {
  id: number
  classIndex: number
  className: string
  confidence: number
  imageBox: FloatBox
  pdfBox: FloatBox | null
}

export interface PageLayoutResult {
  pageIndex: number
  sourcePageNumber: number
  sourcePixelSize: IntSize
  pdfPointSize: IntSize | null
  pdfMediaBox: FloatBox | null
  pdfCropBox: FloatBox | null
  rotationDegrees: number | null
  detections: LayoutDetection[]
}

export class BabelDocLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocLayoutError'
  }
}

let sessionPromise: Promise<ort.InferenceSession> | null = null

function onnxruntime(): typeof ort {
  return ort
}

async function layoutSession(modelPath: string): Promise<ort.InferenceSession> {
  sessionPromise ??= onnxruntime().InferenceSession.create(modelPath)
  return sessionPromise
}

/** One session per process; tests and workers each create their own. */
export function disposeLayoutSession(): void {
  sessionPromise = null
}

export interface LayoutDetectorConfiguration {
  modelPath: string
  confidenceThreshold?: number
}

export class LayoutDetector {
  readonly configuration: Required<LayoutDetectorConfiguration>

  constructor(configuration: LayoutDetectorConfiguration) {
    this.configuration = {
      modelPath: configuration.modelPath,
      confidenceThreshold: configuration.confidenceThreshold ?? BabelDocModelMetadata.defaultConfidenceThreshold
    }
  }

  get modelPath(): string {
    return this.configuration.modelPath
  }

  async detect(page: DocumentPageInput): Promise<PageLayoutResult> {
    const session = await layoutSession(this.configuration.modelPath)
    const input = makeModelInput(page.raster.rgb, page.raster.size)
    const output = await session.run({
      images: new ort.Tensor('float32', input.tensor, input.shape)
    })
    const tensor = output.output0
    if (!tensor || tensor.dims.length !== 3 || tensor.dims[0] !== 1) {
      throw new BabelDocLayoutError(`Unexpected layout tensor dimensions: ${JSON.stringify(tensor?.dims)}`)
    }
    const rows = tensor.dims[1]
    const data = tensor.data as Float32Array

    const detections: LayoutDetection[] = []
    for (let row = 0; row < rows; row += 1) {
      const offset = row * 6
      const confidence = data[offset + 4]
      if (!(confidence > this.configuration.confidenceThreshold)) continue
      const classIndex = Math.round(data[offset + 5])
      if (classIndex < 0 || classIndex >= BabelDocModelMetadata.labels.length) continue
      const imageBox = LetterboxTransform.scaleBoxToOriginal(input.transform, {
        x0: data[offset], y0: data[offset + 1], x1: data[offset + 2], y1: data[offset + 3]
      })
      detections.push({
        id: detections.length + 1,
        classIndex,
        className: BabelDocModelMetadata.labels[classIndex],
        confidence,
        imageBox,
        pdfBox: PageCoordinateConverter.imageBoxToPDFBox(imageBox, page.pdfPointSize)
      })
    }
    detections.sort((lhs, rhs) => (lhs.confidence === rhs.confidence ? lhs.id - rhs.id : rhs.confidence - lhs.confidence))
    const ordered = detections.map((detection, index) => ({ ...detection, id: index + 1 }))
    return {
      pageIndex: page.pageIndex,
      sourcePageNumber: page.sourcePageNumber,
      sourcePixelSize: page.sourcePixelSize,
      pdfPointSize: page.pdfPointSize,
      pdfMediaBox: page.pdfMediaBox,
      pdfCropBox: page.pdfCropBox,
      rotationDegrees: page.rotationDegrees,
      detections: ordered
    }
  }
}
