import { createRequire } from 'node:module'
import { platform, release } from 'node:os'
import type { BrowserWindow } from 'electron'

type EnableBlur = (handle: Buffer) => boolean
let enableLegacyBlur: EnableBlur | null | undefined

function legacyBlur(): EnableBlur | null {
  if (enableLegacyBlur !== undefined) return enableLegacyBlur
  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const accentPolicy = koffi.struct({
      AccentState: 'int32', AccentFlags: 'uint32', GradientColor: 'uint32', AnimationId: 'uint32'
    })
    // Use native pointer alignment and UINT, including on Windows ARM64.
    // https://learn.microsoft.com/en-us/windows/win32/dwm/windowcompositionattribdata
    const attributeData = koffi.struct({
      Attrib: 'int32', pvData: koffi.pointer(accentPolicy), cbData: 'uint32'
    })
    const setAttribute = user32.func('__stdcall', 'SetWindowCompositionAttribute', 'int32', [
      'void*', koffi.pointer(attributeData)
    ])
    enableLegacyBlur = (handle) => {
      // The Buffer contains HWND; its address is not HWND. Keep all pointer bits.
      const hwnd = koffi.decode(handle, 'void*')
      if (!hwnd) return false
      return Boolean(setAttribute(hwnd, {
        Attrib: 19, // WCA_ACCENT_POLICY (undocumented accent policy)
        pvData: {
          // The simpler blur avoids Win10 Acrylic's drag/resize performance problems.
          AccentState: 3, // ACCENT_ENABLE_BLURBEHIND
          AccentFlags: 2, GradientColor: 0, AnimationId: 0
        },
        cbData: koffi.sizeof(accentPolicy)
      }))
    }
  } catch (error) {
    console.warn('Unable to load Windows blur; keeping an opaque window background.', error)
    enableLegacyBlur = null
  }
  return enableLegacyBlur
}

/** Main-process-only desktop blur; never changes the window's transparent/resize behavior. */
export function applyWindowsBackdrop(window: BrowserWindow): boolean {
  if (platform() !== 'win32') return false
  const [major, , build] = release().split('.').map(Number)
  if (major !== 10 || !Number.isInteger(build) || build < 10240) return false
  try {
    if (build >= 22621) {
      // Electron's supported API is restricted to Windows 11 22H2 and newer.
      window.setBackgroundMaterial('acrylic')
      return true
    }
    return legacyBlur()?.(window.getNativeWindowHandle()) ?? false
  } catch (error) {
    console.warn('Unable to apply Windows blur; keeping an opaque window background.', error)
    return false
  }
}
