# Freddie Cross-Platform

Freddie is a local-first paper reader for macOS, Windows, and Linux. This repository is the cross-platform implementation of the native Swift Freddie app in `/Users/yiyan/Desktop/read-paper`, with the same interface: a floating library sidebar, a reader with HTML/PDF and Original/Bilingual/Translated pickers in the toolbar, and an inspector with Paper and Writing tabs.

The desktop architecture follows DeepSeek Harness Desktop: an Electron shell owns native lifecycle, files, secrets, and long-running processes, while one packaged web client draws the whole interface on every platform. The renderer never receives raw filesystem paths or API keys.

## Features

- **Library**: folders (collapsible sections, drag papers onto a folder), favorites, Zotero item types with detection, a filter for favorites / translated / noted papers and item types, and native context menus.
- **Import**: arXiv ID or URL (Atom API with abs-page fallback, PDF, optional arXiv HTML → ar5iv), any web page (Readability extraction, localized images and styles, PDF responses routed to the PDF path), local PDFs from a file dialog or by dropping them on the window. Every import reports staged progress.
- **Reading**: PDF.js continuous pages with text selection, find, links, Paper Tone, and margin notes; side-by-side bilingual PDF with leader/follower scroll sync; sandboxed, script-free HTML reader with Original/Bilingual/Translated display, font size, find, margin notes, and region hiding.
- **Translation**: HTML segment translation with the native academic prompt, placeholder protection, output validation, a per-paper cache, and live updates; PDF translation through a local BabelDOC command, including first-N-pages batches and continuing a partial translation; scanned-PDF translation that rebuilds each page with a vision model, Tesseract and XeLaTeX on the original layout, like native Freddie (needs TeX Live, MacTeX or MiKTeX); abstract translation in the inspector.
- **Reading assistant**: Explain, Ask, and Translate on any selection, with retrieved paper sources, streaming answers, follow-ups, optional server-side web search, saved conversations, and Save as Note.
- **Notes and annotations**: notes anchored to PDF pages or HTML passages, Markdown previews, highlight / underline / strike-out / ink / text-note PDF annotations with undo, and annotated-PDF export.
- **Writing**: Markdown writings in the inspector or their own window, with live syntax, inline images and math, citations of passages (`readpaper://` links compatible with native Freddie), Quote in Writing, word counts, and rename / trash.
- **Export**: copy link, copy digest, export digest Markdown with a template, export HTML as PDF.
- **Settings**: General (quick setup, language, target language, glossary, BabelDOC runtime, performance), Reader (typography, appearance, translation routes), LaTeX (toolchain detection), Digest, Providers, and Models, using the OpenAI Responses, Chat Completions, or Anthropic Messages API.
- **Moving from the Mac app**: on macOS, *File → Import Library from Freddie for macOS…* copies papers, attachments, translations, notes, folders, item types, reading positions, and writings from the native app's library. The native library is opened read-only and not changed; API keys stay in the Keychain and must be entered again.
- **Interface**: English and Simplified Chinese (the native string catalog is reused), Default and Paper Tone appearances, macOS vibrancy and Windows acrylic window materials.

Not yet available in the cross-platform app: arXiv LaTeX translation. Its settings and toolchain detection are present so the path is ready.

## Develop

Requirements: Node.js 22.19+ or 24+, npm 11+.

```sh
npm install
npm run dev
```

`FREDDIE_DATA_DIR=/some/folder` points the app at a separate library, which keeps development runs away from your real data. When launching Electron from a terminal inside VS Code, unset `ELECTRON_RUN_AS_NODE` first.

Validation:

```sh
npm run typecheck
npm test
npm run build
```

Package the current platform with `npm run package`, or use `package:mac`, `package:win`, or `package:linux` on the corresponding host. Local macOS packages are ad-hoc signed and not notarized; release CI can replace this with a Developer ID identity and notarization credentials.

## Data and credentials

Freddie keeps its library below the platform application-data directory in `Freddie/`:

```text
Freddie/
  library.json                 papers, attachments, notes, folders, settings (schemaVersion 3)
  secrets.json                 API keys encrypted per provider with the OS credential store
  Library/{paper id}/
    paper.pdf, paper.html      originals
    assets/ (or Resources/)    localized page resources
    translations/              BabelDOC runs, html-cache.json
    annotations/{attachment}.json
    assistant/conversations.json
  Writings/{writing id}/
    writing.md, meta.json, images/
```

User-authored data and translation outputs are written through a temporary file and an atomic rename. API keys are encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows, the secret service on Linux); the renderer only learns whether a key is configured.

## PDF translation

PDF translation runs a locally installed BabelDOC-compatible command, so each platform can use the runtime it supports (for example `uv tool install BabelDOC`). The default arguments are

```text
--openai --openai-model {model} --openai-base-url {baseUrl} --openai-api-key {apiKey}
--files {input} --output {outputDir} --lang-out {lang} --qps {qps} --pages {pages}
--no-dual --watermark-output-mode no_watermark
```

Change the command and arguments in Settings → General → PDF Translation Runtime. Arguments are passed to `spawn` without a shell, and an argument whose placeholder is empty (such as `{pages}` for a full translation) is dropped together with its flag. The finished PDF only replaces the visible translation after BabelDOC exits successfully; the log is kept next to the run.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SWIFT_PARITY.md](docs/SWIFT_PARITY.md).

## License

Copyright © 2026 SYYANI. Licensed under GNU AGPL-3.0-only, matching the original Freddie project.
