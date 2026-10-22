import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { AnchorHTMLAttributes } from 'react'

function ExternalLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (href && /^https?:/i.test(href)) void window.freddie.shell.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** Markdown with GFM and math, as note previews render it. */
export function NoteMarkdown({ markdown, className }: { markdown: string; className?: string }): JSX.Element {
  return (
    <div className={`markdown ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ a: ExternalLink }}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
