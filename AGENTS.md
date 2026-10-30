# Repository guide

Freddie Cross-Platform is an Electron 44 + React 18 + TypeScript application.

- `shared/`: IPC/domain contracts used by all processes.
- `electron/main/`: privileged persistence, imports, AI, process, and protocol services.
- `electron/preload/`: the only renderer bridge; keep it narrow and typed.
- `src/`: sandboxed React interface.
- `tests/`: Node-side service tests.

Preserve the security invariants in `docs/ARCHITECTURE.md`. The browser clipper (`electron/main/clipperServer.ts`) shares its API, port and clip rules with native Freddie (`../read-paper`, `BrowserClipperServer.swift` / `BrowserClipImporter.swift`) because one extension serves both; change them together. A save answers with `openURL`, the link the extension opens: on macOS this app uses its own `freddie-general://` scheme and does not claim `readpaper://` at launch, so a Mac with both apps opens each clip in the app that saved it. Do not expose arbitrary filesystem paths, generic IPC, raw secrets, or shell execution to the renderer. Add persisted fields through a monotonic store migration. Use atomic replacement for user-authored data and translation outputs.

Validate changes proportionally. For small, localized changes, run `npm run typecheck` and only the directly relevant targeted tests; do not run the full test suite or production build every time. Run the complete validation set for broad, high-risk, cross-module, release-oriented changes, or when the user explicitly requests it:

```sh
npm run typecheck
npm test
npm run build
```
