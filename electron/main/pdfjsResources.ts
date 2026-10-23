/**
 * PDF.js validates resource bases as URL-like strings and requires a trailing forward slash,
 * even though its Node factory passes the resulting string to fs.readFile. A Windows `\\`
 * separator fails that validation; a final `/` works with Node paths on every platform.
 */
export function pdfjsResourceBase(directory: string): string {
  return `${directory.replace(/[\\/]+$/, '')}/`
}
