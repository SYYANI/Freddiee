// BabelDocIL v1 wire types. The IL is the project's stable JSON contract: keys
// are snake_case and every field is optional (the Python heritage the Swift
// types encode with PythonOptional/PythonList). Values decode straight from the
// frontend's JSON, so these interfaces stay structural.

/** PythonBool: the wire format carries booleans as bool or int. */
export type PythonBool = boolean | number
/** PythonDebugInfo: bool or string. */
export type PythonDebugInfo = boolean | string

export interface ILBox { x?: number; y?: number; x2?: number; y2?: number }

export interface ILGraphicState { passthrough_per_char_instruction?: string }

export interface ILPdfAffineTransform {
  translation_x?: number
  translation_y?: number
  rotation?: number
  scale_x?: number
  scale_y?: number
  shear?: number
}

export interface ILPdfFontCharBoundingBox extends ILBox { char_id?: number }

export interface ILPdfInlineForm { form_data?: string; image_parameters?: string }

export interface ILPdfMatrix {
  a?: number; b?: number; c?: number; d?: number; e?: number; f?: number
}

export interface ILPdfPath { x?: number; y?: number; op?: string; has_xy?: PythonBool }

export interface ILPdfXobjForm { xref_id?: number; do_args?: string }

export interface ILCropbox { box?: ILBox }
export interface ILMediabox { box?: ILBox }

export interface ILPageLayout {
  box?: ILBox
  id?: number
  conf?: number
  class_name?: string
}

export interface ILPdfFigure { box?: ILBox }

export interface ILPdfFont {
  pdf_font_char_bounding_box?: ILPdfFontCharBoundingBox[]
  name?: string
  font_id?: string
  xref_id?: number
  encoding_length?: number
  font_subtype?: string
  type3_font_matrix?: string
  type3_font_bbox?: string
  type3_em_height?: number
  bold?: PythonBool
  italic?: PythonBool
  monospace?: PythonBool
  serif?: PythonBool
  ascent?: number
  descent?: number
}

export interface ILPdfFormSubtype {
  pdf_inline_form?: ILPdfInlineForm
  pdf_xobj_form?: ILPdfXobjForm
}

export interface ILPdfOriginalPath { pdf_path?: ILPdfPath }

export interface ILPdfOriginalPathPrimitive { op?: string; args?: number[] }

export interface ILPdfRectangle {
  box?: ILBox
  graphic_state?: ILGraphicState
  debug_info?: PythonDebugInfo
  fill_background?: PythonBool
  xobj_id?: number
  line_width?: number
  render_order?: number
}

export interface ILPdfStyle {
  graphic_state?: ILGraphicState
  font_id?: string
  font_size?: number
}

export interface ILVisualBbox { box?: ILBox }

export interface ILPdfCharacter {
  pdf_style?: ILPdfStyle
  box?: ILBox
  visual_bbox?: ILVisualBbox
  vertical?: PythonBool
  /** True when the source text matrix mirrors the glyph y axis; the backend
   * re-emits the mirrored orientation. */
  y_flipped?: PythonBool
  scale?: number
  pdf_character_id?: number
  char_unicode?: string
  advance?: number
  xobj_id?: number
  debug_info?: PythonDebugInfo
  formula_layout_id?: number
  render_order?: number
  sub_render_order?: number
}

export interface ILPdfCurve {
  box?: ILBox
  graphic_state?: ILGraphicState
  pdf_path?: ILPdfPath[]
  pdf_original_path?: ILPdfOriginalPath[]
  pdf_original_path_primitive?: ILPdfOriginalPathPrimitive
  debug_info?: PythonDebugInfo
  fill_background?: PythonBool
  stroke_path?: PythonBool
  evenodd?: PythonBool
  passthrough_paint?: PythonBool
  xobj_id?: number
  render_order?: number
  ctm?: number[]
  relocation_transform?: number[]
}

export interface ILPdfForm {
  box?: ILBox
  graphic_state?: ILGraphicState
  pdf_matrix?: ILPdfMatrix
  pdf_affine_transform?: ILPdfAffineTransform
  pdf_form_subtype?: ILPdfFormSubtype
  xobj_id?: number
  ctm?: number[]
  relocation_transform?: number[]
  render_order?: number
  form_type?: string
}

export interface ILPdfSameStyleUnicodeCharacters {
  pdf_style?: ILPdfStyle
  unicode?: string
  debug_info?: PythonDebugInfo
}

export interface ILPdfXobject {
  box?: ILBox
  pdf_font?: ILPdfFont[]
  base_operations?: ILBaseOperations
  xobj_id?: number
  xref_id?: number
}

export interface ILBaseOperations { value?: string }

export interface ILPdfFormula {
  box?: ILBox
  pdf_character?: ILPdfCharacter[]
  pdf_curve?: ILPdfCurve[]
  pdf_form?: ILPdfForm[]
  x_offset?: number
  y_offset?: number
  x_advance?: number
  line_id?: number
  is_corner_mark?: PythonBool
}

export interface ILPdfLine {
  box?: ILBox
  pdf_character?: ILPdfCharacter[]
  render_order?: number
}

export interface ILPdfSameStyleCharacters {
  box?: ILBox
  pdf_style?: ILPdfStyle
  pdf_character?: ILPdfCharacter[]
}

export interface ILPdfParagraphComposition {
  pdf_line?: ILPdfLine
  pdf_formula?: ILPdfFormula
  pdf_same_style_characters?: ILPdfSameStyleCharacters
  pdf_character?: ILPdfCharacter
  pdf_same_style_unicode_characters?: ILPdfSameStyleUnicodeCharacters
}

export interface ILPdfParagraph {
  box?: ILBox
  pdf_style?: ILPdfStyle
  pdf_paragraph_composition?: ILPdfParagraphComposition[]
  xobj_id?: number
  unicode?: string
  scale?: number
  optimal_scale?: number
  vertical?: PythonBool
  first_line_indent?: PythonBool
  debug_id?: string
  layout_label?: string
  layout_id?: number
  render_order?: number
}

export interface ILPage {
  mediabox?: ILMediabox
  cropbox?: ILCropbox
  pdf_xobject?: ILPdfXobject[]
  page_layout?: ILPageLayout[]
  pdf_rectangle?: ILPdfRectangle[]
  pdf_font?: ILPdfFont[]
  pdf_paragraph?: ILPdfParagraph[]
  pdf_figure?: ILPdfFigure[]
  pdf_character?: ILPdfCharacter[]
  pdf_curve?: ILPdfCurve[]
  pdf_form?: ILPdfForm[]
  base_operations?: ILBaseOperations
  page_number?: number
  unit?: string
}

export interface ILDocument {
  page?: ILPage[]
  total_pages?: number
}

/** Reads a PythonBool, which counts any non-zero int as true. */
export function pythonBool(value: PythonBool | undefined): boolean {
  return typeof value === 'number' ? value !== 0 : value === true
}

export interface BoxCoordinates { x: number; y: number; x2: number; y2: number }

/** All four box coordinates, or null when the IL box is absent or partial. */
export function boxCoordinates(box: ILBox | undefined | null): BoxCoordinates | null {
  if (!box || box.x === undefined || box.y === undefined || box.x2 === undefined || box.y2 === undefined) {
    return null
  }
  return { x: box.x, y: box.y, x2: box.x2, y2: box.y2 }
}
