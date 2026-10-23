/**
 * Scan a brace group whose opening brace ends just before `start`; returns the UTF-16 offset
 * after the closing brace, or undefined when the group is never closed. A backslash escapes
 * the next unit.
 */
export function closingBrace(text: string, start: number): number | undefined {
  let end = start
  let depth = 1
  while (end < text.length && depth !== 0) {
    const unit = text.charCodeAt(end)
    if (unit === 0x5C) {
      end += 2
      continue
    }
    if (unit === 0x7B) depth += 1
    else if (unit === 0x7D) depth -= 1
    end += 1
  }
  return depth === 0 ? Math.min(end, text.length) : undefined
}

/** `_group_end`: the offset just past the brace closing a group whose opening brace ends before `index`. */
export function groupEnd(text: string, index: number): number | undefined {
  return closingBrace(text, index)
}
