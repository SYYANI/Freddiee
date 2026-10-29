import { describe, expect, it } from 'vitest'
import { clampedSplitFraction, fittedScale, maximumScale, minimumScale, resolvedScale, scalingAfterDividerGrab, shouldRestoreAutomaticScaling, wheelZoomFactor } from '../src/readers/pdfScaling'

describe('PDF scaling', () => {
  it('fits the widest page inside the side margins', () => {
    expect(fittedScale(628, 612)).toBeCloseTo(1)
    expect(fittedScale(322, 612)).toBeCloseTo(0.5)
    expect(fittedScale(0, 612)).toBe(1)
    expect(fittedScale(400, 0)).toBe(1)
    expect(fittedScale(20, 612)).toBe(minimumScale)
    expect(fittedScale(100_000, 612)).toBe(maximumScale)
  })

  it('resolves fitting and manual scales', () => {
    expect(resolvedScale({ mode: 'fit' }, 0.8)).toBe(0.8)
    expect(resolvedScale({ mode: 'manual', scale: 2 }, 0.8)).toBe(2)
    expect(resolvedScale({ mode: 'manual', scale: 50 }, 0.8)).toBe(maximumScale)
  })

  it('restores fitting only within 12% of the fitted scale', () => {
    expect(shouldRestoreAutomaticScaling(1.1, 1)).toBe(true)
    expect(shouldRestoreAutomaticScaling(0.89, 1)).toBe(true)
    expect(shouldRestoreAutomaticScaling(1.13, 1)).toBe(false)
    expect(shouldRestoreAutomaticScaling(0.5, 1)).toBe(false)
    expect(shouldRestoreAutomaticScaling(1, 0)).toBe(false)
    expect(shouldRestoreAutomaticScaling(Number.NaN, 1)).toBe(false)
  })

  it('shrinks a zoomed-out pane with a narrowing divider instead of clipping it', () => {
    const grabbed = scalingAfterDividerGrab({ mode: 'manual', scale: 0.5 }, 1)
    expect(grabbed).toEqual({ mode: 'manual', scale: 0.5, capsAtFit: true })
    expect(resolvedScale(grabbed, 1)).toBe(0.5)
    expect(resolvedScale(grabbed, 0.3)).toBe(0.3)
    // Grabbing again while shrunk keeps the reader's zoom for when the pane widens.
    expect(scalingAfterDividerGrab(grabbed, 0.3)).toBe(grabbed)
    expect(scalingAfterDividerGrab({ mode: 'manual', scale: 0.95 }, 1)).toEqual({ mode: 'fit' })
    // A zoom wider than the pane was clipped on purpose.
    const zoomedIn = { mode: 'manual', scale: 2 } as const
    expect(scalingAfterDividerGrab(zoomedIn, 1)).toBe(zoomedIn)
    expect(scalingAfterDividerGrab({ mode: 'fit' }, 1)).toEqual({ mode: 'fit' })
  })

  it('follows a pinch one-to-one and steps a Command-wheel notch gently', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: true })).toBeCloseTo(Math.E)
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(-1 / 3))
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(Math.exp(-48 / 300))
  })

  it('keeps both dual panes at least 180 px wide', () => {
    expect(clampedSplitFraction(0.5, 1000)).toBe(0.5)
    expect(clampedSplitFraction(0.05, 1000)).toBeCloseTo(0.18)
    expect(clampedSplitFraction(0.95, 1000)).toBeCloseTo(0.82)
    expect(clampedSplitFraction(0.1, 300)).toBe(0.5)
    expect(clampedSplitFraction(0.3, 0)).toBe(0.5)
  })
})
