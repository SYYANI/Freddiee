// Target-font infrastructure: the 15 runtime fonts loaded into the wasm module
// as MuPDF faces. Glyph ids and unhinted advances replace the CoreText lookups
// the Swift pipeline made (CTFontGetGlyphsForCharacters /
// CTFontGetAdvancesForGlyphs); both read the same font tables, so ids and
// advances agree to the byte.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { babelDocWasm, type BabelDocWasmModule } from './wasmModule'

export interface TargetFont {
  /** Resource name written into IL styles; the .ttf file name. */
  id: string
  bold: boolean
  italic: boolean
  serif: boolean
  glyph(unicode: number): number | null
  advance(glyph: number, size: number): number
  /** Classification coverage: any scalar, including astral planes. */
  hasCharacter(unicode: number): boolean
}

export type TargetFontFamilyKey = 'simplifiedChinese' | 'latin'

export class BabelDocTypesettingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocTypesettingError'
  }
}

const fontFamilies: Record<'CN' | 'EN', { normal: string[]; script: string[]; base: string }> = {
  CN: {
    normal: [
      'SourceHanSerifCN-Bold.ttf', 'SourceHanSerifCN-Regular.ttf',
      'SourceHanSansCN-Bold.ttf', 'SourceHanSansCN-Regular.ttf'
    ],
    script: ['LXGWWenKaiGB-Regular.1.520.ttf'],
    base: 'SourceHanSansCN-Regular.ttf'
  },
  EN: {
    normal: [
      'NotoSerif-Regular.ttf', 'NotoSerif-Bold.ttf',
      'NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'
    ],
    script: [
      'NotoSans-Italic.ttf', 'NotoSans-BoldItalic.ttf',
      'NotoSerif-Italic.ttf', 'NotoSerif-BoldItalic.ttf'
    ],
    base: 'NotoSans-Regular.ttf'
  }
}

/** The fonts StylesAndFormulas classifies formula characters against. */
export const classificationFontNames = [
  'NotoSans-Italic.ttf', 'NotoSans-BoldItalic.ttf', 'NotoSerif-Italic.ttf',
  'NotoSerif-BoldItalic.ttf', 'LXGWWenKaiGB-Regular.1.520.ttf',
  'NotoSerif-Regular.ttf', 'NotoSerif-Bold.ttf', 'NotoSans-Regular.ttf',
  'NotoSans-Bold.ttf', 'SourceHanSerifCN-Bold.ttf', 'SourceHanSerifCN-Regular.ttf',
  'SourceHanSansCN-Bold.ttf', 'SourceHanSansCN-Regular.ttf',
  'GoNotoKurrent-Regular.ttf', 'GoNotoKurrent-Bold.ttf'
]

function makeTargetFont(id: string, handle: number, wasm: BabelDocWasmModule): TargetFont {
  const glyphCache = new Map<number, number | null>()
  const advanceCache = new Map<string, number>()
  return {
    id,
    bold: id.includes('Bold'),
    italic: id.includes('Italic'),
    serif: id.includes('Serif'),
    glyph(unicode: number): number | null {
      if (glyphCache.has(unicode)) return glyphCache.get(unicode) ?? null
      // Swift only asks CoreText for single-UTF16-unit characters.
      const glyph = unicode <= 0xffff ? wasm.fontGlyph(handle, unicode) : -1
      const value = glyph > 0 ? glyph : null
      glyphCache.set(unicode, value)
      return value
    },
    advance(glyph: number, size: number): number {
      const key = `${glyph}:${size}`
      const cached = advanceCache.get(key)
      if (cached !== undefined) return cached
      const value = wasm.fontAdvance(handle, glyph, size)
      advanceCache.set(key, value)
      return value
    },
    hasCharacter(unicode: number): boolean {
      return wasm.fontGlyph(handle, unicode) > 0
    }
  }
}

/** One wasm handle per font file per process; the module keeps them open. */
const fontCache = new Map<string, TargetFont>()

