import type { MenuItemSpec, MessageBoxSpec } from '../../shared/types'

/** Shows a native menu below `anchor` (or at the pointer) and resolves to the chosen item id. */
export async function popupMenu(items: MenuItemSpec[], anchor?: Element | { x: number; y: number } | null): Promise<string | null> {
  let position: { x: number; y: number } | undefined
  if (anchor instanceof Element) {
    const rect = anchor.getBoundingClientRect()
    position = { x: rect.left, y: rect.bottom + 4 }
  } else if (anchor) {
    position = anchor
  }
  return window.freddie.shell.popupMenu(items, position)
}

export function messageBox(spec: MessageBoxSpec): Promise<number> {
  return window.freddie.shell.messageBox(spec)
}

/** Resolves true when the destructive first button is chosen. */
export async function confirmDestructive(message: string, detail: string, confirmTitle: string, cancelTitle: string): Promise<boolean> {
  const response = await messageBox({ type: 'warning', message, detail, buttons: [confirmTitle, cancelTitle], defaultId: 1, cancelId: 1 })
  return response === 0
}

export async function alertError(title: string, detail: string, ok: string): Promise<void> {
  await messageBox({ type: 'warning', message: title, detail, buttons: [ok], defaultId: 0, cancelId: 0 })
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Electron prefixes errors thrown in the main process.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
