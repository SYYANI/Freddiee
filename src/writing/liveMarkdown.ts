import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import katex from 'katex'

/** Typography of the live Markdown editor, after WritingTypography. */
export const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '600' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '600' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontSize: '1.05em', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--link)' },
  { tag: tags.url, color: 'var(--text-tertiary)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
  { tag: tags.quote, color: 'var(--text-secondary)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--text-tertiary)' },
  { tag: tags.list, color: 'var(--text-secondary)' }
])

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-inline-image'
    const image = document.createElement('img')
    image.src = this.src
    image.alt = this.alt
    image.draggable = false
    wrapper.appendChild(image)
    return wrapper
  }
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = this.display ? 'cm-math cm-math-display' : 'cm-math'
    try {
      element.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: true, output: 'html' })
    } catch {
      element.className += ' cm-math-invalid'
      element.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`
    }
    return element
  }

  ignoreEvent(): boolean {
    return false
  }
}

const hidden = Decoration.replace({})
const citationMark = Decoration.mark({ class: 'cm-citation' })
const linkMark = Decoration.mark({ class: 'cm-link-label' })

/**
 * Hides link and image syntax, and typesets math, except on lines holding the cursor, so the
 * Markdown reads like the rendered document while stay editable as text.
 */
export function liveMarkdown(resolveImage: (path: string) => string, onOpenLink: (destination: string, title: string | undefined, position: number) => void): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view)
    }

    build(view: EditorView): DecorationSet {
      const builder: Array<{ from: number; to: number; decoration: Decoration }> = []
      const { state } = view
      const activeLines = new Set<number>()
      if (view.hasFocus) for (const range of state.selection.ranges) {
        const first = state.doc.lineAt(range.from).number
        const last = state.doc.lineAt(range.to).number
        for (let line = first; line <= last; line += 1) activeLines.add(line)
      }
      const isActive = (from: number, to: number): boolean => {
        const first = state.doc.lineAt(from).number
        const last = state.doc.lineAt(to).number
        for (let line = first; line <= last; line += 1) if (activeLines.has(line)) return true
        return false
      }
      const tree = syntaxTree(state)
      for (const { from, to } of view.visibleRanges) {
        tree.iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== 'Link' && node.name !== 'Image') return
            const text = state.doc.sliceString(node.from, node.to)
            const match = text.match(/^(!?)\[([\s\S]*?)\]\(\s*<?([^)\s>]+)>?(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)$/)
            if (!match) return false
            const [, bang, label, destination] = match
            if (bang) {
              if (!isActive(node.from, node.to) && !/^https?:/i.test(destination)) {
                builder.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new ImageWidget(resolveImage(destination), label) }) })
              }
              return false
            }
            const labelStart = node.from + 1
            const labelEnd = labelStart + label.length
            const isCitation = /^readpaper:\/\//i.test(destination)
            builder.push({ from: labelStart, to: labelEnd, decoration: isCitation ? citationMark : linkMark })
            if (!isActive(node.from, node.to)) {
              builder.push({ from: node.from, to: labelStart, decoration: hidden })
              builder.push({ from: labelEnd, to: node.to, decoration: hidden })
            }
            return false
          }
        })
        // Inline and display math are not part of CommonMark, so they are found by pattern.
        const text = state.doc.sliceString(from, to)
        for (const match of text.matchAll(/\$\$([^$\n]+?)\$\$|(?<![\\$])\$([^\s$](?:[^$\n]*?[^\s\\$])?)\$(?!\d)/g)) {
          const start = from + (match.index ?? 0)
          const end = start + match[0].length
          if (isActive(start, end)) {
            builder.push({ from: start, to: end, decoration: Decoration.mark({ class: 'cm-math-source' }) })
          } else {
            builder.push({ from: start, to: end, decoration: Decoration.replace({ widget: new MathWidget((match[1] ?? match[2]).trim(), Boolean(match[1])) }) })
          }
        }
      }
      builder.sort((a, b) => a.from - b.from || a.to - b.to)
      const set = new RangeSetBuilder<Decoration>()
      let lastEnd = -1
      for (const item of builder) {
        // Skip ranges that overlap a replaced range.
        if (item.from < lastEnd && item.decoration !== citationMark && item.decoration !== linkMark) continue
        set.add(item.from, item.to, item.decoration)
        if (item.decoration.spec.widget || item.decoration === hidden) lastEnd = Math.max(lastEnd, item.to)
      }
      return set.finish()
    }
  }, { decorations: (instance) => instance.decorations })

  const clicks = EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.metaKey || event.ctrlKey)) return false
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (position === null) return false
      let handled = false
      syntaxTree(view.state).iterate({
        from: position,
        to: position,
        enter: (node) => {
          if (node.name !== 'Link' || handled) return
          const text = view.state.doc.sliceString(node.from, node.to)
          const match = text.match(/\]\(\s*<?([^)\s>]+)>?(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)$/)
          if (match) {
            handled = true
            onOpenLink(match[1], match[2]?.replace(/\\(.)/g, '$1'), node.from)
          }
        }
      })
      if (handled) event.preventDefault()
      return handled
    }
  })

  return [syntaxHighlighting(markdownHighlight), plugin, clicks]
}
