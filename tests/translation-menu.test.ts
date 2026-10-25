import { describe, expect, it } from 'vitest'
import { isCompleteTranslation } from '../shared/library'
import type { Attachment } from '../shared/types'
import { translationMenuEntries, type TranslationMenuState } from '../src/main-window/translationMenu'

const base: TranslationMenuState = {
  hasHTML: false,
  hasPDF: true,
  pdfHasText: true,
  isPartialPDFTranslation: false,
  isFullPDFTranslationComplete: false,
  latexTranslationEnabled: false,
  hasArxivID: false
}

describe('translation menu parity with native Freddie', () => {
  it('offers one text-PDF action and a separate scanned-PDF action', () => {
    expect(translationMenuEntries(base)).toEqual([
      { id: 'html', label: 'Translate HTML', enabled: false },
      { id: 'pdf', label: 'Translate PDF', enabled: true },
      { id: 'scan', label: 'Translate Scanned PDF…', enabled: true }
    ])
  })

  it('disables direct PDF translation when no text layer is available', () => {
    expect(translationMenuEntries({ ...base, pdfHasText: false })).toContainEqual(
      { id: 'pdf', label: 'Translate PDF', enabled: false }
    )
    expect(translationMenuEntries({ ...base, pdfHasText: false })).toContainEqual(
      { id: 'scan', label: 'Translate Scanned PDF…', enabled: true }
    )
  })

  it('changes the PDF action for partial and complete translations', () => {
    expect(translationMenuEntries({
      ...base,
      isPartialPDFTranslation: true,
      translatedSource: 'babeldoc'
    })[1].label).toBe('Translate More PDF Pages')
    expect(translationMenuEntries({
      ...base,
      isFullPDFTranslationComplete: true,
      translatedSource: 'babeldoc'
    })[1].label).toBe('Retranslate PDF')
  })

  it('continues scanned translations through the scanned-PDF action', () => {
    const entries = translationMenuEntries({
      ...base,
      pdfHasText: false,
      isPartialPDFTranslation: true,
      translatedSource: 'scanRebuild'
    })
    expect(entries[1]).toEqual({ id: 'pdf', label: 'Translate PDF', enabled: false })
    expect(entries[2]).toEqual({ id: 'scan', label: 'Translate Scanned PDF…', enabled: true })
  })

  it('only shows the LaTeX route after it is enabled', () => {
    expect(translationMenuEntries(base).some((item) => item.id === 'latex')).toBe(false)
    expect(translationMenuEntries({ ...base, latexTranslationEnabled: true })).toContainEqual(
      { id: 'latex', label: 'Translate arXiv LaTeX', enabled: false }
    )
    expect(translationMenuEntries({ ...base, latexTranslationEnabled: true, hasArxivID: true })).toContainEqual(
      { id: 'latex', label: 'Translate arXiv LaTeX', enabled: true }
    )
  })
})

describe('isCompleteTranslation', () => {
  const translation = (translatedLastPage?: number): Attachment => ({
    id: '00000000-0000-4000-8000-000000000001',
    paperId: '00000000-0000-4000-8000-000000000002',
    kind: 'translatedPDF',
    source: 'babeldoc',
    filename: 'translations/babeldoc/translated.pdf',
    translatedLastPage,
    createdAt: '2026-01-01T00:00:00.000Z'
  })

  it('is false without a translation', () => {
    expect(isCompleteTranslation(undefined, 12)).toBe(false)
  })

  it('treats a translation without a recorded last page as complete', () => {
    expect(isCompleteTranslation(translation(), 12)).toBe(true)
  })

  it('treats a translation as complete while the page count is unknown', () => {
    expect(isCompleteTranslation(translation(5), undefined)).toBe(true)
  })

  it('compares the last page with the page count', () => {
    expect(isCompleteTranslation(translation(5), 12)).toBe(false)
    expect(isCompleteTranslation(translation(12), 12)).toBe(true)
    expect(isCompleteTranslation(translation(14), 12)).toBe(true)
  })
})
