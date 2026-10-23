import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'

/*
 * macOS 26 gives a window the larger "toolbar" corner radius only when it has a
 * unified NSToolbar. Electron's hiddenInset title bar has none, so its corners
 * are visibly tighter than the native app's. Attaching an empty unified toolbar
 * matches the native window shape; the web content still draws the toolbar.
 */

type Pointer = unknown

interface ObjC {
  sel: (name: string) => Pointer
  cls: (name: string) => Pointer
  send: (target: Pointer, selector: Pointer) => Pointer
  sendPointer: (target: Pointer, selector: Pointer, argument: Pointer) => Pointer
  sendString: (target: Pointer, selector: Pointer, argument: string) => Pointer
  sendLong: (target: Pointer, selector: Pointer, argument: number) => void
  sendDeferred: (target: Pointer, selector: Pointer, action: Pointer, argument: Pointer, delay: number) => void
  decodePointer: (handle: Buffer) => Pointer
}

const NSWindowToolbarStyleUnified = 3

let runtime: ObjC | null | undefined

function objc(): ObjC | null {
  if (runtime !== undefined) return runtime
  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi')
    const lib = koffi.load('/usr/lib/libobjc.A.dylib')
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')
    runtime = {
      sel: lib.func('void* sel_registerName(const char*)'),
      cls: lib.func('void* objc_getClass(const char*)'),
      send: lib.func('objc_msgSend', 'void*', ['void*', 'void*']),
      sendPointer: lib.func('objc_msgSend', 'void*', ['void*', 'void*', 'void*']),
      sendString: lib.func('objc_msgSend', 'void*', ['void*', 'void*', 'const char*']),
      sendLong: lib.func('objc_msgSend', 'void', ['void*', 'void*', 'long']),
      sendDeferred: lib.func('objc_msgSend', 'void', ['void*', 'void*', 'void*', 'void*', 'double']),
      decodePointer: (handle) => koffi.decode(handle, 'void*')
    }
  } catch (error) {
    console.warn('Unable to load the Objective-C runtime; keeping the default window corners.', error)
    runtime = null
  }
  return runtime
}

/** Gives a hidden-inset macOS window the unified-toolbar corner radius without changing its size. */
export function applyUnifiedToolbar(window: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  const rt = objc()
  if (!rt) return
  const nsWindow = rt.send(rt.decodePointer(window.getNativeWindowHandle()), rt.sel('window'))
  const identifier = rt.sendString(rt.cls('NSString'), rt.sel('stringWithUTF8String:'), 'FreddieWindowToolbar')
  const toolbar = rt.sendPointer(rt.send(rt.cls('NSToolbar'), rt.sel('alloc')), rt.sel('initWithIdentifier:'), identifier)
  rt.sendLong(nsWindow, rt.sel('setToolbarStyle:'), NSWindowToolbarStyleUnified)
  // Adding a toolbar resizes the window, and Electron reports that resize to JS
  // synchronously; doing so inside an FFI call crashes V8, so defer it a turn.
  // The toolbar also grows the frame, so restore the size before the window shows.
  const bounds = window.getBounds()
  window.once('ready-to-show', () => window.setBounds(bounds))
  rt.sendDeferred(nsWindow, rt.sel('performSelector:withObject:afterDelay:'), rt.sel('setToolbar:'), toolbar, 0)
}
