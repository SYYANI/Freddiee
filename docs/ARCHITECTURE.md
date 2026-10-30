# Architecture

## Process boundary

```text
React renderer (sandboxed, one per window: main, Settings, Writing, About)
  │ named, typed operations through the preload bridge
  ▼
Electron main process
  ├─ FreddieStore        library.json (schema 6), monotonic migrations, atomic writes
  ├─ SecretStore         per-provider API keys encrypted with safeStorage
  ├─ PaperImporter       arXiv / web page / local PDF ingestion with staged progress
  ├─ localizer           Readability extraction, sanitizing, resource localization
  ├─ TranslationService  HTML, BabelDOC, LaTeX, scanned-PDF and abstract translation routes
  │    └─ BabelDOC worker  MuPDF wasm + ONNX layout + IL stages; translation RPC only
  ├─ BabelDocKit         TypeScript pipeline; wasm/glue in asar, model/fonts in extraResources
  ├─ LaTeXTransKit       port of the Swift kit: secure arXiv extraction, structured units, slot templates, latexmk
  ├─ RebuildPDFKit       scanned PDFs: Tesseract measurement, vision transcription, review, translation, XeLaTeX
  ├─ AssistantService    retrieval, prompts, streaming answers, saved conversations
  ├─ DocumentOutlineService cached outlines and opt-in AI organization
  │    └─ Outline worker PDF parsing, bookmark assessment/repair, cached LaTeX/scan alignment and heuristics; no credentials
  ├─ AnnotationStore     PDF annotations in native Freddie's sidecar format, annotated-PDF export
  ├─ WritingStore        Markdown writings in Writings/{id}
  ├─ clipperServer       browser-extension API on 127.0.0.1:23240 (ping, folders, save)
  ├─ nativeLibrary       read-only import from native Freddie (macOS)
  ├─ SyncController      library sync with a self-hosted Freddie Sync Server, same protocol and documents as native Freddie
  ├─ windowsBackdrop     Electron Acrylic on Windows 11 22H2+; Koffi-bound SetWindowCompositionAttribute blur on Windows 10 1809+, opaque on failure
  └─ freddie://          contained, read-only delivery of paper and writing files
```

This applies the DeepSeek Harness desktop separation to a document application: Electron packages the complete web client, while the privileged process owns native integrations. The renderer needs no listening port: the narrow IPC facade and the custom read-only protocol give the same separation with a smaller attack surface. The one port is the browser clipper's, for the extension in native Freddie's repository (`BrowserExtension/`); it is the same API on the same port as native Freddie, so one extension works with either app, and whichever starts first owns the port.

The windows match native Freddie's scenes. Each is the same renderer bundle opened with a route (`main`, `settings`, `writing`, `about`) and, on Windows, whether a native backdrop is active, both passed through `additionalArguments`. Main-process changes are broadcast as `library:changed`, and every window reloads its snapshot from the main-process authority.

## Security invariants

1. Renderers have no Node integration and run with Chromium sandboxing and context isolation.
2. Every IPC handler verifies that the sender is one of the app's own windows; arguments are validated in the main process (identifiers must be UUIDs, settings are allow-listed and type-checked).
3. The preload exposes operations, never generic `invoke`, filesystem, or process APIs. Dropped files are resolved with `webUtils.getPathForFile`, and the importer only accepts files that start with a PDF header.
4. `freddie://paper/{id}/a/{attachment}` serves registered attachments; `Resources/` serves localized page resources. Every path is resolved below the paper's UUID directory. `freddie://writing/{id}/assets/...` serves writing images the same way. `freddie://pdfjs/` serves only allow-listed PDF.js CMap and standard-font filenames from the packaged dependency so translated CJK PDFs render correctly.
5. Imported HTML is sanitized on import (scripts, frames, forms, event handlers, and `javascript:` URLs removed) and displayed in a `srcdoc` frame with `sandbox="allow-same-origin"` and no script permission, under the renderer's CSP plus its own. The reader script drives the page from outside.
6. External navigation is denied in-app; HTTP(S) links open through the OS browser, and arXiv links offer an import first.
7. Model requests are made from the main process. BabelDOC's worker receives
   PDF bytes, resource paths, non-secret settings and individual translation
   results through a typed RPC; it never receives a provider route or API key.
   The only subprocesses are the TeX tools and the native-library `sqlite3`, all
   started without a shell and never given an API key.
8. API keys remain in the main process and are encrypted by the operating system.
9. The native-library import runs the system `sqlite3` with a read-only URI and copies files; it never writes to the native store.
10. arXiv source extraction rejects traversal, links, special files, oversized archives, and excessive file counts. TeX subprocesses run without shell escape and with paranoid TeX input/output restrictions.
11. The clipper server listens on 127.0.0.1 only and answers a request only if it carries the `X-Freddie-Clipper` header (a web page cannot send it without a CORS preflight, which is never approved), a `Host` of `127.0.0.1` or `localhost` with the port (DNS rebinding), and no `Origin` other than an extension's. It sends no CORS headers. Bodies are capped at 140 MB and parsed field by field (`parseBrowserClip`) before the importer sees them; folder IDs must be UUIDs. Saving goes through the same importer, localizer and sanitizer as an import by URL. "Open in Freddie" in the extension opens the link the save answered with (`openURL`) instead of asking the server; on macOS that is `freddie-general://paper/{id}`, because native Freddie also handles `readpaper://` and only one app can be its handler, and this app claims only its own scheme at launch so it never takes `readpaper://` from native Freddie: the browser hands focus to the app that opens a link, while an app in the background cannot bring itself forward. On Windows and Linux, packaged builds hold the single-instance lock, so such a link reaches the running app through `second-instance` instead of starting a second process on the same library.
12. Library sync talks only to the HTTPS server named in a device credential the user imports; there is no built-in server. The credential file is read in the main process, its server is confirmed before anything is uploaded to a new address, and the token is encrypted with `safeStorage` beside the API keys. Requests never follow redirects and send no cookies. Received documents are size-limited and checked before use, and every synced path is resolved below its paper or writing folder, refusing traversal, reserved names and links (`sync/paths.ts`).
13. Scanned-page model output is parsed as constrained `<page>` markup: environments are allow-listed and checked, and file access, macro definition, `^^` character codes, `\csname` and similar commands are rejected before XeLaTeX runs (without shell escape, with paranoid file access). Tesseract runs offline from the packaged English model.

