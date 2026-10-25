import type { AttachmentSource } from '../../shared/types'

export interface TranslationMenuState {
  hasHTML: boolean
  hasPDF: boolean
  pdfHasText?: boolean
  isPartialPDFTranslation: boolean
  isFullPDFTranslationComplete: boolean
  translatedSource?: AttachmentSource
  latexTranslationEnabled: boolean
  hasArxivID: boolean
}

export interface TranslationMenuEntry {
  id: 'html' | 'pdf' | 'scan' | 'latex'
  label: string
  enabled: boolean
}

/** Mirrors native Freddie's translation menu: one stateful text-PDF action plus scan and optional LaTeX routes. */
export function translationMenuEntries(state: TranslationMenuState): TranslationMenuEntry[] {
  const pdfLabel = state.isPartialPDFTranslation && state.translatedSource !== 'scanRebuild'
    ? 'Translate More PDF Pages'
    : state.isFullPDFTranslationComplete
      ? 'Retranslate PDF'
      : 'Translate PDF'
  const entries: TranslationMenuEntry[] = [
    { id: 'html', label: 'Translate HTML', enabled: state.hasHTML },
    { id: 'pdf', label: pdfLabel, enabled: state.hasPDF && state.pdfHasText === true },
    { id: 'scan', label: 'Translate Scanned PDF…', enabled: state.hasPDF }
  ]
  if (state.latexTranslationEnabled) {
    entries.push({ id: 'latex', label: 'Translate arXiv LaTeX', enabled: state.hasArxivID })
  }
  return entries
}
