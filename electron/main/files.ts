import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes through a sibling temporary file, flushes it, and renames it over the target,
 * so a crash leaves either the old or the new contents, never a partial file.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'w', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameReplacing(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Windows refuses to replace a file that another process (an indexer, an antivirus scanner,
 * a viewer) briefly holds open; such a rename succeeds when tried again a moment later.
 */
async function renameReplacing(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
    }
  }
}

export function safeFileName(value: string, fallback = 'Untitled'): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
  return cleaned || fallback
}
