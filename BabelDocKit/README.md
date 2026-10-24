# BabelDocKit

Layout-preserving PDF translation for born-digital PDFs, ported from the Swift
BabelDoc pipeline in [reWriteBabelDoc](../reWriteBabelDoc) (the `BabelDocIL` v1
contract and the Swift behavior are authoritative).

- **MuPDF 1.28.0 (project-patched) + zstd 1.5.7 + the unchanged `BabelDocMuPDFShim` static path**,
  compiled to one WebAssembly module with a pinned Emscripten toolchain. The
  frontend, rasterization and the source-preserving PDF backend all run inside
  the module; PDFs enter as bytes (MEMFS) and the module never touches the host
  filesystem.
- **DocLayout-YOLO layout detection** through `onnxruntime-node` 1.23.2, using
  the upstream BabelDOC ONNX model byte for byte. 1.23.2 is the last release
  whose npm package still carries all six platform binaries (darwin arm64/x64,
  linux x64/arm64, win32 x64/arm64); from 1.24 on darwin/x64 is missing.
- The TypeScript port of the ~14k-line Swift pipeline (layout post-processing,
  `DocumentIntermediateLayer`, paragraph, styles/formulas, typesetting,
  translation with placeholder protection, source-preserving plan) lives in
  `src/`; all pipeline stages and both PDF backends are ported and checked
  against Swift fixtures. See `docs/SWIFT_PARITY.md`.

## Layout

```
BabelDocKit/
  index.ts               kit facade re-exported by the main process
  src/                   TypeScript port of the Swift pipeline
  native/babeldoc_wasm.c wasm-only adapter feeding PDF bytes through MEMFS
  resources/
    wasm-manifest.json   pinned sources, toolchain, flags and product hashes
    runtime-manifest.json pinned layout model and target fonts
    wasm/                committed build products (babeldoc.wasm + JS glue (babeldoc.cjs))
    licenses/            MuPDF (AGPL-3.0), zstd, onnxruntime license texts
  runtime/               gitignored; synced model + fonts (extraResources)
```

## Building the wasm module

The products in `resources/wasm/` are committed, so packaging machines do not
need emsdk. Rebuilding (macOS or Linux) requires make, curl, tar, a host C
compiler and either `EMSDK_HOME` or emsdk on PATH (an emsdk is installed
automatically into `.build/wasm/emsdk` otherwise):

```sh
node scripts/build-babeldoc-wasm.mjs           # rebuild + update wasm-manifest.json
node scripts/build-babeldoc-wasm.mjs --check   # verify committed products
```

The module keeps MuPDF's embedded base14/CJK fallback fonts so rendering and
glyph metrics match the native libmupdf the Swift side uses; only non-PDF
document handlers (HTML/EPUB/XPS/SVG/…) are compiled out. The Emscripten stack
is 2 MB — the frontend extraction overflows the default 64 KB stack (see
`wasm-manifest.json` `build.stackSizeNote`).

## Runtime assets (model and fonts)

```sh
npm run sync:babeldoc
```

copies the pinned ONNX model and the 15 target fonts plus license files from a
`../reWriteBabelDoc` checkout into `BabelDocKit/runtime/`, verifying every
SHA-256 (a fixed HuggingFace URL is used as fallback when the checkout is
absent), and records the upstream commit in `runtime/UPSTREAM.json`. Every
`package:*` script validates this directory first and fails the build when
anything is missing, modified, extra or a symbolic link — the same strictness as
the Swift `BabelDocRuntime` verifier. At runtime the directory resolves to
`process.resourcesPath/babeldoc` (packaged; `extraResources`) or the repository
path (development); onnxruntime-node needs the model on a real filesystem path,
which is why these files are not inside the asar.

## Parity against the Swift implementation

Frontend IL v1 compares bit for bit when the Swift reference runs against a
`-ffp-contract=off` libmupdf.dylib (arm64 clang would otherwise contract float
operations that wasm never contracts; `scripts/build-babeldoc-parity-dylib.mjs`
builds that reference without touching the reWriteBabelDoc checkout).

