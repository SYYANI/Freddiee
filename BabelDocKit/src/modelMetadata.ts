// Pinned DocLayout-YOLO metadata shared by preprocessing, detection and the
// class mapping. The model itself is the upstream BabelDOC ONNX asset pinned in
// resources/runtime-manifest.json.
export const BabelDocModelMetadata = {
  inputSize: 1024,
  defaultConfidenceThreshold: 0.25,
  labels: [
    'title', 'plain text', 'abandon', 'figure', 'figure_caption', 'table',
    'table_caption', 'table_footnote', 'isolate_formula', 'formula_caption'
  ]
} as const
