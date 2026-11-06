// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DualPdfView } from '../src/readers/DualPdfView'
import type { PdfViewHandle, PdfViewProps } from '../src/readers/PdfView'

const readers = vi.hoisted(() => new Map<string, PdfViewProps>())
vi.mock('../src/readers/PdfView', async () => {
  const { forwardRef, createElement, useImperativeHandle } = await import('react')
  return { PdfView: forwardRef((props: PdfViewProps, ref) => {
    readers.set(props.attachmentId, props)
    useImperativeHandle(ref, () => ({ attachment: props.attachmentId }))
    return createElement('div', { 'data-reader': props.attachmentId })
  }) }
})

let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); readers.clear(); vi.unstubAllGlobals()
})

it('keeps selection and undo controls owned by the active PDF pane when the other shadow tree reports late changes', async () => {
  const onSelection = vi.fn(), onAnnotationState = vi.fn()
  const ref = createRef<{ active(): PdfViewHandle | null }>()
  await act(async () => root.render(createElement(DualPdfView, {
    ref, paperId: 'paper', original: { url: 'original', attachmentId: 'original', label: 'Original' },
    translated: { url: 'translated', attachmentId: 'translated', label: 'Translation' },
    pageIndex: 0, onPageChange: vi.fn(), appearance: 'default', findTarget: 'original', onSelection, onAnnotationState
  })))
  const undo = { canUndo: true, canRedo: false, hasTextSelection: false }
  const empty = { canUndo: false, canRedo: false, hasTextSelection: false }
  const selection = { quote: 'Selected translation', attachmentId: 'translated', pageIndex: 0 }
  await act(async () => {
    readers.get('translated')!.onSelection!(selection)
    readers.get('translated')!.onAnnotationState!(undo)
    readers.get('original')!.onSelection!(null)
    readers.get('original')!.onAnnotationState!(empty)
  })
  expect(ref.current!.active()).toMatchObject({ attachment: 'translated' })
  expect(onSelection).toHaveBeenCalledExactlyOnceWith(selection)
  expect(onAnnotationState).toHaveBeenCalledExactlyOnceWith(undo)

  await act(async () => { container.querySelector('[data-reader="original"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  await act(async () => {
    readers.get('original')!.onSelection!(null)
    readers.get('original')!.onAnnotationState!(empty)
    readers.get('translated')!.onAnnotationState!(undo)
  })
  expect(ref.current!.active()).toMatchObject({ attachment: 'original' })
  expect(onSelection.mock.lastCall).toEqual([null])
  expect(onAnnotationState.mock.lastCall).toEqual([empty])
  expect(onAnnotationState).toHaveBeenCalledTimes(2)
})
