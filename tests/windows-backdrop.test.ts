import type { BrowserWindow } from 'electron'
import koffi from 'koffi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  platform: 'win32', release: '10.0.19045',
  load: vi.fn(), setAttribute: vi.fn(), signature: vi.fn()
}))
vi.mock('node:os', () => ({ platform: () => native.platform, release: () => native.release }))
vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>()
  return {
    ...original,
    createRequire: (filename: string) => {
      const require = original.createRequire(filename)
      return (name: string) => name === 'koffi' ? { ...require(name), load: native.load } : require(name)
    }
  }
})

function windowStub(handle = 0x100001234n) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(handle)
  return {
    getNativeWindowHandle: vi.fn(() => buffer),
    setBackgroundMaterial: vi.fn()
  }
}

async function apply(window: ReturnType<typeof windowStub>): Promise<boolean> {
  const { applyWindowsBackdrop } = await import('../electron/main/windowsBackdrop')
  return applyWindowsBackdrop(window as unknown as BrowserWindow)
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  native.platform = 'win32'
  native.release = '10.0.19045'
  native.setAttribute.mockReset().mockReturnValue(1)
  native.signature.mockImplementation(() => native.setAttribute)
  native.load.mockReset().mockReturnValue({ func: native.signature })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('Windows desktop backdrop', () => {
  it('marshals the nested policy through a real native call boundary', async () => {
    let callback: bigint | undefined
    let received: unknown
    native.signature.mockImplementation((convention, _name, result, args) => {
      const prototype = koffi.proto(convention, result, args)
      callback = koffi.register((hwnd: bigint, dataPointer: bigint) => {
        const data = koffi.decode(dataPointer, args[1].ref)
        received = {
          hwnd, size: data.cbData, attribute: data.Attrib,
          policy: koffi.decode(data.pvData, args[1].ref.members.pvData.type.ref)
        }
        return 1
      }, koffi.pointer(prototype))
      return (...values: unknown[]) => koffi.call(callback, prototype, ...values)
    })
    try {
      expect(await apply(windowStub())).toBe(true)
      expect(received).toEqual({
        hwnd: 0x100001234n, size: 16, attribute: 19,
        policy: { AccentState: 3, AccentFlags: 2, GradientColor: 0, AnimationId: 0 }
      })
    } finally {
      if (callback !== undefined) koffi.unregister(callback)
    }
  })

  it('uses the legacy Win10 blur with a full-width HWND and native-aligned structures', async () => {
    const window = windowStub()
    expect(await apply(window)).toBe(true)
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(native.load).toHaveBeenCalledWith('user32.dll')
    expect(native.setAttribute).toHaveBeenCalledWith(0x100001234n, {
      Attrib: 19,
      pvData: { AccentState: 3, AccentFlags: 2, GradientColor: 0, AnimationId: 0 },
      cbData: 16
    })
    const [convention, name, result, args] = native.signature.mock.calls[0]
    expect([convention, name, result, args[0]]).toEqual([
      '__stdcall', 'SetWindowCompositionAttribute', 'int32', 'void*'
    ])
    const data = args[1].ref
    expect(data.members.pvData.offset).toBe(8)
    expect(data.members.cbData.offset).toBe(16)
    expect(data.size).toBe(24)
  })

  it.each(['10.0.22000', '10.0.22620'])('handles early Win11 (%s) through the legacy path', async (release) => {
    native.release = release
    expect(await apply(windowStub())).toBe(true)
    expect(native.setAttribute).toHaveBeenCalledOnce()
  })

  it.each(['10.0.22621', '10.0.26100'])('uses Electron Acrylic on supported Windows (%s)', async (release) => {
    native.release = release
    const window = windowStub()
    expect(await apply(window)).toBe(true)
    expect(window.setBackgroundMaterial).toHaveBeenCalledWith('acrylic')
    expect(native.load).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'])('does not load Windows DLLs on %s', async (platform) => {
    native.platform = platform
    expect(await apply(windowStub())).toBe(false)
    expect(native.load).not.toHaveBeenCalled()
  })

  it.each(['6.3.9600', '10.0.10239', 'unknown'])('keeps unsupported/unknown Windows (%s) opaque', async (release) => {
    native.release = release
    expect(await apply(windowStub())).toBe(false)
    expect(native.load).not.toHaveBeenCalled()
  })

  it('rejects a null HWND without calling user32', async () => {
    expect(await apply(windowStub(0n))).toBe(false)
    expect(native.setAttribute).not.toHaveBeenCalled()
  })

  it('reports a rejected native call instead of enabling translucent CSS', async () => {
    native.setAttribute.mockReturnValue(0)
    expect(await apply(windowStub())).toBe(false)
  })

  it('caches missing DLL/symbol failures and allows window creation to continue', async () => {
    native.load.mockImplementation(() => { throw new Error('unavailable') })
    expect(await apply(windowStub())).toBe(false)
    expect(await apply(windowStub())).toBe(false)
    expect(native.load).toHaveBeenCalledOnce()
  })

  it('allows window creation to continue after a native-call exception', async () => {
    native.setAttribute.mockImplementation(() => { throw new Error('unavailable') })
    expect(await apply(windowStub())).toBe(false)
  })

  it('keeps the opaque fallback if Electron rejects Acrylic', async () => {
    native.release = '10.0.22621'
    const window = windowStub()
    window.setBackgroundMaterial.mockImplementation(() => { throw new Error('unavailable') })
    expect(await apply(window)).toBe(false)
  })
})
