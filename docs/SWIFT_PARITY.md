# Swift Freddie parity map

| Native Freddie | Cross-platform implementation |
|---|---|
| SwiftData models (Paper, PaperAttachment, Note, PaperFolder, memberships, item types, ReadingState, LLM profiles, AppSettings) | Versioned `library.json` with the same entities and identifiers |
| Application Support `ReadPaper/Library/{UUID}` | Application data `Freddie/Library/{UUID}`; *Import Library from Freddie for macOS* copies the native one |
| Keychain API keys | Electron `safeStorage`, per provider |
| `LLMDefaultProfiles` (OpenAI, DeepSeek, Anthropic) | Same built-in providers and models, same IDs, quick setup |
| `OpenAICompatibleLLMProvider` (Responses, Chat Completions, Anthropic Messages, web search, streaming) | `llm.ts` with the same three protocols |
| `ContentView` three columns, floating sidebar, inspector | `MainWindow`: sidebar panel, reader column, inspector, resizable |
| `LibrarySidebarView` folders, filter bar, context menus | `LibrarySidebar` with native menus via the main process |
| `ReaderPaneView` toolbar (HTML/PDF, Original/Bilingual/Translated, tools, find, add note, translate, share, inspector) | `ReaderPane` with the same items and states |
| `PDFReaderView` (PDFKit), `DualPDFReaderView`, `PDFSidenoteRail` | PDF.js `PdfView`, `DualPdfView` with leader/follower sync, `SidenoteRail` |
| `HTMLReaderView` (WKWebView), display modes, typography, sidenotes, region editing | Script-free sandboxed frame driven by `HtmlView`, same CSS |
| `HTMLLocalizer` + `swift-readability` | `localizer.ts` with Mozilla Readability and the same `rp-readability-*` document shell |
| `HTMLTranslationPipeline`, `AcademicTranslationPrompt`, `TranslationOutputValidator` | `translation.ts` with the same prompt (`academic-v3`), placeholders, and validation |
| Bundled native BabelDOC helper | `BabelDocKit/` TypeScript + wasm port with worker-thread service integration, main-process model RPC, stage diagnostics, checkpoints and replace-at-end attachments |
| `LaTeXTranslationService` with the Swift `LaTeXTransKit` | `LaTeXTransKit/` port with the same prompts, templates, checkpoints, preamble policies and latexmk diagnostics |
| `SelectionAssistantOverlay` / `Orchestrator` / `Service` | `SelectionAssistant` overlay and `AssistantService` with the same prompt |
| PDF annotations (PDFKit) and export | Overlay annotations and pdf-lib export |
| `WritingPaneView`, `WritingWindow`, `MarkdownLiveSyntax`, `PaperCitation` | `WritingPane`, Writing window, CodeMirror live Markdown, same `readpaper://` links |
| `InspectorPaneView` (item type, authors, abstract translation, notes, writings) | `Inspector` with the same sections |
| `SettingsView` tabs | `SettingsWindow` with the same six tabs and forms |
| `BrowserClipperServer`, `BrowserClipImporter` (browser extension API) | `clipperServer.ts`, `browserClip.ts` and `PaperImporter.importClip`: same port, routes, checks and clip rules |
| `PaperDigestExportPolicy` | `shared/digest.ts` with the same template and placeholders |
| `TranslationActivityCapsule`, toasts, setup notice | Same overlays |
| `Localizable.xcstrings` (en, zh-Hans) | The catalog is reused as `shared/locales/zh-Hans.json` |
| `PaperTheme` Paper Tone, light-only interface | Same colors and PDF color matrix, light-only |

## Additional cross-platform pipelines

- arXiv LaTeX translation lives in the top-level `LaTeXTransKit/` package, a TypeScript port of the Swift `LaTeXTransKit` and of native Freddie's `LaTeXTranslationService`, checked against fixtures and real arXiv sources recorded from the Swift kit. Checkpoints and workspaces are keyed as in native Freddie; see `LaTeXTransKit/README.md`.
- Scanned-PDF translation lives in the top-level `RebuildPDFKit/` package, a TypeScript port of the Swift `RebuildPDFKit` checked against its Python-computed parity fixtures. Tesseract (tesseract.js) stands in for Apple Vision and PDF.js for CoreGraphics, so it runs on every platform; see `RebuildPDFKit/README.md`.
- Born-digital PDF translation lives in `BabelDocKit/`. The reader offers the
  worker-backed BabelDOC route for PDFs with a text layer, `RebuildPDFKit` for
  scans, and the opt-in `LaTeXTransKit` route for arXiv papers.

## Not yet ported

- TeX typesetting inside HTML pages that ship raw TeX (`HTMLTeXRendering` / Temml).
- The native app's per-selection assistant history markers in the reader and the web-search trace panel in Settings.