## Persistence

`library.json` is intentionally portable and inspectable. Writes are serialized through one queue and replace the file through a flushed temporary file and a rename. `schemaVersion` is monotonic; `migrateDatabase` brings schemas 1–2 (file names on papers, one provider in settings, writings inside the database) through the later reader-control migrations, schema 6 (bundled BabelDOC page range, rendering mode, QPS and thinking mode), and schema 7 (the opt-in arXiv LaTeX translation route), and refuses a newer schema. Large documents, translation caches, annotations, and assistant conversations live beside each paper so the metadata file stays small. Imports run in `store.batch` and write once.

## Library sync

`electron/main/sync/` is a port of native Freddie's `LibrarySync` client and syncs with Mac and iPad: the same protocol, record kinds, merge rules, conflict handling and `Sync/` layout (blob cache, per-server state, recovery copies). A record's payload names a document blob by its SHA-256, and native Freddie re-encodes what it applies, so documents this app writes must be byte-identical to Swift's `JSONEncoder` output (`swiftJSON.ts`: sorted keys, uppercase UUIDs, dates in milliseconds, Swift's `Double` formatting); `tests/fixtures/sync/swift-documents.json` is produced by the Swift types. A record unchanged here reuses the exact bytes it was received with, which keeps fields this app does not model (attachment display names, raw list text) and prevents echo uploads. Data that sync carries is stored in native Freddie's formats, so it needs no translation: localized page resources live in `Resources/`, writing images in `assets/`, PDF annotations in native sidecars (`notes/pdf-annotations-{ATTACHMENT}.json`, PDF page coordinates, ISO 8601 dates in whole seconds; the reader converts with each page's PDF.js viewport and stores text markup one record per line), HTML translations and PDF summaries in `translations/segments.json` as native `TranslationSegment`s with native cache identities, and reading states keep native HTML anchors. As in native `LibrarySyncActivity` (`sync/activity.ts`), records of a busy paper wait until it is idle: a running translation or region write, a reader annotating or editing regions, the Inspector editing authors, or one of its notes being edited (that note is also never replaced or uploaded meanwhile). Writings with unsaved edits wait until they are saved, and a remote deletion of a paper shown in a reader or the Inspector waits until it is closed. Renderers report readers and editors over `sync:reader-activity` / `sync:note-editing`, and a closed window's are forgotten. Applied files make open readers and editors reload (`sync:applied`).

## Long-running work

Import, translation, and the assistant publish typed events. The renderer treats its snapshot as a projection and reloads it after each change. HTML translation rewrites `paper.html` after every batch and sends each finished segment to the reader, which inserts it without reloading. PDF translation is replace-at-end: only a successful run becomes the visible translated attachment. BabelDOC emits helper-compatible stage events and keeps a credential-free structured-IL checkpoint keyed by PDF bytes, page selection and layout-model hash; route, glossary and thinking changes do not invalidate it. LaTeX units and scanned pages likewise use credential-free checkpoints.

## Document contents

Saved assistant conversations provide per-attachment history anchors to the HTML and PDF readers. The host renderer paints transient CSS highlights over existing text ranges; clicking a mark restores the stored conversation identity without a model request. Successful conversation saves refresh the anchors, PDF marks follow lazy text-layer rendering, and drag selection and annotation/region editing retain their own gestures. These marks do not wrap HTML text, modify PDF files, or enter the persistent annotation store.

PDF outlines are loaded lazily through named, UUID-validated preload operations. Main reads the registered original PDF and existing semantic/scan artifacts, then transfers the document bytes and credential-free heading data to a dedicated Node worker for PDF.js parsing, bookmark assessment/repair, LaTeX alignment and heuristic extraction; opening Contents never acquires source files or calls a model. Each attachment has a versioned, credential-free sidecar in `Resources/Outline/{attachmentId}.json`, written by atomic replacement. Its fingerprint records the paths, sizes and modification times of the PDF and semantic/scan artifacts, together with the arXiv identity; it is not a hash of file contents. Text and geometry are extracted once, then reused by the optional font pass. Both passes release each page and yield between pages inside the worker. Cancellation terminates the worker even during synchronous parsing; per-paper queues wait for it to exit, and app shutdown waits for pending outline work for at most five seconds. Native bookmarks remain selectable unchanged alongside a repaired variant; a reliable embedded outline defers heuristics until explicitly requested. Source choices persist in this derived sidecar, without changing the library schema or the PDF.

AI organization requires the reader's explicit send action, uses the PDF model route, and may only select existing candidate IDs and levels 1–6. Main preserves candidate order, titles and destinations, rejects stale-document results, and supports cancellation. Requests are serialized per paper; paper deletion cancels pending work and late results cannot recreate deleted papers.

HTML contents are read from the sandboxed frame by the host renderer, using the same stable `rp-path` anchors as notes. Translation blocks and hidden regions do not become extra headings; translated-only navigation targets the visible translation. Both readers report their current section, including multiple headings on one PDF page and scrolls led by the translated pane. Partial translation destinations keep original page coordinates and open the original when needed.
