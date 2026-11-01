// Shared by imports, PDF export, and reader injection for already-saved pages.
// Readability can collapse the inner grid wrapper (Anthropic), leaving paragraphs
// without their ancestor-scoped column spans. Normalize grid tracks and item
// placement together, preserving hidden content and graphics with their own layout.
export const readableProseLayoutCSS = `
html:has(> body.rp-readability-body) {
    max-width: none !important;
}
body.rp-readability-body :is(.rp-readability-content, .rp-readability-content :is(article, section, main, header, footer, aside, div)):not(:where(svg *, math *, pre *, code *, [data-rp-preserve-layout], [data-rp-preserve-layout] *)) {
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-rows: none !important;
    grid-template-areas: none !important;
    grid-auto-flow: row !important;
}
body.rp-readability-body :is(.rp-readability-content, .rp-readability-content :is(article, section, main, header, footer, aside, div)):not(:where(svg *, math *, pre *, code *, [data-rp-preserve-layout], [data-rp-preserve-layout] *)) > :not(:where(svg, svg *, math, math *, pre *, code *, [data-rp-preserve-layout] *)) {
    grid-column: 1 / -1 !important;
    grid-row: auto !important;
}
body.rp-readability-body :is(.rp-readability-header, .rp-readability-content) :is(p, h1, h2, h3, h4, h5, h6):not(svg *, math *) {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    margin-inline: 0 !important;
    padding-inline: 0 !important;
    box-sizing: border-box !important;
}`
