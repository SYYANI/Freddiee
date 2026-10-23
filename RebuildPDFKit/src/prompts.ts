import review from '../resources/prompts/review.txt?raw'
import transcribe from '../resources/prompts/transcribe.txt?raw'
import translateChinese from '../resources/prompts/translate-zh.txt?raw'

/** The model prompts, byte-identical to the Python package (copied by scripts/sync-rebuild-pdf.mjs). */
export const RebuildPrompts = {
  /** Bumped whenever the generated LaTeX changes in a way that invalidates cached pages. */
  typesetVersion: 'latex-page-v1',
  transcribe,
  review,
  translateChinese
}
