// Character-to-layout assignment rules shared by the paragraph stages, ported
// from Swift LayoutHelper. Priorities use the first position of a name in the
// list; the detector's own labels map through the same table.
import { boxCoordinates, type ILBox, type ILPageLayout, type ILPdfCharacter } from './il'

export interface CharacterLayout {
  id: number | undefined
  name: string | undefined
}

const layoutDefaultPriority: string[] = [
  'number', 'reference', 'reference_content', 'algorithm', 'formula_caption',
  'isolate_formula', 'table_footnote', 'table_caption', 'figure_caption',
  'figure_title', 'chart_title', 'table_title', 'table_cell_hybrid', 'table_text',
  'wireless_table_cell', 'wired_table_cell', 'abandon', 'title', 'abstract',
  'paragraph_title', 'content', 'doc_title', 'footnote', 'header', 'footer', 'seal',
  'plain text', 'tiny text', 'author_info_hybrid', 'list_item_hybrid', 'text',
  'paragraph_hybrid', 'paragraph', 'table_cell', 'figure_text', 'list_item', 'title',
  'caption', 'footnote_hybrid', 'footnote', 'formula', 'formula_hybrid', 'page_header',
  'page_footer', 'reference_hybrid', 'document_hybrid', 'academic_paper_hybrid',
  'form_or_table_hybrid', 'presentation_slide_hybrid', 'webpage_screenshot_hybrid',
  'manga_or_comic_hybrid', 'advertisement_hybrid', 'magazine_or_newspaper_hybrid',
  'other_hybrid', 'table_cell_hybrid', 'figure_text_hybrid', 'title_hybrid',
  'caption_hybrid', 'code_algo_hybrid', 'line_number_hybrid', 'page_header_hybrid',
  'page_footer_hybrid', 'page_number_hybrid', 'unknown_hybrid', 'fallback_line', 'table',
  'figure', 'image'
]

export const LayoutHelper = {
  defaultPriority: layoutDefaultPriority,

  isTextLayout(layout: CharacterLayout | null | undefined): boolean {
    return textLayoutNames.has(layout?.name ?? '')
  },

  coverage(first: ILBox | undefined, second: ILBox | undefined): number {
    const a = boxCoordinates(first)
    const b = boxCoordinates(second)
    if (!a || !b) return 0
    const width = Math.min(a.x2, b.x2) - Math.max(a.x, b.x)
    const height = Math.min(a.y2, b.y2) - Math.max(a.y, b.y)
    if (width <= 0 || height <= 0) return 0
    const area = (a.x2 - a.x) * (a.y2 - a.y)
    if (area <= 0) return 0
    return width * height / area
  },

  characterLayout(
    character: ILPdfCharacter,
    layouts: ILPageLayout[],
    priority: string[] = layoutDefaultPriority
  ): CharacterLayout | null {
    const characterBox = boxCoordinates(character.visual_bbox?.box)
    if (!characterBox) return null
    const firstPriority = new Map<string, number>()
    priority.forEach((name, index) => {
      if (!firstPriority.has(name)) firstPriority.set(name, index)
    })

    let selected: { offset: number; priority: number; coverage: number; layout: ILPageLayout } | null = null
    for (const [offset, layout] of layouts.entries()) {
      const layoutBox = boxCoordinates(layout.box)
      if (!layoutBox) continue
      const width = Math.min(characterBox.x2, layoutBox.x2) - Math.max(characterBox.x, layoutBox.x)
      const height = Math.min(characterBox.y2, layoutBox.y2) - Math.max(characterBox.y, layoutBox.y)
      const area = (characterBox.x2 - characterBox.x) * (characterBox.y2 - characterBox.y)
      if (width <= 0 || height <= 0 || area <= 0) continue
      const name = layout.class_name ?? ''
      const match = {
        offset, priority: firstPriority.get(name) ?? priority.length,
        coverage: width * height / area, layout
      }
      if (
        !selected
        || match.priority < selected.priority
        || (match.priority === selected.priority && match.coverage > selected.coverage)
      ) {
        selected = match
      }
    }
    if (!selected) return null
    return { id: selected.layout.id, name: selected.layout.class_name }
  },

  formulaLayoutID(character: ILPdfCharacter, layouts: ILPageLayout[]): number | undefined {
    const visualBox = character.visual_bbox?.box
    if (!visualBox) return undefined
    const queryBox: ILBox = LayoutHelper.coverage(visualBox, character.box) < 0.2 && character.box
      ? character.box
      : visualBox
    for (const layout of layouts) {
      if (layout.class_name === 'formula' && LayoutHelper.coverage(queryBox, layout.box) > 0.4) {
        return layout.id
      }
    }
    return undefined
  }
}

const textLayoutNames = new Set([
  'plain text', 'tiny text', 'title', 'abandon', 'figure_caption', 'table_caption',
  'table_text', 'table_footnote', 'paragraph_title', 'abstract', 'content', 'figure_title',
  'table_title', 'doc_title', 'footnote', 'header', 'footer', 'seal', 'text',
  'chart_title', 'paragraph', 'table_cell', 'figure_text', 'list_item', 'caption',
  'page_header', 'page_footer', 'wired_table_cell', 'wireless_table_cell',
  'paragraph_hybrid', 'table_cell_hybrid', 'caption_hybrid', 'unknown_hybrid',
  'figure_text_hybrid', 'list_item_hybrid', 'title_hybrid', 'fallback_line',
  'author_info_hybrid', 'page_header_hybrid', 'page_footer_hybrid', 'footnote_hybrid'
])
