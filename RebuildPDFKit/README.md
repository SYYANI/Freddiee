# RebuildPDFKit

Scanned-PDF translation for Freddie: a TypeScript port of the Swift `RebuildPDFKit` from the
rebuild-pdf project (`Sources/RebuildPDFKit`), which native Freddie uses. It runs
in the Electron main process on macOS, Windows and Linux.

Each page is rendered at 240 DPI, measured with OCR, transcribed by a vision model into
constrained LaTeX, proofread against the scan, translated with math and code protected,
and typeset by XeLaTeX on the original page geometry. Pages that fail keep the scan. Every
model answer and page state is checkpointed under the paper's `Resources/ScanRebuild`, so
an interrupted or repeated run only pays for unfinished pages, and a hand-edited
`typeset/page-NNNN.page.tex` wins over model output.

## Layout

| File | Swift original |
| --- | --- |
| `src/pattern.ts` | `Pattern.swift`: ICU/Python regex semantics (`\w`, `\d`, `\b` are Unicode-aware) and Python string/number helpers |
| `src/markup.ts` | `PageMarkup.swift` |
| `src/lineBreaks.ts`, `src/lineMetrics.ts` | `LineBreaks.swift`, `LineMetrics.swift` (PyMuPDF advance tables in `resources/line-metrics.bin.b64`) |
| `src/geometry.ts`, `src/documentLayout.ts` | `PageGeometry.swift`, `DocumentLayout.swift` |
| `src/bitmap.ts`, `src/pdf.ts` | `Bitmap.swift`, with PDF.js and `@napi-rs/canvas` in place of CoreGraphics |
| `src/figures.ts` | `Figures.swift` |
| `src/texSource.ts`, `src/xelatex.ts`, `src/texCheck.ts` | `TeXSource.swift`, `XeLaTeX.swift`, `TeXInstallationCheck.swift` |
| `src/coverage.ts` | `Coverage.swift` |
| `src/translation.ts`, `src/translationLayout.ts` | `Translation.swift`, `TranslationLayout.swift` |
| `src/model.ts`, `src/prompts.ts` | `ModelClient.swift`, `Prompts.swift` (prompts copied byte for byte into `resources/prompts`) |
| `src/pipeline.ts` | `RebuildPipeline.swift` |
| `src/textRecognition.ts` | `TextRecognition.swift`: Tesseract instead of Apple Vision |
| `index.ts` | native Freddie's `ScannedPDFTranslationService` and model client |

Platform substitutions:

- **OCR**: Apple Vision is macOS-only. The port uses Tesseract (bundled `tesseract.js` with the
  English LSTM model, offline), grouped into lines exactly as rebuild-pdf's Python reference
  does (`tesseract --psm 3`, lines split at gaps wider than 2.5 word heights).
- **Rendering**: PDF.js with `@napi-rs/canvas` renders pages and 400-DPI figure crops, and
  reads text positions for column-balance checks; pdf-lib assembles the output.
- **XeLaTeX**: started with `spawn` and no shell, `-no-shell-escape`, `openin_any=p` and
  `openout_any=p`; a cancelled or timed-out compile is stopped with its children (a tree kill on
  Windows). TeX Live and MiKTeX are found on PATH or in their default install folders.

## Parity

`npm test` runs the upstream checks:

- `tests/rebuild-parity.test.ts` compares the port with values computed by the Python package
  (`tests/fixtures/rebuild-pdf/parity.json`): prompts, markup, line breaks, line widths,
  measurement, document layouts, byte-identical `main.tex`, translation protection and
  restoration, coverage, column breaks, vertical gaps, figure frames and snapping.
- `tests/rebuild-kit.test.ts`, `tests/rebuild-typeset.test.ts` and
  `tests/rebuild-pipeline.test.ts` port the Swift markup, figure, checkpoint, XeLaTeX and
  pipeline suites (XeLaTeX suites are skipped when XeLaTeX is missing).
- `tests/rebuild-replay.test.ts` rebuilds real scans from saved model answers when the
  rebuild-pdf corpus is next to this repository (or at `REBUILD_SCAN_CORPUS`).

Given the same OCR lines, the port produces the same layouts, page markup and `main.tex` as
the Swift kit. Refresh the upstream-owned prompts, metrics and fixtures with
`npm run sync:rebuild -- /path/to/rebuild-pdf`.

## Packaging

tesseract.js runs its WebAssembly engine in a worker thread, which cannot read inside
`app.asar`, so `package.json` unpacks it with its dependencies. In Node it always loads the
combined (legacy + LSTM) core, so only the `-lstm` builds and the legacy language data are left
out of the package.
