import { closingBrace } from './braces'
import type { PageLayout } from './geometry'
import { LineMetrics } from './lineMetrics'
import { type LineFrame, type LineMode, applyLineBreaks, frameWidth, inlineFigures, sideWidths } from './lineBreaks'
import { MarkupPatterns, type PageMarkup, displaySpans } from './markup'
import { Pattern, PythonNumber, PythonText } from './pattern'

/**
 * A figure crop at its printed size: offset is from the left edge of its column, or for a
 * free figure outside all columns from the left edge of the text area, which it may cross
 * into the margin; top and height locate it on the page, in points.
 */
export interface FigurePlacement {
  file: string
  width: number
  offset: number
  top: number
  height: number
  free: boolean
}

export type PlacedFigures = ReadonlyArray<{ key: string; placement: FigurePlacement }>

const DisplayPatterns = {
  tag: new Pattern(String.raw`\\tag(\*?)\s*\{`),
  rows: new Pattern(String.raw`(\s*)\\begin\{(aligned|gathered|alignedat)\}(?:\[[^\]]*\])?(.*)\\end\{\2\}(\s*)`, { dotAll: true }),
  rowDisplays: { aligned: 'align*', gathered: 'gather*', alignedat: 'alignat*' } as Record<string, string>,
  oneRow: new Pattern(MarkupPatterns.verbatimSource + String.raw`|\\begin\{(align|gather)\*\}(.*?)\\end\{\1\*\}`, { dotAll: true }),
  alignmentMark: new Pattern(String.raw`(?<!\\)&`),
  tagged: new Pattern(String.raw`\\rebuildtagged\{\d+\}\{`),
  sides: new Pattern(String.raw`\\begin\{sidebyside\}\{([^{}]*)\}`),
  space: new Pattern(String.raw`\\vspace(\*?)\{([^{}]*)\}`)
}

/** An alignment environment's end, which TeX reports an overwide alignment at. */
export const alignmentEnd = new Pattern(String.raw`\\end\{((?:align|alignat|gather|multline)\*)\}`)

/** `_display_tags`: each \tag of a display, where it starts and ends and the number it prints. */
function displayTags(content: string): Array<{ first: number; last: number; label: string }> {
  const tags: Array<{ first: number; last: number; label: string }> = []
  for (const match of DisplayPatterns.tag.matches(content)) {
    const close = closingBrace(content, match.end)
    if (close === undefined) break
    const label = content.slice(match.end, close - 1)
    tags.push({ first: match.start, last: close, label: match.at(1) ? label : `(${label})` })
  }
  return tags
}

/** `_tagged`: a numbered display, the formula around its \tag, which keeps only its line breaks. */
function tagged(label: string, before: string, tag: string, after: string): string {
  return `\\[\\rebuildtagged{1000}{${label}}{${before}${'\n'.repeat(tag.split('\n').length - 1)}${after}}\\]`
}

/**
 * `_number_displays`: set each equation number (\tag) at the right end of its display line, as printed.
 *
 * A display with one number becomes \rebuildtagged, which reports a formula that no longer
 * fits beside its number as an overwide display, and so does a single numbered line written
 * as an alignment; aligned rows that carry numbers become an align* (gather*, alignat*)
 * environment. The line count stays the same.
 */