`npm run sync:babeldoc -- --parity` regenerates `tests/fixtures/babeldoc/` with
the Swift harness in `scripts/babeldoc-parity/` (a SwiftPM package that depends
on the reWriteBabelDoc checkout by path): nine small PDFs, each with the
frontend IL, the Swift detections, and the IL after writeLayouts, fallback lines
and ParagraphFinder. The tests then hold:

- **frontend IL**: exact deep equality on every fixture (`babeldoc-parity.test.ts`);
- **writeLayouts / appendFallbackLines / ParagraphFinder**: exact deep equality
  on the fixed Swift detections — layout backend differences never propagate
  into the stage contract;
- **layout detection** (`babeldoc-layout.test.ts`): the wasm-rendered,
  onnxruntime-node inference matches the Swift Core ML detections by **IoU >=
  0.95, equal class, |delta confidence| <= 0.02**, with no extra or missing
  detections. These thresholds leave headroom for the two inference backends
  (same weights); recorded measurements on real papers sat far inside them
  (IoU 1.0000, delta confidence < 1e-4).

Known limitation: `loadPDFPages` takes the media/crop boxes from the frontend
IL, which on unrotated pages carries the crop box as the media box. For papers
whose crop box differs from the media box this diverges from Swift's Quartz
boxes (Swift itself notes the same quirk in `LayoutParser.writeLayouts`); the
parity corpus has no such pages, and the shim can export the true media box if
one appears.

LayoutContinuation, TableOfContentsDotLeader and CodeTextClassifier carry
unit/property tests ported from the Swift suites (`babeldoc-stages.test.ts`).

The Electron service runs the CPU-heavy pipeline in `babeldocWorker.cjs` and
keeps provider credentials and HTTP requests in the main process. Translation
text crosses a typed request/response bridge one paragraph at a time. A
structured-IL checkpoint is keyed by the source PDF, selected pages and layout
model, while the final PDF is atomically installed as a `babeldoc` attachment
only after a successful run. A page selection limits which pages are translated;
unselected pages stay in the output so the bilingual reader keeps matching page
indices. Checkpoint write failures are logged and translation continues without
the optional cache.

Stages 5-8 (`babeldoc-stage4-parity.test.ts` and
`babeldoc-translation-parity.test.ts`): StylesAndFormulas, semantic-hint
matching/enrichment, ILTranslator (including placeholder retry and continuation
chains), the source snapshot, Typesetting, the source-preserving plan and both
backends compare exactly on the fixture corpus. The backend PDFs compare as the
task contract defines:
identical object structure, identical decompressed streams (the embedded font
subset's `name` table excepted — MuPDF's TTF subsetter orders equal-sized name
records through qsort, whose tie behavior differs between macOS and wasm, so
the subset bytes and the MD5-derived six-letter prefix differ across platforms
while the table directory and glyph data stay identical), identical extracted
text, and raster renders at 144 dpi within 2/255 on ≥99.9% of pixels. The
parity reference dylib additionally builds with pkg-config disabled so MuPDF
bundles its own zlib/lcms exactly like the wasm module; system zlib would
deflate streams differently. musl prints negative zero as `-0.000000` where
macOS libc prints `0.000000`; the stream comparison canonicalizes that sign.

## Licenses

MuPDF is AGPL-3.0 and ships as bytecode in `resources/wasm/babeldoc.wasm`; the
corresponding source is the pinned MuPDF archive plus the patch recorded in
`resources/wasm-manifest.json` (apply with `scripts/build-babeldoc-wasm.mjs`).
zstd is BSD-3-Clause, onnxruntime is MIT, the DocLayout-YOLO ONNX model is
Apache-2.0 (converted by `wybxc/DocLayout-YOLO-DocStructBench-onnx` from
`juliozhao/DocLayout-YOLO-DocStructBench`), and the font licenses travel with
the fonts in `runtime/fonts/licenses`. License texts live in `resources/licenses`.
