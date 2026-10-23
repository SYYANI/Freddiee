import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'

/* Native AppKit treatments that Electron does not expose directly. */

type Pointer = unknown
type Rect = {
  origin: { x: number; y: number }
  size: { width: number; height: number }
}

interface ObjC {
  sel: (name: string) => Pointer
  cls: (name: string) => Pointer
  send: (target: Pointer, selector: Pointer) => Pointer
  sendPointer: (target: Pointer, selector: Pointer, argument: Pointer) => Pointer
  sendRect: (target: Pointer, selector: Pointer, argument: Rect) => Pointer
  sendString: (target: Pointer, selector: Pointer, argument: string) => Pointer
  sendLong: (target: Pointer, selector: Pointer, argument: number) => void
  sendSubview: (target: Pointer, selector: Pointer, view: Pointer, position: number, relativeTo: Pointer | null) => void
  sendDeferred: (target: Pointer, selector: Pointer, action: Pointer, argument: Pointer, delay: number) => void
  decodePointer: (handle: Buffer) => Pointer
}

const NSWindowToolbarStyleUnified = 3
const NSGlassEffectViewStyleRegular = 0
const NSViewWidthSizable = 2
const NSViewHeightSizable = 16
const NSWindowBelow = -1

let runtime: ObjC | null | undefined

function objc(): ObjC | null {
  if (runtime !== undefined) return runtime
  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi')
    const lib = koffi.load('/usr/lib/libobjc.A.dylib')
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')
    const point = koffi.struct({ x: 'double', y: 'double' })
    const size = koffi.struct({ width: 'double', height: 'double' })
    const rect = koffi.struct({ origin: point, size })
    runtime = {
      sel: lib.func('void* sel_registerName(const char*)'),
      cls: lib.func('void* objc_getClass(const char*)'),
      send: lib.func('objc_msgSend', 'void*', ['void*', 'void*']),
      sendPointer: lib.func('objc_msgSend', 'void*', ['void*', 'void*', 'void*']),
      sendRect: lib.func('objc_msgSend', 'void*', ['void*', 'void*', rect]),
      sendString: lib.func('objc_msgSend', 'void*', ['void*', 'void*', 'const char*']),
      sendLong: lib.func('objc_msgSend', 'void', ['void*', 'void*', 'long']),
      sendSubview: lib.func('objc_msgSend', 'void', ['void*', 'void*', 'void*', 'long', 'void*']),
      sendDeferred: lib.func('objc_msgSend', 'void', ['void*', 'void*', 'void*', 'void*', 'double']),
      decodePointer: (handle) => koffi.decode(handle, 'void*')
    }
  } catch (error) {
    console.warn('Unable to load the Objective-C runtime; keeping Electron window materials.', error)
    runtime = null
  }
  return runtime
}

/** Whether this macOS release exposes the native Liquid Glass view introduced in macOS 26. */
export function supportsLiquidGlass(): boolean {
  if (process.platform !== 'darwin') return false
  const rt = objc()
  return Boolean(rt?.cls('NSGlassEffectView'))
}

/** Inserts native Liquid Glass underneath Electron's transparent web content. */
export function applyLiquidGlass(window: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false
  const rt = objc()
  if (!rt) return false
  const glassClass = rt.cls('NSGlassEffectView')
  if (!glassClass) return false

  try {
    const rootView = rt.decodePointer(window.getNativeWindowHandle())
    const [width, height] = window.getContentSize()
    const frame: Rect = { origin: { x: 0, y: 0 }, size: { width, height } }
    const glassView = rt.sendRect(rt.send(glassClass, rt.sel('alloc')), rt.sel('initWithFrame:'), frame)
    if (!glassView) return false

    rt.sendLong(glassView, rt.sel('setStyle:'), NSGlassEffectViewStyleRegular)
    rt.sendPointer(glassView, rt.sel('setTintColor:'), rt.send(rt.cls('NSColor'), rt.sel('clearColor')))
    rt.sendLong(glassView, rt.sel('setAutoresizingMask:'), NSViewWidthSizable | NSViewHeightSizable)
    rt.sendSubview(rootView, rt.sel('addSubview:positioned:relativeTo:'), glassView, NSWindowBelow, null)
    return true
  } catch (error) {
    console.warn('Unable to install native Liquid Glass; falling back to Electron vibrancy.', error)
    return false
  }
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
