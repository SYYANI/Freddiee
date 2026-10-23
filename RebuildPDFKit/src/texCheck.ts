import { PageMarkup } from './markup'
import { buildTeX } from './texSource'
import { type TeXCompiling, compileTeX } from './xelatex'

const probe = String.raw`<page font="serif" columns="2">
<header>\textit{Probe} \hfill 1</header>
<body>
\textbf{Bold} \textsc{Small Caps} \textsf{Sans} \texttt{Mono} $\overline{A}_1 \subseteq B$
\begin{multicols}{2}
中文正文使用宋体，\textit{斜体}使用楷体，\textbf{粗体}。
\columnbreak
\begin{quote}
引文。
\end{quote}
\textsf{黑体} \texttt{仿宋}
\end{multicols}
\[ \begin{aligned} x &= y \end{aligned} \]
</body>
<footer>
1
</footer>
<figures>
</figures>
<notes>
</notes>
</page>`

/**
 * Typesets a small page that uses every package and font a rebuild needs, so a missing
 * TeX package or font is reported before any page is sent to a model.
 *
 * Throws a `LatexError` naming what XeLaTeX could not load.
 */
export async function verifyTeXInstallation(compiler: TeXCompiling, directory: string): Promise<void> {
  const markup = PageMarkup.parse(probe)
  const layout = {
    pageWidth: 300, pageHeight: 400, left: 30, top: 30, textWidth: 240, textHeight: 330,
    size: 10, leading: 12, indent: 10, columnGap: 12, headerGap: 0, paragraphGap: 0
  }
  const tex = buildTeX({ markup, layout, figures: [], lineMode: 'reflow', typography: { referenceSize: 10, referenceLeading: 12 } })
  await compileTeX(directory, tex, compiler)
}
