# RebuildPDFKit

Main-process implementation of scanned-PDF translation. It owns PDF page
rendering, multimodal transcription, constrained-LaTeX validation, per-page
checkpoints, XeLaTeX typesetting, fallback pages, and final PDF assembly.

Electron integration remains in `electron/main/translation.ts`; this top-level package
does not expose model credentials, filesystem paths, or process capabilities to
the renderer.
