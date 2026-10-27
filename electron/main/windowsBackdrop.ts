import { createRequire } from 'node:module'
import { release } from 'node:os'
import type { BrowserWindow } from 'electron'

/** `system` is Electron's DWM material; `legacy` is the Windows 10 Accent policy. */
export type WindowsBackdrop = 'system' | 'legacy' | 'none'

type BackdropWindow = Pick<BrowserWindow, 'getNativeWindowHandle' | 'setBackgroundMaterial' | 'setBackgroundColor'>

// Plain blur rather than Acrylic: it looks lighter and does not stutter while dragging.
const ACCENT_ENABLE_BLURBEHIND = 3
const SOLID_BACKGROUND = '#f3f3f3'

type SetAccent = (handle: Buffer) => boolean

let resolved: WindowsBackdrop | undefined
let setAccent: SetAccent | undefined

/** Bind the undocumented user32 export that Windows 10 desktop windows use for blur. */
function bindAccentPolicy(): SetAccent {
  const koffi = createRequire(__filename)('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')
  const accentPolicy = koffi.struct({
    AccentState: 'uint32_t',
    AccentFlags: 'uint32_t',
    GradientColor: 'uint32_t',
    AnimationId: 'uint32_t'
  })
  const attributeData = koffi.struct({
    Attrib: 'uint32_t',
    pvData: 'void *',
    cbData: 'size_t'
  })
  // BOOL is a 32-bit integer; HWND and SIZE_T must retain native pointer width.
  const setAttribute = user32.func('__stdcall', 'SetWindowCompositionAttribute', 'int32_t', [
    'void *', koffi.pointer(attributeData)
  ])
  return (handle) => {
    const policy = Buffer.alloc(koffi.sizeof(accentPolicy))
    koffi.encode(policy, accentPolicy, {
      AccentState: ACCENT_ENABLE_BLURBEHIND,
      AccentFlags: 2, // Draw GradientColor over the blur.
      GradientColor: 0xccf3f3f3, // AABBGGRR: translucent light gray, never zero alpha.
      AnimationId: 0
    })
    return setAttribute(koffi.decode(handle, 'void *'), {
      Attrib: 19, // WCA_ACCENT_POLICY
      pvData: policy,
      cbData: policy.length
    }) !== 0
  }
}

/** Decide once, before any window exists, because the legacy path needs a transparent window. */
export function windowsBackdrop(): WindowsBackdrop {
  if (resolved) return resolved
  resolved = 'none'
  if (process.platform !== 'win32') return resolved
  const [major, , build] = release().split('.').map(Number)
  if (!(major >= 10)) return resolved

  if (build >= 22621) {
    resolved = 'system'
  } else if (build >= 17763) {
    try {
      setAccent = bindAccentPolicy()
      resolved = 'legacy'
    } catch (error) {
      console.warn('Unable to bind the native Accent policy; using a solid background.', error)
    }
  }
  return resolved
}

/** Keep native handles and FFI in main; failure must leave an opaque, readable window. */
export function applyWindowsBackdrop(window: BackdropWindow): void {
  const backdrop = windowsBackdrop()
  if (backdrop === 'system') {
    window.setBackgroundMaterial('acrylic')
    return
  }
  if (backdrop !== 'legacy' || !setAccent) return

  try {
    if (setAccent(window.getNativeWindowHandle())) return
    console.warn('Windows rejected the native blur material; using a solid background.')
  } catch (error) {
    console.warn('Unable to apply native blur; using a solid background.', error)
  }
  window.setBackgroundColor(SOLID_BACKGROUND)
}