export function numberDisplays(source: string): string {
  let text = source
  for (const span of displaySpans(text).reverse()) {
    const content = text.slice(span.start + 2, span.end - 2)
    const tags = displayTags(content)
    if (!tags.length) continue
    const rows = DisplayPatterns.rows.fullMatch(content)
    if (rows) {
      const name = DisplayPatterns.rowDisplays[rows.at(2)]
      text = text.slice(0, span.start) + rows.at(1) + `\\begin{${name}}` + rows.at(3) + `\\end{${name}}` + rows.at(4) + text.slice(span.end)
    } else if (tags.length === 1) {
      const { first, last, label } = tags[0]
      text = text.slice(0, span.start) + tagged(label, content.slice(0, first), content.slice(first, last), content.slice(last)) + text.slice(span.end)
    }
  }
  return DisplayPatterns.oneRow.sub(text, (match) => {
    const content = match.at(2)
    const tags = match.group(1) !== undefined && !content.includes('\\\\') ? displayTags(content) : []
    if (tags.length !== 1) return match.text
    const { first, last, label } = tags[0]
    // Without its alignment marks the row prints the same.
    return tagged(label, DisplayPatterns.alignmentMark.sub(content.slice(0, first), ''), content.slice(first, last),
      DisplayPatterns.alignmentMark.sub(content.slice(last), ''))
  })
}

/** `_untag_displays`: show a numbered display the way the markup writes it. */
export function untagDisplays(source: string): string {
  let text = source
  for (let match = DisplayPatterns.tagged.search(text); match; match = DisplayPatterns.tagged.search(text)) {
    const labelEnd = closingBrace(text, match.end)
    if (labelEnd === undefined || !(labelEnd < text.length) || text.charCodeAt(labelEnd) !== 0x7B) return text
    const formulaEnd = closingBrace(text, labelEnd + 1)
    if (formulaEnd === undefined) return text
    const label = text.slice(match.end, labelEnd - 1)
    const formula = text.slice(labelEnd + 1, formulaEnd - 1)
    text = text.slice(0, match.start) + formula + ` \\tag*{${label}}` + text.slice(formulaEnd)
  }
  return text
}

/** Header and footer keep the source page's type while the translated body is refitted. */
export interface TranslationTypography {
  referenceSize: number
  referenceLeading: number
}

/** Lines `first...last` of main.tex, 1-based as in TeX's log. */
export interface LineRange {
  first: number
  last: number
}

/** A paragraph line range of main.tex (as TeX reports it) to a size factor, in insertion order. */
export class ParagraphSizes {
  entries: Array<{ range: LineRange; factor: number }> = []

  get isEmpty(): boolean { return this.entries.length === 0 }
  get factors(): number[] { return this.entries.map((entry) => entry.factor) }

  get(range: LineRange): number | undefined {
    return this.entries.find((entry) => entry.range.first === range.first && entry.range.last === range.last)?.factor
  }

  set(range: LineRange, factor: number | undefined): void {
    const index = this.entries.findIndex((entry) => entry.range.first === range.first && entry.range.last === range.last)
    if (index >= 0) {
      if (factor === undefined) this.entries.splice(index, 1)
      else this.entries[index] = { range, factor }
    } else if (factor !== undefined) {
      this.entries.push({ range, factor })
    }
  }

  clone(): ParagraphSizes {
    const copy = new ParagraphSizes()
    copy.entries = this.entries.map((entry) => ({ range: { ...entry.range }, factor: entry.factor }))
    return copy
  }
}

const gyre = '[Extension=.otf,UprightFont=*-regular,BoldFont=*-bold,ItalicFont=*-italic,BoldItalicFont=*-bolditalic]'

const TeXPreamble = {
  /**
   * Times text and math everywhere; the page's main face only changes the default family, so
   * \textrm, \textsf and \texttt can still mark material printed in another face.
   */
  fonts: [
    String.raw`\usepackage{newtxtext}`, String.raw`\usepackage{newtxmath}`,
    String.raw`\setsansfont{texgyreheros}` + gyre, String.raw`\setmonofont{texgyrecursor}` + gyre
  ].join('\n'),
  family: { serif: String.raw`\rmdefault`, sans: String.raw`\sfdefault`, typewriter: String.raw`\ttdefault` } as Record<string, string>,
  sizes: [
    ['tiny', 0.5], ['scriptsize', 0.7], ['footnotesize', 0.8], ['small', 0.9], ['large', 1.2],
    ['Large', 1.44], ['LARGE', 1.73], ['huge', 2.07], ['Huge', 2.49]
  ] as Array<[string, number]>
}

