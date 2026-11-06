/** Chromium exposes the real, cross-page selection through the shared text shadow root. */
export function pdfSelection(root: ShadowRoot | undefined): Selection | null {
  const selection = (root as (ShadowRoot & { getSelection?: () => Selection | null }) | undefined)?.getSelection?.()
  return selection ?? window.getSelection()
}

export function pdfContains(element: Element, textRoot: ShadowRoot | undefined, node: Node | null): boolean {
  return Boolean(node && (element.contains(node) || textRoot?.contains(node)))
}

/** DOM events are retargeted at the shadow host; gestures need the actual text/link target. */
export function pdfEventTarget(event: Event): Element | null {
  return event.composedPath().find((node): node is Element => node instanceof Element) ?? (event.target instanceof Element ? event.target : null)
}
