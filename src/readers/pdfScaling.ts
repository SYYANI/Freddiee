/**
 * Scaling rules shared by the PDF readers, ported from the native reader.
 *
 * A pane either fits its pages to its width (PDFKit's `autoScales`) or keeps a manual scale.
 * Pinch and Command-wheel zoom switch to a manual scale; dragging the dual-pane divider returns
 * to fitting when the manual scale is still close to the fitted one. A smaller manual scale is
 * kept but never wider than the pane, so narrowing the pane shrinks the page instead of clipping it.
 */

export const minimumScale = 0.1
export const maximumScale = 5
/** Pages keep this margin from the pane's edges, horizontally and between pages. */
export const pageSideMargin = 8

/** `capsAtFit`: shown at no more than the fitted scale, set when the divider is grabbed. */
export type PdfScaling = { mode: 'fit' } | { mode: 'manual'; scale: number; capsAtFit?: boolean }

export function clampScale(scale: number): number {
  return Math.min(maximumScale, Math.max(minimumScale, scale))
}

/** The scale at which the widest page fills the reader's width, minus its side margins. */
export function fittedScale(readerWidth: number, widestPageWidth: number): number {
  if (!(readerWidth > 0) || !(widestPageWidth > 0)) return 1
  return clampScale((readerWidth - 2 * pageSideMargin) / widestPageWidth)
}

export function resolvedScale(scaling: PdfScaling, fitted: number): number {
  if (scaling.mode === 'fit') return fitted
  const scale = clampScale(scaling.scale)
  return scaling.capsAtFit ? Math.min(scale, fitted) : scale
}

export const automaticScalingTolerance = 0.12

/** A manual scale within 12% of the fitted one goes back to fitting. */
export function shouldRestoreAutomaticScaling(currentScale: number, fitted: number, tolerance = automaticScalingTolerance): boolean {
  if (!Number.isFinite(currentScale) || !Number.isFinite(fitted) || fitted <= 0 || tolerance < 0) return false
  return Math.abs(currentScale - fitted) / fitted <= tolerance
}

/**
 * The scaling once the dual-pane divider is grabbed: near fit goes back to fitting; a smaller
 * manual scale is capped at fit; a scale wider than the pane was clipped on purpose and stays.
 */
export function scalingAfterDividerGrab(scaling: PdfScaling, fitted: number): PdfScaling {
  if (scaling.mode === 'fit') return scaling
  if (shouldRestoreAutomaticScaling(scaling.scale, fitted)) return { mode: 'fit' }
  if (scaling.capsAtFit || scaling.scale >= fitted) return scaling
  return { ...scaling, capsAtFit: true }
}

/**
 * The zoom factor for one wheel event. A trackpad pinch arrives as a Control-wheel event whose
 * delta follows the fingers, so it maps one-to-one; a Command-wheel notch zooms in smaller steps.
 */
export function wheelZoomFactor(event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1)
  return Math.exp(-delta / (event.ctrlKey ? 100 : 300))
}

export const dualDividerWidth = 8
export const minimumDualPaneWidth = 180

/** The leading pane's share of the width, keeping both panes at least 180 px wide. */
export function clampedSplitFraction(fraction: number, availableWidth: number): number {
  if (!(availableWidth > 0)) return 0.5
  const minimumFraction = Math.min(minimumDualPaneWidth, availableWidth / 2) / availableWidth
  return Math.min(Math.max(fraction, minimumFraction), 1 - minimumFraction)
}
