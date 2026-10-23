// Compiles a translated project with the installed TeX distribution: the Simplified Chinese
// preamble, BibTeX through latexmk, and Freddie's restrictions (no shell escape, paranoid file
// access). Skipped when latexmk or XeLaTeX is not installed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LaTeXCompiler, type LaTeXPromptCompleting, type LaTeXPromptRequest } from '../LaTeXTransKit/src'
import { LaTeXTranslationService, ToolchainProcessRunner, compilerEngines } from '../LaTeXTransKit'
import type { ResolvedRoute } from '../electron/main/llm'
import { createTranslator } from '../shared/i18n'

function findTool(name: string): string | undefined {
  const executable = process.platform === 'win32' ? `${name}.exe` : name
  const directories = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), '/Library/TeX/texbin', '/usr/local/texlive/2026/bin/x86_64-linux']
  return directories.map((directory) => join(directory, executable)).find((path) => existsSync(path))
}

const latexmk = findTool('latexmk')
const xelatex = findTool('xelatex')
const work = mkdtempSync(join(tmpdir(), 'latextrans-compile-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** Translates each slot into fixed Chinese text. */
const client: LaTeXPromptCompleting = {
  async complete(request: LaTeXPromptRequest): Promise<string> {
    if (request.purpose.kind === 'summary') return '摘要。'
    const user = request.messages[request.messages.length - 1].content
    const slots = JSON.parse(user.split('[Translation slots JSON]\n')[1].split('\n')[0]) as Array<{ id: string }>
    return JSON.stringify(slots.map((slot) => ({ id: slot.id, translation: `中文译文${slot.id}` })))
  }
}

const route: ResolvedRoute = { providerId: 'p', providerName: 'P', modelId: 'm', modelName: 'm', baseURL: 'https://example.com', apiStyle: 'chat-completions', apiKey: 'k' }

describe.skipIf(!latexmk || !xelatex)('LaTeX translation with a real TeX installation', () => {
  it('compiles the translated project to a PDF with XeLaTeX and BibTeX', async () => {
    const project = join(work, 'source')
    mkdirSync(project)
    writeFileSync(join(project, 'main.tex'), String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\pdfoutput=1
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\newtheorem{theorem}{Theorem}
\title{Structured Translation}
\author{Ada Lovelace}
\begin{document}
\maketitle
\begin{abstract}
We translate papers while keeping their structure, reaching 95\% accuracy on 10-12$\times$ longer inputs.
\end{abstract}
\section{Introduction}
Structured translation keeps equations such as $E=mc^2$ and citations \cite{knuth} intact.
\begin{theorem}[Main result]
Every unit can be translated independently.
\end{theorem}
\begin{equation}
  y = Wx + b \label{eq:linear}
\end{equation}
Equation~\eqref{eq:linear} is linear.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`)
    writeFileSync(join(project, 'refs.bib'), '@book{knuth, title={The TeXbook}, author={Donald E. Knuth}, year={1984}, publisher={Addison-Wesley}}\n')
    const service = new LaTeXTranslationService({
      t: createTranslator('en'),
      compiler: new LaTeXCompiler({ runner: new ToolchainProcessRunner(latexmk!), engines: [...compilerEngines] }),
      acquirer: { acquireProject: async () => ({ kind: 'localDirectory', path: project }) },
      client: () => client
    })
    const output = await service.translate({
      paperDirectory: join(work, 'paper'), arxivIdentifier: '2401.00001v1', targetLanguage: 'zh-CN', maximumConcurrency: 2,
      glossary: '', documentSummary: 'A compile fixture.', route
    }, () => {})
    const logs = output.failedCompilationAttempts.flatMap((attempt) => attempt.logPaths).filter(existsSync).map((path) => readFileSync(path, 'utf8').slice(-3000))
    expect(output.pdfCompilationFailed, logs.join('\n----\n')).toBe(false)
    const compilation = output.artifact.compilation!
    expect(compilation.attempts.map((attempt) => [attempt.engine, attempt.succeeded])).toEqual([['xelatex', true]])
    expect(statSync(output.artifact.pdfPath!).size).toBeGreaterThan(10_000)
    const main = readFileSync(join(output.artifact.projectDirectory, 'main.tex'), 'utf8')
    expect(main).toContain('\\usepackage[UTF8,fontset=fandol]{ctex}')
    expect(main).toContain('中文译文')
    expect(existsSync(join(output.artifact.projectDirectory, 'compilation', 'xelatex', 'main.bbl'))).toBe(true)
  }, 300_000)
})
