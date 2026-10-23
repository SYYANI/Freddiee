# LaTeXTransKit

Main-process implementation of the arXiv LaTeX pipeline. It owns secure source
archive extraction, BabelDOC semantic documents, protected-token translation,
credential-free checkpoints, translated-source packaging, and XeLaTeX
compilation.

Electron integration remains in `electron/main/translation.ts`; this top-level package
does not expose filesystem or process capabilities to the renderer.
