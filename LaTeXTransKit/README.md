# LaTeXTransKit

arXiv LaTeX translation for Freddie: a TypeScript port of the Swift `LaTeXTransKit`
(LaTeXTransSwift, `Sources/LaTeXTransKit`) and of native Freddie's host service
(read-paper `ReadPaper/Services/LaTeXTranslationService.swift`). It runs in the Electron main
process on macOS, Windows and Linux.

The pipeline prepares the arXiv source (bounded ZIP, tar and gzip readers with secure
extraction), parses it into section, caption and environment units, translates each unit through
a runtime-owned immutable template whose only model-visible parts are ID-addressed natural-language
slots, validates the structure, reconstructs the project with the target-language preamble, and
compiles it with `latexmk`. The translated source is kept even when no PDF can be built.

## Layout

| File | Swift original |
| --- | --- |
| `src/models.ts`, `src/pipeline.ts` | `Models/*`, `Pipeline/*` |
| `src/parser.ts` | `Parsing/StructuredLaTeXParser.swift` |
| `src/commandArguments.ts` | `Translation/LaTeXCommandArgumentModel.swift`, `LaTeXSignedIntegerAssignment.swift` |
| `src/translator.ts` | `Translation/PromptingLaTeXTranslator.swift` (prompts, templates, slot rendering, FNV-1a fingerprints, bounded concurrency) |
| `src/validation.ts` | `Validation/LaTeXStructuralTokenizer.swift`, `StructuralLaTeXValidator.swift` |
| `src/reconstruction.ts` | `Reconstruction/StructuredLaTeXReconstructor.swift` (with the language preamble policy) |
| `src/compiler.ts` | `Compilation/MacOSLaTeXCompiler.swift`, for every platform |
| `src/archives.ts`, `src/preparation.ts` | `Preparation/*` |
| `src/text.ts`, `src/json.ts` | Swift `Character` and `String` semantics, `JSONEncoder` and `JSONDecoder` behavior |
| `index.ts` | read-paper's prompt client, arXiv acquirer, file checkpoints, engine-compatibility rewriting, literal-percent parser, diagnostics, progress, error messages, and the reader's result handling |

The semantic-document extraction (`StructuredLaTeXSemanticExtractor`, `LaTeXBibliography`) feeds
native Freddie's BabelDOC helper, which Freddie does not ship, so it is not ported.

## Swift semantics

The Swift kit walks `Array(String)`, an array of extended grapheme clusters, and asks clusters
questions such as `isWhitespace` or `isNumber` from their first scalar. The port does the same
(`characters()` with `Intl.Segmenter`), with property tables exported from the Swift runtime
(`resources/unicode-properties.json`) so results do not depend on the JavaScript engine's Unicode
version. Other details carried over: `JSONEncoder` escaping (`\/`) inside prompts, `JSONDecoder`
leniency (trailing commas, first duplicate key wins), Foundation's whitespace set, ICU regular
expression classes, Windows-1252 decoding that falls back to Latin-1 on undefined bytes, and
`resolvingSymlinksInPath` for paths that do not exist yet.

Identical prompts give identical checkpoint fingerprints, and workspaces are keyed like native
Freddie's (`translations/latex/<target>/<identity>`), so a library imported from Freddie for macOS
resumes its LaTeX runs without paying for finished units again.

## Platform notes

- **Compilation**: latexmk is started without a shell from the chosen TeX installation, whose
  folder comes first on `PATH` (the Windows `Path` spelling is reused). Freddie adds
  `-no-shell-escape` and paranoid TeX file access (`openin_any`, `openout_any`) to the Swift
  arguments, as its security invariants require. Cancellation stops the whole process tree:
  a process group on macOS and Linux, `taskkill /T` on Windows.
- **Executables**: on Windows only `.exe` files are used, because `.bat` and `.cmd` scripts need a
  shell. TeX Live and MiKTeX both ship `latexmk.exe`.
- **Paths**: project-relative paths use `/` on every platform; drive-qualified, absolute and
  parent paths in archives, includes and outputs are rejected.

## Parity

`npm test` checks the port against the Swift kit:

- `tests/latex-trans-parity.test.ts` replays `tests/fixtures/latex-trans/parity.json`, recorded from
  the Swift kit by `scripts/latex-trans-parity`: parse maps and failures for 22 projects (CRLF and
  BOM files, Windows-1252, includes, imports, macros, protected environments), the exact prompts and
  model-call sequence of 10 translation scenarios (retries, malformed and unsafe answers, checkpoints,
  summaries), validation issues, preambles, 30 complete pipelines with their reconstructed
  projects, 31 archives, and the host rewrites.
- `tests/latex-trans-kit.test.ts` ports the Swift and read-paper behavioral suites (engine
  fallback and log rules, concurrency, cancellation, extraction limits, host service).
- `tests/latex-trans-corpus.test.ts` runs real arXiv sources from a native Freddie library (or
  `LATEX_TRANS_CORPUS`) and compares every stage with hashes recorded from Swift.
- `tests/latex-trans-compile.test.ts` compiles a translated project with the installed TeX
  distribution.

Refresh the fixtures on a Mac with `npm run sync:latex -- /path/to/arxivLatex [--corpus <library>]`.
The generator runs with the `en_US` locale because `localizedCaseInsensitiveCompare`, which orders
glossary entries, follows the user's locale; Freddie uses the system locale through `Intl.Collator`,
which differs from Foundation only for case-folding expansions such as `ß`/`ss`.

Behaviors kept for parity although they look unintended:

- `removeComments` splits lines on every newline scalar, so a CRLF source gains an empty line after
  each line.
- latexmk 4.88 reports a failed BibTeX run as `Bibtex errors: See file …` rather than `gave return
  code N`, so a PDF that survives a malformed bibliography is not accepted as recoverable.
