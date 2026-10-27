import koffi from 'koffi'
import { release } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requireKoffi } = vi.hoisted(() => ({ requireKoffi: vi.fn() }))
vi.mock('node:module', async (original) => ({
  ...await original<typeof import('node:module')>(),
  createRequire: () => requireKoffi
}))
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  release: vi.fn()
}))

const callbacks: bigint[] = []
type NativeType = Parameters<typeof koffi.type>[0]
let nativeResult: number
let calls: { handle: bigint; attribute: number; size: number; policy: number[] }[]
let load: ReturnType<typeof vi.fn>

const handleValue = koffi.sizeof('void *') === 8 ? 0x1234567812345678n : 0x12345678n

function makeWindow() {
  const handle = Buffer.alloc(koffi.sizeof('void *'))
  koffi.encode(handle, 'uintptr_t', handleValue)
  const window = {
    getNativeWindowHandle: vi.fn(() => handle),
    setBackgroundMaterial: vi.fn(),
    setBackgroundColor: vi.fn()
  }
  return window
}

async function loadBackdrop() {
  const module = await import('../electron/main/windowsBackdrop')
  return { ...module, apply: (window: ReturnType<typeof makeWindow>) => module.applyWindowsBackdrop(window as never, module.windowsBackdrop()) }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.mocked(release).mockReturnValue('10.0.19045')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  nativeResult = 1
  calls = []
  load = vi.fn(() => ({
    func: (convention: string, name: string, result: NativeType, parameters: NativeType[]) => {
      expect(convention).toBe('__stdcall')
      expect(name).toBe('SetWindowCompositionAttribute')
      expect(result).toBe('int32_t')
      const prototype = koffi.proto(convention, result, parameters)
      // Use real Koffi marshalling and a native callback trampoline, without user32.dll.
      const attributeData = koffi.struct({ attribute: 'uint32_t', data: 'void *', size: 'size_t' })
      const callback = koffi.register((handle: bigint, pointer: bigint) => {
        const decoded = koffi.decode(pointer, attributeData)
        calls.push({
          handle,
          attribute: decoded.attribute,
          size: decoded.size,
          policy: Array.from(koffi.decode(decoded.data, 'uint32_t', 4))
        })
        return nativeResult
      }, koffi.pointer(prototype))
      callbacks.push(callback)
      return (...args: unknown[]) => koffi.call(callback, prototype, ...args)
    }
  }))
  requireKoffi.mockReset().mockReturnValue({ ...koffi, load })
})

afterEach(() => {
  for (const callback of callbacks.splice(0)) koffi.unregister(callback)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Windows window backdrop', () => {
  it('marshals the HWND, pointer-aligned attribute data, and tinted blur policy on Windows 10', async () => {
    const { windowsBackdrop, apply } = await loadBackdrop()
    const window = makeWindow()

    expect(windowsBackdrop()).toBe('legacy')
    apply(window)

    expect(requireKoffi).toHaveBeenCalledWith('koffi')
    expect(load).toHaveBeenCalledWith('user32.dll')
    expect(calls).toEqual([{ handle: handleValue, attribute: 19, size: 16, policy: [3, 2, 0xccf3f3f3, 0] }])
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(window.setBackgroundColor).not.toHaveBeenCalled()
  })

  it.each(['10.0.22000', '10.0.22620'])('uses the legacy path before Windows 11 22H2 (%s)', async (version) => {
    vi.mocked(release).mockReturnValue(version)
    const { windowsBackdrop } = await loadBackdrop()

    expect(windowsBackdrop()).toBe('legacy')
  })

  it.each(['10.0.22621', '10.0.26100'])('keeps the Electron material on Windows 11 22H2+ (%s)', async (version) => {
    vi.mocked(release).mockReturnValue(version)
    const { windowsBackdrop, apply } = await loadBackdrop()
    const window = makeWindow()

    expect(windowsBackdrop()).toBe('system')
    apply(window)

    expect(window.setBackgroundMaterial).toHaveBeenCalledWith('acrylic')
    expect(requireKoffi).not.toHaveBeenCalled()
  })

  it('restores a solid background when the native API returns FALSE', async () => {
    nativeResult = 0
    const { apply } = await loadBackdrop()
    const window = makeWindow()

    apply(window)

    expect(window.setBackgroundColor).toHaveBeenCalledWith('#f3f3f3')
  })

  it('binds once and reports no backdrop when user32 cannot be bound', async () => {
    load.mockImplementation(() => { throw new Error('Missing native export') })
    const { windowsBackdrop, apply } = await loadBackdrop()
    const window = makeWindow()

    expect(windowsBackdrop()).toBe('none')
    expect(windowsBackdrop()).toBe('none')
    apply(window)

    expect(load).toHaveBeenCalledTimes(1)
    expect(window.getNativeWindowHandle).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it.each(['10.0.17134', '6.3.9600', 'invalid'])('reports no backdrop on unsupported releases (%s)', async (version) => {
    vi.mocked(release).mockReturnValue(version)
    const { windowsBackdrop } = await loadBackdrop()

    expect(windowsBackdrop()).toBe('none')
    expect(requireKoffi).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'])('leaves %s windows alone and never loads Koffi', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    const { windowsBackdrop, apply } = await loadBackdrop()
    const window = makeWindow()

    expect(windowsBackdrop()).toBe('none')
    apply(window)

    expect(requireKoffi).not.toHaveBeenCalled()
    expect(window.getNativeWindowHandle).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })
})