/** `_has_cjk`. */
export function hasCJK(text: string): boolean {
  for (const scalar of text) {
    const value = scalar.codePointAt(0)!
    if ((value >= 0x3040 && value <= 0x30FF) || (value >= 0x3400 && value <= 0x9FFF) || (value >= 0xAC00 && value <= 0xD7AF)) return true
  }
  return false
}

export interface BuildOptions {
  markup: PageMarkup
  layout: PageLayout
  figures: PlacedFigures
  lineMode?: LineMode
  scale?: number
  paragraphSizes?: ParagraphSizes
  displayScales?: ParagraphSizes
  typography?: TranslationTypography
  spaceScale?: number
}

/**
 * `build_tex`: the complete main.tex for one page.
 *
 * `paragraphSizes` maps main.tex line ranges (as TeX reports them for overfull paragraphs)
 * to a size factor, `displayScales` the line ranges of overwide displayed formulas to a
 * scale; wrapping never changes the line count. `spaceScale` narrows every \vspace of the
 * body and footer.
 */
export function buildTeX(options: BuildOptions): string {
  const { markup, layout, figures, typography } = options
  const lineMode = options.lineMode ?? 'keep'
  const scale = options.scale ?? 1
  const paragraphSizes = options.paragraphSizes ?? new ParagraphSizes()
  const displayScales = options.displayScales ?? new ParagraphSizes()
  const spaceScale = options.spaceScale ?? 1
  const size = layout.size * scale
  const leading = layout.leading * scale
  const metrics = new LineMetrics(markup.font)

  const ratio = (line: string, frames: LineFrame[]): number => {
    const measure = frameWidth(frames, layout.textWidth, layout.columnGap, size, markup.columns)
    return metrics.widthEm(line) * size / measure
  }

  const f = PythonNumber.fixed
  let body = applyLineBreaks(inlineFigures(markup.body), lineMode, ratio)
  body = numberDisplays(DisplayPatterns.sides.sub(body, (match) => {
    const widths = sideWidths(match.at(1), layout.textWidth, layout.columnGap, markup.columns)
    return `\\begin{sidebyside}{${widths.map((width) => `${f(width, 2)}bp`).join(',')}}`
  }))
  let footer = numberDisplays(applyLineBreaks(inlineFigures(markup.footer), lineMode, ratio))
  if (spaceScale !== 1) {
    const narrow = (text: string): string => DisplayPatterns.space.sub(text, (match) =>
      `\\vspace${match.at(1)}{${PythonNumber.general(spaceScale)}\\glueexpr ${match.at(2)}\\relax}`)
    body = narrow(body)
    footer = narrow(footer)
  }
  const right = layout.pageWidth - layout.left - layout.textWidth
  const bottom = layout.pageHeight - layout.top - layout.textHeight
  const sizes = ([['normalsize', 1]] as Array<[string, number]>).concat(TeXPreamble.sizes).map(([name, factor]) =>
    '\\renewcommand\\' + name + String.raw`{\fontsize{\fpeval{\rebuildfactor*` + f(size * factor, 4) + '}bp}'
      + String.raw`{\fpeval{\rebuildfactor*` + f(leading * factor, 4) + String.raw`}bp}\selectfont}`)
    .join('\n')
  const definitions = figures.map(({ key, placement }) =>
    String.raw`\@namedef{rebuildfig@` + key + '}{' + (placement.free ? String.raw`\rebuildfigplace` : String.raw`\rebuildfigbox`) + '{'
      + f(placement.offset * scale, 2) + 'bp}{' + f(placement.width * scale, 2) + 'bp}{' + placement.file + '}}\n'
      + String.raw`\@namedef{rebuildinline@` + key + String.raw`}{\includegraphics[width=` + f(placement.width * scale, 2)
      + 'bp]{' + placement.file + '}}')
    .join('\n')
  const everything = [markup.header, body, footer].join('\n')
  let cjk = ''
  if (hasCJK(everything)) {
    cjk = String.raw`\usepackage{xeCJK}` + '\n'
      + String.raw`\setCJKmainfont{FandolSong-Regular.otf}[BoldFont=FandolSong-Bold.otf,ItalicFont=FandolKai-Regular.otf]`
      + '\n' + String.raw`\setCJKsansfont{FandolHei-Regular.otf}[BoldFont=FandolHei-Bold.otf]`
      + '\n' + String.raw`\setCJKmonofont{FandolFang-Regular.otf}`
    if (typography) {
      cjk = cjk.replaceAll(
        String.raw`\setCJKmonofont{FandolFang-Regular.otf}`,
        String.raw`\setCJKmonofont{FandolSong-Regular.otf}[BoldFont=FandolSong-Bold.otf,ItalicFont=FandolKai-Regular.otf]`
      )
      cjk += '\n' + String.raw`\setCJKfamilyfont{rebuildquote}{FandolKai-Regular.otf}`
        + '\n' + String.raw`\AddToHook{env/quote/begin}{\CJKfamily{rebuildquote}}`
        + '\n' + String.raw`\AddToHook{env/quotation/begin}{\CJKfamily{rebuildquote}}`
    }
  }
  // keep: printed lines may only end where the scan does, so no hyphenation and no breaks
  // inside inline math. Every font gets interword flexibility relative to its own space
  // (a fixed \spaceskip would be wrong for titles and small print): proportional lines
  // justify, typewritten pages stay ragged, and any space may shrink to 55%.
  let stretch = lineMode === 'keep'
    ? String.raw`\tolerance=10000 \hbadness=10000 \hyphenpenalty=10000 \exhyphenpenalty=10000 `
      + String.raw`\binoppenalty=10000 \relpenalty=10000`
    : String.raw`\tolerance=2000 \emergencystretch=1.5em`
  const give = markup.font === 'typewriter' ? '0pt' : String.raw`1.2\fontdimen2\font`
  const spacingHook = lineMode === 'keep'
    ? String.raw`\AddToHook{selectfont}{\fontdimen3\font=` + give + String.raw`\relax`
      + String.raw`\fontdimen4\font=0.45\fontdimen2\font\relax}`
    : ''
  if (markup.font === 'typewriter') stretch += String.raw` \raggedright\parindent=` + f(layout.indent * scale, 3) + 'bp'
  let header = ''
  if (markup.header) {
    header = String.raw`\noindent ` + markup.header + String.raw`\par`
      + (layout.headerGap !== 0 ? String.raw`\vspace{` + f(layout.headerGap * scale, 2) + 'bp}' : '')
  }
  if (typography) {
    const referenceFont = String.raw`\fontsize{` + f(typography.referenceSize * scale, 4) + 'bp}'
      + '{' + f(typography.referenceLeading * scale, 4) + String.raw`bp}\selectfont `
    header = header ? '{' + referenceFont + header + '}' : ''
    footer = PythonText.strip(footer) ? '{' + referenceFont + footer + String.raw`\par}` : ''
  }
  const family = TeXPreamble.family[markup.font] ?? TeXPreamble.family.serif
  let tex = `\\documentclass{article}
\\usepackage[paperwidth=${f(layout.pageWidth, 3)}bp,paperheight=${f(layout.pageHeight, 3)}bp,left=${f(layout.left, 3)}bp,right=${f(right, 3)}bp,top=${f(layout.top, 3)}bp,bottom=${f(bottom, 3)}bp,headheight=0pt,headsep=0pt,footskip=0pt,nomarginpar]{geometry}
\\usepackage{amsmath}
${TeXPreamble.fonts}
\\renewcommand\\familydefault{${family}}
${cjk}
\\usepackage{graphicx}
\\usepackage{multicol}
\\pagestyle{empty}
\\tracinglostchars=3
\\newcommand\\rebuildfactor{1}
${sizes}
\\newcommand\\rebuildspacing{${stretch}}
${spacingHook}
% A paragraph printed smaller than the body text: scales every size command inside it.
\\newcommand\\rebuildsize[1]{\\renewcommand\\rebuildfactor{#1}\\normalsize\\rebuildspacing}
\\setlength{\\parskip}{${f(layout.paragraphGap * scale, 3)}bp}
\\setlength{\\parindent}{${f(layout.indent * scale, 3)}bp}
\\setlength{\\columnsep}{${f(layout.columnGap, 3)}bp}
\\setlength{\\multicolsep}{0pt}
\\setlength{\\topskip}{${f(0.72 * size, 3)}bp}
\\setlength{\\abovedisplayskip}{${f(0.2 * leading, 3)}bp plus ${f(0.2 * leading, 3)}bp minus ${f(0.1 * leading, 3)}bp}
\\setlength{\\belowdisplayskip}{\\abovedisplayskip}
\\setlength{\\abovedisplayshortskip}{0pt plus ${f(0.2 * leading, 3)}bp}
\\setlength{\\belowdisplayshortskip}{\\abovedisplayskip}
\\raggedbottom
\\hfuzz=1pt
\\newcommand\\unclear[1]{#1}
% An overwide display: squeeze its spacing as TeX would to fit the scaled column, then scale.
\\newbox\\rebuilddisplaybox \\newdimen\\rebuilddisplaygoal
\\newcommand\\rebuilddisplay[2]{\\setbox\\rebuilddisplaybox\\hbox{$\\displaystyle #2$}%
  \\rebuilddisplaygoal=\\dimexpr\\displaywidth*1000/#1\\relax
  \\ifdim\\wd\\rebuilddisplaybox>\\rebuilddisplaygoal
    \\setbox\\rebuilddisplaybox\\hbox to\\rebuilddisplaygoal{\\hbadness10000 \\hfuzz\\maxdimen \\unhbox\\rebuilddisplaybox}\\fi
  \\scalebox{\\fpeval{#1/1000}}{\\box\\rebuilddisplaybox}}
% A display with its printed number: the formula centred, the number at the right margin.
% When both do not fit the formula moves left; an overwide formula reports its overflow like
% any display, and is squeezed and scaled as \\rebuilddisplay does.
\\newbox\\rebuildtagbox
\\newcommand\\rebuildtagged[3]{\\setbox\\rebuildtagbox\\hbox{\\normalfont #2}%
  \\setbox\\rebuilddisplaybox\\hbox{$\\displaystyle #3$}%
  \\ifnum#1<1000
    \\rebuilddisplaygoal=\\dimexpr(\\displaywidth-\\wd\\rebuildtagbox-1em)*1000/#1\\relax
    \\ifdim\\wd\\rebuilddisplaybox>\\rebuilddisplaygoal
      \\setbox\\rebuilddisplaybox\\hbox to\\rebuilddisplaygoal{\\hbadness10000 \\hfuzz\\maxdimen \\unhbox\\rebuilddisplaybox}\\fi
    \\setbox\\rebuilddisplaybox\\hbox{\\scalebox{\\fpeval{#1/1000}}{\\box\\rebuilddisplaybox}}\\fi
  \\ifdim\\dimexpr\\wd\\rebuilddisplaybox+2\\wd\\rebuildtagbox+2em\\relax>\\displaywidth
    \\hbox to\\displaywidth{\\box\\rebuilddisplaybox\\hskip1em plus1fil\\box\\rebuildtagbox}%
  \\else
    % TeX chooses the space above from where the formula starts, as for one without a number.
    \\ifdim\\predisplaysize>-\\maxdimen
      \\predisplaysize=\\dimexpr\\predisplaysize-(\\displaywidth-\\wd\\rebuilddisplaybox)/2\\relax\\fi
    \\hbox to\\displaywidth{\\hskip\\dimexpr\\wd\\rebuildtagbox+1em\\relax\\hfil\\box\\rebuilddisplaybox\\hfil\\hskip1em\\box\\rebuildtagbox}%
  \\fi}
\\providecommand\\cent{\\textcent}
\\providecommand\\cents{\\textcent}
\\newenvironment{indentblock}{\\list{}{\\leftmargin=1.5em\\rightmargin=1.5em\\topsep=0pt\\partopsep=0pt\\parsep=0pt\\itemsep=0pt\\listparindent=\\parindent}\\item\\relax}{\\endlist}
% Two columns whose first one ends in a note: running text flows from the first column into
% the second at balanced height, and the note stays at the foot of the first column.
\\newbox\\rebuildflowbox \\newbox\\rebuildnotebox \\newbox\\rebuildleftbox \\newbox\\rebuildrestbox
\\newdimen\\rebuildcolheight
\\newcommand\\rebuildcolumnnote[1]{\\par\\setbox\\rebuildnotebox\\vbox{\\hsize\\dimexpr(\\linewidth-\\columnsep)/2\\relax
  \\columnwidth\\hsize\\linewidth\\hsize #1\\par}}
\\newenvironment{rebuildflow}{\\par\\setbox\\rebuildflowbox\\vbox\\bgroup\\hsize\\dimexpr(\\linewidth-\\columnsep)/2\\relax
  \\columnwidth\\hsize\\linewidth\\hsize}{\\par\\egroup
  \\splittopskip=0pt \\vbadness=10000 \\vfuzz\\maxdimen
  \\rebuildcolheight\\dimexpr(\\ht\\rebuildflowbox+\\ht\\rebuildnotebox+\\dp\\rebuildnotebox)/2\\relax
  \\loop
    \\setbox\\rebuildrestbox\\copy\\rebuildflowbox
    \\setbox\\rebuildleftbox\\vsplit\\rebuildrestbox to\\dimexpr\\rebuildcolheight-\\ht\\rebuildnotebox-\\dp\\rebuildnotebox\\relax
    \\ifdim\\ht\\rebuildrestbox>\\rebuildcolheight \\advance\\rebuildcolheight by .5\\baselineskip
  \\repeat
  \\noindent\\hbox to\\linewidth{\\vbox to\\rebuildcolheight{\\unvbox\\rebuildleftbox\\vfill\\box\\rebuildnotebox}\\hfill
    \\vbox to\\rebuildcolheight{\\unvbox\\rebuildrestbox\\vfill}}\\par}
\\newdimen\\rebuildfigwidth \\newdimen\\rebuildfigoffset
% Own registers: graphicx uses \\dimen0 (\\dimen@) as scratch while scaling.
\\newcommand\\rebuildfigbox[3]{\\par\\smallskip\\noindent\\rebuildfigwidth=#2\\relax
  \\ifdim\\rebuildfigwidth>\\linewidth\\rebuildfigwidth=\\linewidth\\fi
  \\rebuildfigoffset=#1\\relax
  \\ifdim\\dimexpr\\rebuildfigwidth+\\rebuildfigoffset\\relax>\\linewidth\\rebuildfigoffset=\\dimexpr\\linewidth-\\rebuildfigwidth\\relax\\fi
  \\hspace*{\\rebuildfigoffset}\\includegraphics[width=\\the\\rebuildfigwidth,height=0.95\\textheight,keepaspectratio]{#3}\\par\\smallskip}
% A figure outside all columns keeps its printed place, also where it reaches into the margin.
\\newcommand\\rebuildfigplace[3]{\\par\\smallskip\\noindent\\makebox[\\linewidth][l]{\\hspace*{#1}\\includegraphics[width=#2,height=0.95\\textheight,keepaspectratio]{#3}}\\par\\smallskip}
% Blocks printed side by side: top-aligned boxes of their printed widths, one column gap apart,
% each set like the body text.
\\newcommand\\rebuildcell{\\rebuildspacing\\setlength{\\parindent}{${f(layout.indent * scale, 3)}bp}\\setlength{\\parskip}{${f(layout.paragraphGap * scale, 3)}bp}\\hfuzz=1pt\\relax}
\\makeatletter
\\def\\rebuildside@next#1,#2\\@nil{\\gdef\\rebuildside@rest{#2}\\begin{minipage}[t]{#1}\\vspace{0pt}\\rebuildcell}
\\newenvironment{sidebyside}[1]{\\par\\noindent\\rebuildside@next#1,\\@nil}{\\par\\end{minipage}\\par}
\\newcommand\\nextside{\\par\\end{minipage}\\nobreak\\hspace{\\columnsep}\\expandafter\\rebuildside@next\\rebuildside@rest\\@nil}
\\newcommand\\rebuildfigure[1]{\\@nameuse{rebuildfig@#1}}
\\newcommand\\rebuildinlinefigure[1]{\\@nameuse{rebuildinline@#1}}
${definitions}
\\makeatother
% The penalty lets TeX break a full page first, so \\pagetotal measures only the last page.
\\AtEndDocument{\\par\\penalty0\\typeout{REBUILD-TOTAL=\\the\\pagetotal}\\typeout{REBUILD-TEXTHEIGHT=\\the\\textheight}}
\\begin{document}
\\normalsize\\rebuildspacing
${header}
\\typeout{REBUILD-BODY-START=\\the\\pagetotal}
${body}
\\par\\typeout{REBUILD-BODY-END=\\the\\pagetotal}\\vfill
${footer}
\\end{document}
`
  if (!paragraphSizes.isEmpty) {
    const rows = tex.split('\n')
    for (const { range, factor } of paragraphSizes.entries) {
      if (!(range.first - 1 >= 0 && range.first - 1 < rows.length && range.last - 1 >= 0 && range.last - 1 < rows.length)) continue
      rows[range.first - 1] = String.raw`{\rebuildsize{` + f(factor, 3) + '}' + rows[range.first - 1]
      rows[range.last - 1] += String.raw`\par}`
    }
    tex = rows.join('\n')
  }
  if (!displayScales.isEmpty) {
    const rows = tex.split('\n')
    // Scaling the formula box leaves the surrounding paragraph's spacing alone.
    for (const { range, factor } of displayScales.entries) {
      if (!(range.first - 1 >= 0 && range.first - 1 < rows.length && range.last - 1 >= 0 && range.last - 1 < rows.length)) continue
      const taggedAt = rows[range.first - 1].indexOf(String.raw`\rebuildtagged{1000}`)
      if (taggedAt >= 0) {
        const row = rows[range.first - 1]
        rows[range.first - 1] = row.slice(0, taggedAt) + String.raw`\rebuildtagged{` + `${PythonNumber.round(factor * 1000)}}` + row.slice(taggedAt + String.raw`\rebuildtagged{1000}`.length)
        continue
      }
      if (alignmentEnd.contains(rows[range.last - 1])) {
        // An alignment cannot sit in a box, so it is set in smaller type, numbers and all.
        rows[range.first - 1] = String.raw`{\rebuildsize{` + f(factor, 3) + '}' + rows[range.first - 1]
        rows[range.last - 1] += '}'
        continue
      }
      const open = rows[range.first - 1].indexOf(String.raw`\[`)
      if (open >= 0) {
        const row = rows[range.first - 1]
        rows[range.first - 1] = row.slice(0, open) + String.raw`\[\rebuilddisplay{` + `${PythonNumber.round(factor * 1000)}}{` + row.slice(open + 2)
      }
      const close = rows[range.last - 1].lastIndexOf(String.raw`\]`)
      if (close >= 0) {
        const row = rows[range.last - 1]
        rows[range.last - 1] = row.slice(0, close) + String.raw`}\]` + row.slice(close + 2)
      }
    }
    tex = rows.join('\n')
  }
  return tex
}
