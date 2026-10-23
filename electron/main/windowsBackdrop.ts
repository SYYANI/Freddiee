import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'

const WCA_ACCENT_POLICY = 19
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4
const ACCENT_FLAG_ENABLE_GRADIENT_COLOR = 2
// WINDOWCOMPOSITIONATTRIB uses ABGR. A moderate white tint keeps text legible
// while leaving substantially more of the desktop visible than the CSS fallback.
const ACRYLIC_GRADIENT_COLOR = 0x80f7f7f7

type ApplyBackdrop = (windowHandle: Buffer) => boolean

let applyBackdrop: ApplyBackdrop | null | undefined

function loadBackdrop(): ApplyBackdrop | null {
  if (applyBackdrop !== undefined) return applyBackdrop
  if (process.platform !== 'win32') {
    applyBackdrop = null
    return applyBackdrop
  }

  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const accentPolicy = koffi.struct('FreddieAccentPolicy', {
      state: 'int32_t',
      flags: 'uint32_t',
      gradientColor: 'uint32_t',
      animationId: 'int32_t'
    })
    const compositionData = koffi.struct('FreddieWindowCompositionAttribData', {
      attribute: 'int32_t',
      data: 'void*',
      size: 'size_t'
    })
    const setWindowCompositionAttribute = user32.func(
      'int __stdcall SetWindowCompositionAttribute(void *window, FreddieWindowCompositionAttribData *data)'
    )

    applyBackdrop = (windowHandle) => {
      const policy = {
        state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
        flags: ACCENT_FLAG_ENABLE_GRADIENT_COLOR,
        gradientColor: ACRYLIC_GRADIENT_COLOR,
        animationId: 0
      }
      const data = {
        attribute: WCA_ACCENT_POLICY,
        data: koffi.as(policy, koffi.pointer(accentPolicy)),
        size: koffi.sizeof(accentPolicy)
      }
      return Boolean(setWindowCompositionAttribute(koffi.decode(windowHandle, 'void*'), data))
    }
  } catch (error) {
    console.warn('Unable to load Windows 10 Acrylic; keeping the solid window background.', error)
    applyBackdrop = null
  }
  return applyBackdrop
}

/** Applies the Windows 10 Acrylic accent policy that Electron does not expose. */
export function applyWindows10Acrylic(window: BrowserWindow): boolean {
  const apply = loadBackdrop()
  if (!apply) return false
  try {
    return apply(window.getNativeWindowHandle())
  } catch (error) {
    console.warn('Unable to apply Windows 10 Acrylic; keeping the solid window background.', error)
    return false
  }
}
