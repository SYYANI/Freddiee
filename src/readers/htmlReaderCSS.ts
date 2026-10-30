// Styles the reader injects into saved HTML pages. They mirror native Freddie's
// HTMLReaderTypography, the appearance CSS, and the saved-document repairs.

const proseColor = `
body.rp-readability-body { color: var(--rp-reader-text, #1f1f1f) !important; background: transparent !important; }
body.rp-readability-body .rp-readability-shell,
body.rp-readability-body .rp-readability-shell :where(article, section, main, header, footer, aside, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd, blockquote, figure, figcaption, table, thead, tbody, tfoot, tr, th, td, span, strong, b, em, i, small, sup, sub):not(:where(pre *, code *, svg *, math *)) { color: inherit !important; text-shadow: none !important; }
body.rp-readability-body .rp-readability-header, body.rp-readability-body .rp-readability-content { color: var(--rp-reader-text, #1f1f1f) !important; }
body.rp-readability-body .rp-readability-byline, body.rp-readability-body .rp-readability-excerpt { color: var(--rp-reader-muted, #5f6368) !important; }
body.rp-readability-body .rp-readability-shell a:not(:where(pre *, code *, svg *, math *)) { color: var(--rp-reader-link, #335c85) !important; }
body.rp-readability-body .rp-readability-shell .rp-translation-block { color: var(--rp-reader-translation, #1f4d3a) !important; }
html:has(> body.rp-readability-body) { max-width: none !important; }
body.rp-readability-body :is(.rp-readability-header, .rp-readability-content) :is(p, h1, h2, h3, h4, h5, h6):not(svg *, math *) { width: 100% !important; min-width: 0 !important; max-width: 100% !important; margin-inline: 0 !important; padding-inline: 0 !important; box-sizing: border-box !important; }`

const translationDisplay = `
html[data-rp-display-mode='original'] .rp-translation-block { display: none !important; }
html[data-rp-display-mode='translated'] [data-rp-source='true'] { display: none !important; }
.rp-translation-block { color: #1f4d3a; display: block !important; position: static !important; clear: both; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; white-space: normal !important; word-break: break-word; line-height: 1.55 !important; margin-top: 0.25em; box-sizing: border-box; }
html[data-rp-display-mode='bilingual'] .rp-readability-content [data-rp-source='true'] { margin-bottom: 0.25em !important; }
.rp-readability-content [data-rp-source='true'] + .rp-translation-block { font-size: inherit !important; line-height: inherit !important; margin-left: 0 !important; margin-right: 0 !important; margin-top: 0 !important; margin-bottom: 1.1em !important; }
.rp-translation-block:is(h1, h2, h3, h4, h5, h6) { line-height: 1.45 !important; margin-top: 0.35em !important; margin-bottom: 0.75em !important; }`

// `!important` because sites like `html[data-theme="dark"] { color-scheme: dark }` outrank :root, and
// Chromium then paints an opaque dark backdrop behind the transparent iframe.
const typography = (fontSize: number): string => `
:root { --rp-reader-font-size: ${fontSize}px; color-scheme: light !important; }
body.rp-readability-body .rp-readability-content { font-size: var(--rp-reader-font-size) !important; }
body.rp-readability-body .rp-readability-content p.rp-readability-prose-paragraph,
body.rp-readability-body .rp-readability-content [data-rp-source='true'],
body.rp-readability-body .rp-readability-content .rp-translation-block { font-size: var(--rp-reader-font-size) !important; }
body.rp-readability-body .rp-readability-title,
body.rp-readability-body .rp-readability-title + .rp-translation-block { font-size: calc(var(--rp-reader-font-size) * 1.9) !important; }
body.rp-readability-body .rp-readability-byline,
body.rp-readability-body .rp-readability-excerpt,
body.rp-readability-body .rp-readability-byline + .rp-translation-block,
body.rp-readability-body .rp-readability-excerpt + .rp-translation-block { font-size: calc(var(--rp-reader-font-size) * 0.95) !important; }
body:not(.rp-readability-body) { font-size: var(--rp-reader-font-size); }`

const defaultAppearance = `
html, body, body.rp-readability-body, body.rp-readability-body .rp-readability-shell, body.rp-readability-body .rp-readability-header, body.rp-readability-body .rp-readability-content, body:not(.rp-readability-body) { background: transparent !important; background-color: transparent !important; }`

const paperAppearance = `
body.rp-readability-body { --rp-reader-text: #2b261f; --rp-reader-muted: #726752; --rp-reader-link: #285f86; --rp-reader-translation: #24533d; }
html, body { background: transparent !important; }
body { color: #2b261f !important; }
body.rp-readability-body { background: transparent !important; }
body.rp-readability-body .rp-readability-shell, body.rp-readability-body .rp-readability-header, body.rp-readability-body .rp-readability-content { color: #2b261f !important; }
body.rp-readability-body .rp-readability-title, body.rp-readability-body .rp-readability-content :is(h1, h2, h3, h4, h5, h6) { color: #211b14 !important; font-family: "New York", "Iowan Old Style", "Songti SC", "STSong", Georgia, serif !important; }
body.rp-readability-body .rp-readability-byline, body.rp-readability-body .rp-readability-excerpt { color: #726752 !important; }
body.rp-readability-body .rp-readability-content a, body:not(.rp-readability-body) a { color: #285f86 !important; }
body.rp-readability-body .rp-translation-block, body:not(.rp-readability-body) .rp-translation-block { color: #24533d !important; }
body.rp-readability-body code, body.rp-readability-body pre { background: rgba(91, 67, 31, 0.10) !important; color: #2b261f !important; }
body.rp-readability-body blockquote { border-color: rgba(87, 68, 37, 0.28) !important; color: #4d4436 !important; }
body.rp-readability-body table, body.rp-readability-body th, body.rp-readability-body td { border-color: rgba(87, 68, 37, 0.24) !important; }
body.rp-readability-body img, body.rp-readability-body video, body.rp-readability-body canvas, body.rp-readability-body svg { filter: sepia(0.08) saturate(0.96); }
.rp-note-anchor-target { outline-color: rgba(36, 83, 61, 0.42) !important; background: rgba(36, 83, 61, 0.10) !important; }
body:not(.rp-readability-body) { background: transparent !important; color: #2b261f !important; }`

const readerChrome = `
html { scrollbar-width: thin; }
::selection { background: rgba(0, 122, 255, 0.24); }
::highlight(rp-find) { background-color: rgba(255, 214, 10, 0.45); }
::highlight(rp-find-current) { background-color: rgba(255, 149, 0, 0.75); }
.rp-note-anchor-target { outline: 3px solid rgba(0, 122, 255, 0.35); outline-offset: 3px; border-radius: 3px; background: rgba(0, 122, 255, 0.08); transition: background 0.4s, outline-color 0.4s; }
[data-rp-hidden='true'] { display: none !important; }
html[data-rp-region-editing] [data-rp-hidden='true'] { display: revert !important; opacity: 0.28; outline: 1.5px dashed rgba(255, 59, 48, 0.7); outline-offset: 2px; }
html[data-rp-region-editing] .rp-region-hover { outline: 2px solid rgba(0, 122, 255, 0.75); outline-offset: 2px; cursor: pointer; border-radius: 2px; }
html[data-rp-region-editing] a { pointer-events: none; }
img { max-width: 100%; height: auto; }`

export function readerCSS(fontSize: number, appearance: 'default' | 'paper'): string {
  return [proseColor, translationDisplay, typography(fontSize), appearance === 'paper' ? paperAppearance : defaultAppearance, readerChrome].join('\n')
}
