import type { WritingCommand } from '../../shared/types'

type Handler = (command: WritingCommand) => boolean

const handlers = new Set<Handler>()

/** The mounted writing editor handles commands such as inserting a citation at the cursor. */
export function registerWritingHandler(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function dispatchWritingCommand(command: WritingCommand): boolean {
  for (const handler of handlers) if (handler(command)) return true
  return false
}

/** Inserts a citation as its own paragraph when it is a block quote, otherwise inline. */
export function insertCitationText(markdown: string, insertion: string, at: number): { text: string; cursor: number } {
  const position = Math.min(Math.max(at, 0), markdown.length)
  if (!insertion.startsWith('>')) {
    const before = markdown.slice(0, position)
    const spacer = before && !/\s$/.test(before) ? ' ' : ''
    const text = before + spacer + insertion + markdown.slice(position)
    return { text, cursor: position + spacer.length + insertion.length }
  }
  const lineEnd = markdown.indexOf('\n', position)
  const end = lineEnd < 0 ? markdown.length : lineEnd
  const before = markdown.slice(0, end).replace(/\s+$/, '')
  const after = markdown.slice(end).replace(/^\s+/, '')
  const prefix = before ? `${before}\n\n` : ''
  const text = `${prefix}${insertion}\n\n${after}`
  return { text, cursor: prefix.length + insertion.length + 2 }
}
