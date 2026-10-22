# Repository guide

Freddie Cross-Platform is an Electron 44 + React 18 + TypeScript application.

- `shared/`: IPC/domain contracts used by all processes.
- `electron/main/`: privileged persistence, imports, AI, process, and protocol services.
- `electron/preload/`: the only renderer bridge; keep it narrow and typed.
- `src/`: sandboxed React interface.
- `tests/`: Node-side service tests.

Preserve the security invariants in `docs/ARCHITECTURE.md`. Do not expose arbitrary filesystem paths, generic IPC, raw secrets, or shell execution to the renderer. Add persisted fields through a monotonic store migration. Use atomic replacement for user-authored data and translation outputs.

Before handing off changes, run:

```sh
npm run typecheck
npm test
npm run build
```
