// Unit and property tests for the ported stage helpers, mirroring the Swift
// TableOfContentsDotLeader / LayoutContinuation / CodeTextClassifier suites.
import { describe, expect, it } from 'vitest'
import { TableOfContentsDotLeader } from '../BabelDocKit/src/tableOfContentsDotLeader'
import { LayoutContinuation, type SemanticParagraphAddress } from '../BabelDocKit/src/layoutContinuation'
import { hasExactlyOneOfEachPlaceholder, type TranslateInput } from '../BabelDocKit/src/translatorTypes'
import { CodeTextClassifier } from '../BabelDocKit/src/codeTextClassifier'
import type { ILDocument } from '../BabelDocKit/src/il'

/** Deterministic SplitMix64, as the Swift property tests use. */
class SplitMix64 {
  private state: bigint
  constructor(seed: bigint) {
    this.state = seed & 0xffffffffffffffffn
  }
  next(): bigint {
    let z = (this.state += 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn
    return (z ^ (z >> 31n)) & 0xffffffffffffffffn
  }
  index(count: number): number {
    return Number(this.next() % BigInt(count))
  }
}

const alphabet = [
  '.', '.', '.', ' ', ' ', '', ' ', '\t', '\n', '\r\n', '　',
  '1', '2', '0', '9', 'i', 'v', 'x', 'l', 'c', 'd', 'm', 'I', 'V', 'X', 'M',
  'a', 'e', 'n', 'Z', ',', '-', '(', ')', '…', '․', '·',
  '́', '̇', '\u{20E3}', '\u{FE0F}', '\u{200D}', '\u{200B}', '\u{00AD}',
  '\u{1F3FB}', '\u{0600}', '\u{1161}', '１', 'ⅳ', '٣',
  '1.', '. ', 'fi', 'í', '2\u{20E3}'
]

/** The definition suffixStart must reproduce: the first suffix that isProtectedSuffix. */
function referenceSuffixStart(fragments: string[]): number | null {
  for (let index = 0; index < fragments.length; index += 1) {
    if (TableOfContentsDotLeader.isProtectedSuffix(fragments.slice(index).join(''))) return index
  }
  return null
}

describe('TableOfContentsDotLeader', () => {
  it('suffixStart matches the definition on random fragments', () => {
    const random = new SplitMix64(0x5eed070cn)
    for (let iteration = 0; iteration < 1500; iteration += 1) {
      const fragments = Array.from({ length: random.index(28) }, () => alphabet[random.index(alphabet.length)])
      expect(TableOfContentsDotLeader.suffixStart(fragments), JSON.stringify(fragments))
        .toBe(referenceSuffixStart(fragments))
    }
  })

  it('includes leading whitespace and empty fragments', () => {
    const fragments = ['1', '.', '2', ' ', 'S', 'c', 'o', 'p', 'e', '', ' ',
      ...Array.from({ length: 12 }, () => '.'), ' ', 'x', 'i', 'v', ' ']
    expect(TableOfContentsDotLeader.suffixStart(fragments)).toBe(9)
    expect(referenceSuffixStart(fragments)).toBe(9)
  })

  it('trims zero-width space like Foundation', () => {
    const fragments = ['\u{200B}', ...Array.from({ length: 12 }, () => '.'), ' ', '4', '\u{200B}']
    expect(TableOfContentsDotLeader.suffixStart(fragments)).toBe(0)
    expect(referenceSuffixStart(fragments)).toBe(0)
  })

  it('rejects near misses', () => {
    const leader = Array.from({ length: 12 }, () => '.')
    const cases = [
      ['E', 'n', 'd', ' ', ...Array.from({ length: 9 }, () => '.'), ' ', '4'],
      [...leader, ' ', 'c', 'i', 'v', 'i', 'l'],
      [...leader, 'a', ' ', '4'],
      [...leader, ' ', '4', '.'],
      [...Array.from({ length: 5 }, () => '.'), '́', ...Array.from({ length: 6 }, () => '.'), ' ', '4'],
      [...Array.from({ length: 6 }, () => '.'), '\u{200B}', ...Array.from({ length: 6 }, () => '.'), ' ', '4']
    ]
    for (const fragments of cases) {
      expect(TableOfContentsDotLeader.suffixStart(fragments), JSON.stringify(fragments)).toBeNull()
      expect(referenceSuffixStart(fragments), JSON.stringify(fragments)).toBeNull()
    }
  })

  it('containsProtectedSuffix matches the definition', () => {
    const random = new SplitMix64(0xc047a1n)
    const texts = [
      'Intro ............ 3', 'Intro ... 3', 'Intro ............ civil', 'Price 12',
      '............ xiv  ', '', 'Appendix . . . . . . . . . . . . II', 'Step 1.'
    ]
    for (let iteration = 0; iteration < 500; iteration += 1) {
      texts.push(Array.from({ length: random.index(24) }, () => alphabet[random.index(alphabet.length)]).join(''))
    }
    for (const text of texts) {
      expect(TableOfContentsDotLeader.containsProtectedSuffix(text), text)
        .toBe(referenceSuffixStart([...text]) !== null)
    }
  })
})

describe('LayoutContinuation', () => {
  it('recognizes sentence splits and enumerators', () => {
    expect(LayoutContinuation.endsMidSentence('the model,')).toBe(true)
    expect(LayoutContinuation.endsMidSentence('the model.')).toBe(false)
    expect(LayoutContinuation.endsMidSentence('第 3')).toBe(true)
    expect(LayoutContinuation.startsMidSentence('which explains the gap')).toBe(true)
    expect(LayoutContinuation.startsMidSentence('Which explains the gap')).toBe(false)
    expect(LayoutContinuation.startsMidSentence('a) first item')).toBe(false)
    expect(LayoutContinuation.startsMidSentence('ii. roman item')).toBe(false)
  })

  it('continues only same-size body paragraphs that line up geometrically', () => {
    const previous = { layout_label: 'plain text', pdf_style: { font_size: 10 }, box: { x: 40, y: 500, x2: 300, y2: 515 } }
    const below = { layout_label: 'plain text', pdf_style: { font_size: 10 }, box: { x: 40, y: 460, x2: 300, y2: 475 } }
    const rightColumnStart = { layout_label: 'plain text', pdf_style: { font_size: 10 }, box: { x: 320, y: 460, x2: 560, y2: 475 } }
    const bigger = { layout_label: 'plain text', pdf_style: { font_size: 12 }, box: { x: 40, y: 460, x2: 300, y2: 475 } }
    expect(LayoutContinuation.continues(previous, 'that the model,', below, 'which explains', true)).toBe(true)
    expect(LayoutContinuation.continues(previous, 'that the model,', rightColumnStart, 'which explains', true)).toBe(false)
    expect(LayoutContinuation.continues(previous, 'that the model,', bigger, 'which explains', true)).toBe(false)
  })

  it('merge renumbers placeholders and split restores each fragment’s own tokens', () => {
    const fragments: TranslateInput[] = [
      { text: 'using <b1> with <b2> and', placeholders: [
        { id: 1, token: '<b1>', composition: {} }, { id: 2, token: '<b2>', composition: {} }
      ] },
      { text: 'later <b1> again', placeholders: [{ id: 1, token: '<b1>', composition: {} }] }
    ]
    const merged = LayoutContinuation.merge(fragments)
    expect(merged).not.toBeNull()
    if (!merged) return
    expect(merged.input.text).toBe('using <b1> with <b2> and later <b3> again')
    expect(hasExactlyOneOfEachPlaceholder(merged.input.text, merged.input)).toBe(true)

    const pieces = LayoutContinuation.split('利用<b1>并结合<b2>，随后再次使用<b3>。', merged)
    expect(pieces).not.toBeNull()
    if (!pieces) return
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toContain('<b1>')
    expect(pieces[0]).toContain('<b2>')
    expect(pieces[1]).toContain('<b1>')
    expect(pieces[1]).not.toContain('<b2>')
  })

  it('flowSuccessor skips abandoned paragraphs and crosses physical pages', () => {
    const document: ILDocument = {
      page: [
        { page_number: 0, pdf_paragraph: [{ layout_label: 'plain text' }, { layout_label: 'abandon' }] },
        { page_number: 1, pdf_paragraph: [{ layout_label: 'plain text' }] }
      ]
    }
    const successor = LayoutContinuation.flowSuccessor({ pageIndex: 0, paragraphIndex: 0 } as SemanticParagraphAddress, document)
    expect(successor).toEqual({ pageIndex: 1, paragraphIndex: 0 })
  })
})

describe('CodeTextClassifier', () => {
  it('recognizes monospace and code-named fonts', () => {
    expect(CodeTextClassifier.isCodeFont({ monospace: true })).toBe(true)
    expect(CodeTextClassifier.isCodeFont({ name: 'ABCDEF+NimbusMonoPS' })).toBe(true)
    expect(CodeTextClassifier.isCodeFont({ name: 'ABCDEF+CMR10' })).toBe(false)
    expect(CodeTextClassifier.isCodeFont({})).toBe(false)
  })

  it('parses light neutral fill instructions only', () => {
    expect(CodeTextClassifier.isLightNeutral(undefined)).toBe(false)
    expect(CodeTextClassifier.isLightNeutral('0.95 0.95 0.95 rg')).toBe(true)
    expect(CodeTextClassifier.isLightNeutral('0.92 g')).toBe(true)
    expect(CodeTextClassifier.isLightNeutral('0.5 g')).toBe(false)
    expect(CodeTextClassifier.isLightNeutral('1 0.7 0.7 rg')).toBe(false)
    expect(CodeTextClassifier.isLightNeutral('0.99 0.99 0.86 rg')).toBe(false)
  })
})
