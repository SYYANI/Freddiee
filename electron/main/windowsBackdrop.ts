import { createRequire } from 'node:module'
import { platform, release } from 'node:os'
import type { BrowserWindow } from 'electron'

type EnableBlur = (handle: Buffer, acrylic: boolean) => boolean
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
    const dwmapi = koffi.load('dwmapi.dll')
    const margins = koffi.struct({
      cxLeftWidth: 'int32', cxRightWidth: 'int32', cyTopHeight: 'int32', cyBottomHeight: 'int32'
    })
    const extendFrame = dwmapi.func('__stdcall', 'DwmExtendFrameIntoClientArea', 'int32', [
      'void*', koffi.pointer(margins)
    ])
    enableLegacyBlur = (handle, acrylic) => {
      // The Buffer contains HWND; its address is not HWND. Keep all pointer bits.
      const hwnd = koffi.decode(handle, 'void*')
      if (!hwnd) return false
      const accepted = Boolean(setAttribute(hwnd, {
        Attrib: 19, // WCA_ACCENT_POLICY (undocumented accent policy)
        pvData: {
          // Older BlurBehind can return success without visible blur on recent Win10.
          AccentState: acrylic ? 4 : 3,
          AccentFlags: acrylic ? 0 : 2,
          // Acrylic requires nonzero tint alpha; CSS supplies the visible surface tint.
          GradientColor: acrylic ? 0x01ffffff : 0,
          AnimationId: 0
        },
        cbData: koffi.sizeof(accentPolicy)
      }))
      if (!accepted) {
        console.warn('Windows rejected the backdrop accent policy; keeping an opaque background.')
        return false
      }
      // Electron only performs this step for its Win11 material API. On Win10,
      // extending the glass into the client area is also needed for page alpha.
      // https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmextendframeintoclientarea
      const result = extendFrame(hwnd, {
        cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1
      })
      if (result < 0) {
        setAttribute(hwnd, {
          Attrib: 19,
          pvData: { AccentState: 0, AccentFlags: 0, GradientColor: 0, AnimationId: 0 },
          cbData: koffi.sizeof(accentPolicy)
        })
        console.warn(`Windows rejected client-area glass (HRESULT ${result}); keeping an opaque background.`)
        return false
      }
      return true
    }
  } catch (error) {
    console.warn('Unable to load Windows blur; keeping an opaque window background.', error)
    enableLegacyBlur = null
  }
  return enableLegacyBlur
}

/** Main-process-only desktop material; true means both native calls accepted it, not a visual check. */
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
    const accepted = legacyBlur()?.(window.getNativeWindowHandle(), build >= 17763) ?? false
    if (accepted) console.info(`[Freddie backdrop] Windows ${build}: ${build >= 17763 ? 'Acrylic' : 'BlurBehind'} + client-area glass requested.`)
    return accepted
  } catch (error) {
    console.warn('Unable to apply Windows blur; keeping an opaque window background.', error)
    return false
  }
}