/** Loads a named set of fonts from a directory into the wasm module. */
export async function loadTargetFonts(names: string[], fontDirectory: string, wasm?: BabelDocWasmModule): Promise<Map<string, TargetFont>> {
  const module = wasm ?? await babelDocWasm()
  const loaded = new Map<string, TargetFont>()
  for (const name of names) {
    const key = `${fontDirectory}/${name}`
    const cached = fontCache.get(key)
    if (cached) {
      loaded.set(name, cached)
      continue
    }
    try {
      const bytes = new Uint8Array(readFileSync(join(fontDirectory, name)))
      const handle = module.fontOpen(bytes, name)
      const font = makeTargetFont(name, handle, module)
      fontCache.set(key, font)
      loaded.set(name, font)
    } catch {
      // Swift skips unreadable font files the same way.
    }
  }
  return loaded
}

export function targetFontFamily(language: string): TargetFontFamilyKey {
  const normalized = language.trim().replace(/_/g, '-').toLowerCase()
  const subtags = normalized.split('-')
  const primary = subtags[0] ?? ''
  const removedChinese = primary === 'zh'
    && subtags.slice(1).some((tag) => ['tw', 'hk', 'mo', 'hant'].includes(tag))
  const removedJapanese = primary === 'ja' || primary === 'jp'
  const removedKorean = primary === 'ko' || primary === 'kr'
  if (removedChinese || removedJapanese || removedKorean) {
    throw new BabelDocTypesettingError(`BabelDOC target language is no longer bundled: ${language}.`)
  }
  return primary === 'zh' ? 'simplifiedChinese' : 'latin'
}

export interface TargetFontMapper {
  fonts: TargetFont[]
  primary: TargetFont[]
  script: TargetFont[]
  fallback: TargetFont[]
  base: TargetFont
  isCJK: boolean
  map(original: { bold?: boolean | number; italic?: boolean | number; serif?: boolean | number }, character: string): TargetFont | null
}

function truthyFontFlag(value: boolean | number | undefined): boolean {
  return typeof value === 'number' ? value !== 0 : value === true
}

export async function createTargetFontMapper(
  targetLanguage: string,
  fontDirectory: string,
  wasm?: BabelDocWasmModule
): Promise<TargetFontMapper> {
  const familyKey = targetFontFamily(targetLanguage)
  // Try the compact Latin families first: Source Han also contains Latin
  // glyphs, and reversing this order would render mixed spans with the CJK font.
  const orderedFamilies = [fontFamilies.EN, fontFamilies.CN]
  const unique = (values: string[]): string[] => [...new Set(values)]
  const normalNames = unique(orderedFamilies.flatMap((family) => family.normal))
  const scriptNames = unique(orderedFamilies.flatMap((family) => family.script))
  const fallbackNames = ['GoNotoKurrent-Regular.ttf', 'GoNotoKurrent-Bold.ttf']
  const names = [...normalNames, ...scriptNames, ...fallbackNames]
  const loaded = await loadTargetFonts(names, fontDirectory, wasm)

  const baseName = familyKey === 'simplifiedChinese' ? 'SourceHanSansCN-Regular.ttf' : 'NotoSans-Regular.ttf'
  const base = loaded.get(baseName)
  if (!base) {
    throw new BabelDocTypesettingError(`BabelDOC target fonts are unavailable at ${fontDirectory}.`)
  }
  const pick = (list: string[]) => list.map((name) => loaded.get(name)).filter((font): font is TargetFont => font !== undefined)
  const fonts = pick(names)
  const primary = pick(normalNames)
  const script = pick(scriptNames)
  const fallback = pick(fallbackNames)
  return {
    fonts,
    primary,
    script,
    fallback,
    base,
    isCJK: familyKey === 'simplifiedChinese',
    map(original, character) {
      const unicode = character.codePointAt(0)
      if (unicode === undefined) return null
      const bold = truthyFontFlag(original.bold)
      const italic = truthyFontFlag(original.italic)
      const serif = truthyFontFlag(original.serif)
      const hasGlyph = (font: TargetFont) => font.glyph(unicode) !== null
      if (italic) {
        const font = script.find(hasGlyph)
        if (font) return font
      }
      const primaryMatch = primary.find((font) => hasGlyph(font) && font.bold === bold && font.serif === serif)
      if (primaryMatch) return primaryMatch
      const matchingFallback = fallback.find((font) => hasGlyph(font) && font.bold === bold && font.serif === serif)
      if (matchingFallback) return matchingFallback
      const anyFallback = fallback.find(hasGlyph)
      if (anyFallback) return anyFallback
      return fonts.find(hasGlyph) ?? null
    }
  }
}
