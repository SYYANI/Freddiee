# Architecture

## Process boundary

```text
React renderer (sandboxed, one per window: main, Settings, Writing, About)
  │ named, typed operations through the preload bridge
  ▼
Electron main process
  ├─ FreddieStore        library.json (schema 3), monotonic migrations, atomic writes
  ├─ SecretStore         per-provider API keys encrypted with safeStorage
  ├─ PaperImporter       arXiv / web page / local PDF ingestion with staged progress
  ├─ localizer           Readability extraction, sanitizing, resource localization
  ├─ TranslationService  HTML segment pipeline, LaTeX and scanned-PDF jobs, abstract translation
  ├─ LaTeX pipeline      secure arXiv source extraction, protected translation, XeLaTeX
  ├─ RebuildPDFKit       scanned PDFs: Tesseract measurement, vision transcription, review, translation, XeLaTeX
  ├─ AssistantService    retrieval, prompts, streaming answers, saved conversations
  ├─ AnnotationStore     PDF annotation overlays and annotated-PDF export
  ├─ WritingStore        Markdown writings in Writings/{id}
  ├─ nativeLibrary       read-only import from native Freddie (macOS)
  └─ freddie://          contained, read-only delivery of paper and writing files
```

This applies the DeepSeek Harness desktop separation to a document application: Electron packages the complete web client, while the privileged process owns native integrations. Freddie needs no listening port: the narrow IPC facade and the custom read-only protocol give the same separation with a smaller attack surface.

The windows match native Freddie's scenes. Each is the same renderer bundle opened with a route (`main`, `settings`, `writing`, `about`) passed through `additionalArguments`. Main-process changes are broadcast as `library:changed`, and every window reloads its snapshot from the main-process authority.

## Security invariants

1. Renderers have no Node integration and run with Chromium sandboxing and context isolation.
2. Every IPC handler verifies that the sender is one of the app's own windows; arguments are validated in the main process (identifiers must be UUIDs, settings are allow-listed and type-checked).
3. The preload exposes operations, never generic `invoke`, filesystem, or process APIs. Dropped files are resolved with `webUtils.getPathForFile`, and the importer only accepts files that start with a PDF header.
4. `freddie://paper/{id}/a/{attachment}` serves registered attachments; `assets/` and `Resources/` serve localized page resources. Every path is resolved below the paper's UUID directory. `freddie://writing/{id}/images/...` serves writing images the same way. `freddie://pdfjs/` serves only allow-listed PDF.js CMap and standard-font filenames from the packaged dependency so translated CJK PDFs render correctly.
5. Imported HTML is sanitized on import (scripts, frames, forms, event handlers, and `javascript:` URLs removed) and displayed in a `srcdoc` frame with `sandbox="allow-same-origin"` and no script permission, under the renderer's CSP plus its own. The reader script drives the page from outside.
6. External navigation is denied in-app; HTTP(S) links open through the OS browser, and arXiv links offer an import first.
7. Model requests are made from the main process. The only subprocesses are the TeX tools and the native-library `sqlite3`, all started without a shell and never given an API key.
8. API keys remain in the main process and are encrypted by the operating system.
9. The native-library import runs the system `sqlite3` with a read-only URI and copies files; it never writes to the native store.
10. arXiv source extraction rejects traversal, links, special files, oversized archives, and excessive file counts. TeX subprocesses run without shell escape and with paranoid TeX input/output restrictions.
11. Scanned-page model output is parsed as constrained `<page>` markup: environments are allow-listed and checked, and file access, macro definition, `^^` character codes, `\csname` and similar commands are rejected before XeLaTeX runs (without shell escape, with paranoid file access). Tesseract runs offline from the packaged English model.

## Persistence

`library.json` is intentionally portable and inspectable. Writes are serialized through one queue and replace the file through a flushed temporary file and a rename. `schemaVersion` is monotonic; `migrateDatabase` brings schemas 1–2 (file names on papers, one provider in settings, writings inside the database) to schema 3 (attachments, folder memberships, item-type assignments, provider and model profiles, routes, file-based writings) and refuses a newer schema. Large documents, translation caches, annotations, and assistant conversations live beside each paper so the metadata file stays small. Imports run in `store.batch` and write once.

## Long-running work

Import, translation, and the assistant publish typed events. The renderer treats its snapshot as a projection and reloads it after each change. HTML translation rewrites `paper.html` after every batch and sends each finished segment to the reader, which inserts it without reloading. PDF translation is replace-at-end: only a successful run becomes the visible translated attachment. LaTeX units and scanned pages use credential-free checkpoints; changing a text route or glossary does not invalidate the more expensive cached page-image transcription.
