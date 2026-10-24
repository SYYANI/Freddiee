// Dumps BabelDoc IL v1 stage JSONs for parity fixtures. The Swift pipeline runs
// against a -ffp-contract=off reference libmupdf.dylib (see
// scripts/build-babeldoc-parity-dylib.mjs) so frontend floats match the wasm
// build bit for bit, and the layout detector runs CPU-only for determinism.
//
// Usage: babeldoc-parity stages <input.pdf> <output-directory>
//          [--model <mlmodel>] [--cpu] [--mupdf-library <dylib>] [--pages <first-last>]
//        babeldoc-parity frontend <input.pdf> <output.json> [--mupdf-library <dylib>]
import BabelDocLayoutCore
import Foundation

struct Options {
  var model = URL(fileURLWithPath: "Vendor/Models/doclayout_yolo_docstructbench_imgsz1024.mlmodel")
  var mupdfLibrary: String?
  var fontDirectory: String?
  var pages: Range<Int>?
  var cpu = false
}

func parsePages(_ text: String) -> Range<Int>? {
  let pieces = text.split(separator: "-").compactMap { Int($0) }
  guard pieces.count == 2, pieces[0] >= 1, pieces[0] <= pieces[1] else { return nil }
  // 1-based inclusive first-last to 0-based half-open.
  return (pieces[0] - 1)..<pieces[1]
}

func parse(_ arguments: [String]) throws -> (mode: String, input: URL, output: URL, options: Options) {
  var options = Options()
  var mode: String?, input: URL?, output: URL?
  var index = 1
  while index < arguments.count {
    let argument = arguments[index]
    switch argument {
    case "--model":
      index += 1
      guard index < arguments.count else { throw CommandLineError("--model requires a path") }
      options.model = URL(fileURLWithPath: arguments[index])
    case "--mupdf-library":
      index += 1
      guard index < arguments.count else { throw CommandLineError("--mupdf-library requires a path") }
      options.mupdfLibrary = arguments[index]
    case "--font-directory":
      index += 1
      guard index < arguments.count else { throw CommandLineError("--font-directory requires a path") }
      options.fontDirectory = arguments[index]
    case "--cpu":
      options.cpu = true
    case "--pages":
      index += 1
      guard index < arguments.count, let range = parsePages(arguments[index]) else {
        throw CommandLineError("--pages requires first-last (1-based, inclusive)")
      }
      options.pages = range
    default:
      if mode == nil { mode = argument }
      else if input == nil { input = URL(fileURLWithPath: argument) }
      else if output == nil { output = URL(fileURLWithPath: argument) }
      else { throw CommandLineError("Unexpected argument: \(argument)") }
    }
    index += 1
  }
  guard let mode, let input, let output else {
    throw CommandLineError("Usage: babeldoc-parity <frontend|stages> <input> <output> [options]")
  }
  return (mode, input, output, options)
}

enum CommandLineError: Error, CustomStringConvertible {
  case message(String)
  init(_ text: String) { self = .message(text) }
  var description: String {
    if case let .message(text) = self { return text }
    return "command line error"
  }
}


/// Deterministic synthetic translation: replaces a paragraph's non-formula
/// compositions with one translated composition of fixed Chinese text so the
/// typesetting and backend stages run through a realistic document shape.
func synthesizeTranslation(_ document: inout BabelDocIL.Document) {
  for pageIndex in document.page.indices {
    for paragraphIndex in document.page[pageIndex].pdf_paragraph.indices {
      let paragraph = document.page[pageIndex].pdf_paragraph[paragraphIndex]
      guard paragraph.unicode != nil, let style = paragraph.pdf_style,
            paragraph.layout_label != "isolate_formula",
            !paragraph.pdf_paragraph_composition.isEmpty else { continue }
      let repetitions = 1 + paragraphIndex % 3
      let text = String(repeating: "这是合成翻译文本。", count: repetitions)
      var compositions: [BabelDocIL.PdfParagraphComposition] = paragraph.pdf_paragraph_composition.filter {
        $0.pdf_formula != nil
      }
      compositions.append(.init(pdf_same_style_unicode_characters: .init(pdf_style: style, unicode: text)))
      document.page[pageIndex].pdf_paragraph[paragraphIndex].pdf_paragraph_composition = compositions
    }
  }
}

func writeSnapshot(_ snapshot: SourceParagraphSnapshot, to url: URL) throws {
  let value = J.o([
    "pages": J.a(snapshot.pages.map { page in
      J.a(page.map { paragraph in
        J.o([
          "anchors": J.a(paragraph.anchors.map { anchorJSON($0) }),
          "extent": boxJSON(paragraph.extent) ?? .null,
        ])
      })
    }),
    "pageCharacters": J.a(snapshot.pageCharacters.map { characters in
      J.a(characters.map { anchorJSON($0) })
    }),
  ])
  try writeRaw(value, to: url)
}

func writeTypesettingReport(_ report: TypesettingReport, to url: URL) throws {
  let value = J.o([
    "pages": J.a(report.pages.map { page in
      J.o([
        "replacedCurveBoxes": J.a(page.replacedCurveBoxes.map { boxJSON($0) ?? .null }),
        "decorationCurves": J.a(page.decorationCurves.map { curve in
          J.o([
            "box": boxJSON(curve.box) ?? .null,
            "instruction": .s(curve.graphic_state?.passthrough_per_char_instruction ?? ""),
            "render_order": curve.render_order.map { J.i($0) } ?? .null,
          ])
        }),
        "paragraphs": J.a(page.paragraphs.map { paragraph in
          J.o([
            "isTypeset": .b(paragraph.isTypeset),
            "translatedCompositionIndices": J.a(paragraph.translatedCompositionIndices.map { J.i($0) }),
            "sourceUnits": J.a(paragraph.sourceUnits.map { unit in
              J.o([
                "characters": .i(unit.characters.count),
                "curves": .i(unit.curves.count),
                "forms": .i(unit.forms.count),
                "transform": unit.transform.map { J.a($0.map { J.d($0) }) } ?? .null,
                "firstUnicode": unit.characters.compactMap(\.char_unicode).first.map { J.s($0) } ?? .null,
                "ids": J.a(unit.characters.compactMap(\.pdf_character_id).map { J.i($0) }),
              ])
            }),
          ])
        }),
      ])
    }),
  ])
  try writeRaw(value, to: url)
}

func writePlan(_ plan: SourcePreservingDocumentPlan, to url: URL) throws {
  let value = J.o([
    "pages": J.o(Dictionary(uniqueKeysWithValues: plan.pages.sorted { $0.key < $1.key }.map { pageNumber, page in
      (String(pageNumber), J.o([
        "glyphs": J.a(page.glyphs.map { glyph in glyphJSON(glyph) }),
        "placements": J.a(page.placements.map { placement in
          J.o([
            "transform": J.a(placement.transform.map { J.d($0) }),
            "glyphRects": J.a(placement.glyphRects.map { boxJSON($0) ?? .null }),
            "graphicRects": J.a(placement.graphicRects.map { boxJSON($0) ?? .null }),
          ])
        }),
        "removedRegions": J.a(page.removedRegions.map { boxJSON($0) ?? .null }),
        "removedTextRegions": J.a(page.removedTextRegions.map { boxJSON($0) ?? .null }),
        "underlayCurves": .i(page.underlayCurves.count),
        "overlayCharacters": J.a(page.overlayCharacters.map { character in
          J.o([
            "unicode": .s(character.char_unicode ?? ""),
            "glyph": character.pdf_character_id.map { J.i($0) } ?? .null,
            "font_id": .s(character.pdf_style?.font_id ?? ""),
            "size": .d(character.pdf_style?.font_size ?? 0),
            "box": boxJSON(character.box) ?? .null,
          ])
        }),
      ]))
    })),
  ])
  try writeRaw(value, to: url)
}

func writeBackendReport(_ report: NativePDFBackendReport, to url: URL) throws {
  let value = J.o([
    "renderingMode": .s(report.renderingMode.rawValue),
    "pages": J.a(report.pages.map { page in
      J.o([
        "pageNumber": .i(page.pageNumber),
        "outcome": .s(page.outcome.rawValue),
        "fallbackReason": page.fallbackReason.map { J.s($0.rawValue) } ?? .null,
        "glyphCount": .i(page.glyphCount),
        "requiredGlyphCount": .i(page.requiredGlyphCount),
        "matchedRequiredGlyphCount": .i(page.matchedRequiredGlyphCount),
        "unmatchedPlacedGlyphCount": .i(page.unmatchedPlacedGlyphCount),
        "removedGlyphCount": .i(page.removedGlyphCount),
        "placedGlyphCount": .i(page.placedGlyphCount),
        "adoptedGlyphCount": .i(page.adoptedGlyphCount),
        "removedGraphicCount": .i(page.removedGraphicCount),
        "placedGraphicCount": .i(page.placedGraphicCount),
        "placementCount": .i(page.placementCount),
        "layerCount": .i(page.layerCount),
        "misplacedGlyphCount": .i(page.misplacedGlyphCount),
      ])
    }),
  ])
  try writeRaw(value, to: url)
}

func glyphJSON(_ glyph: SourcePreservingPagePlan.Glyph) -> J {
  J.o([
    "x": .d(glyph.anchor.x), "y": .d(glyph.anchor.y), "y2": .d(glyph.anchor.y2),
    "orientation": .i(Int(glyph.anchor.orientation.rawValue)),
    "unicode": glyph.anchor.unicode.map { J.i(Int($0)) } ?? .null,
    "isOptional": .b(glyph.anchor.isOptional),
    "role": .i(Int(glyph.role.rawValue)),
    "placement": glyph.placement.map { J.i($0) } ?? .null,
  ])
}

func anchorJSON(_ anchor: SourceGlyphAnchor) -> J {
  J.o([
    "x": .d(anchor.x), "y": .d(anchor.y), "y2": .d(anchor.y2),
    "orientation": .i(Int(anchor.orientation.rawValue)),
    "unicode": anchor.unicode.map { J.i(Int($0)) } ?? .null,
    "isOptional": .b(anchor.isOptional),
  ])
}

func boxJSON(_ box: BabelDocIL.Box?) -> J? {
  guard let box, let x = box.x, let y = box.y, let x2 = box.x2, let y2 = box.y2 else { return nil }
  return J.o(["x": .d(x), "y": .d(y), "x2": .d(x2), "y2": .d(y2)])
}

func writeRaw(_ value: J, to url: URL) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try encoder.encode(value).write(to: url)
}

/// JSON values, as the latex parity harness uses.
indirect enum J: Encodable {
  case s(String), i(Int), d(Double), b(Bool), null, a([J]), o([String: J])

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case let .s(value): try container.encode(value)
    case let .i(value): try container.encode(value)
    case let .d(value): try container.encode(value)
    case let .b(value): try container.encode(value)
    case .null: try container.encodeNil()
    case let .a(value): try container.encode(value)
    case let .o(value): try container.encode(value)
    }
  }
}


/// Deterministic placeholder-preserving mock translator, mirrored byte for byte
/// by the TypeScript tests (MockTranslator in babeldoc-translation-parity.test.ts):
/// - non-token runs are prefixed with 译;
/// - FNV-1a(text) % 7 == 0 drops the first placeholder token unless the retry
///   context says the placeholder attempt failed (exercises retry counting);
/// - FNV-1a(text) % 13 == 0 throws a prompt echo on neighbor-less requests.
struct ParityMockTranslator: ContextualAsyncILTextTranslator {
  let maximumConcurrentTranslations = 3

  nonisolated func formulaPlaceholder(id: Int) -> String { "[BABELDOC_FORMULA_\(id)]" }

  private static func fnv(_ text: String) -> UInt32 {
    var hash: UInt32 = 0x811c9dc5
    for byte in text.utf8 {
      hash = (hash ^ UInt32(byte)) &* 0x01000193
    }
    return hash
  }

  private static let tokenPattern: NSRegularExpression = try! NSRegularExpression(
    pattern: #"\[(?:BABELDOC_FORMULA|PROTECTED_SEMANTIC|PROTECTED)_\d+\]"#
  )

  func translate(_ text: String) async throws -> String {
    try await translate(text, context: ILTranslationContext())
  }

  func translate(_ text: String, context: ILTranslationContext) async throws -> String {
    let hash = Self.fnv(text)
    if hash % 13 == 0,
       (context.previousSegment ?? "").isEmpty, (context.nextSegment ?? "").isEmpty {
      throw ILTranslationOutputError.promptEcho
    }
    let string = text as NSString
    let full = NSRange(location: 0, length: string.length)
    var pieces: [(String, Bool)] = []
    var cursor = 0
    for match in Self.tokenPattern.matches(in: text, range: full) {
      if match.range.location > cursor {
        pieces.append((string.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), false))
      }
      pieces.append((string.substring(with: match.range), true))
      cursor = match.range.location + match.range.length
    }
    if cursor < string.length {
      pieces.append((string.substring(from: cursor), false))
    }
    var dropFirstToken = hash % 7 == 0
    if let retry = context.placeholderRetryAttempt, retry > 0 {
      dropFirstToken = false
    }
    var dropped = false
    var output = ""
    for (piece, isToken) in pieces {
      if isToken {
        if dropFirstToken && !dropped {
          dropped = true
          continue
        }
        output += piece
      } else {
        output += "译" + piece
      }
    }
    return output
  }
}

/// A deterministic semantic document derived from the styles-stage paragraphs:
/// every third flow paragraph becomes a source block whose template equals its
/// aligned text; captions keep a floating kind. Mirrored by the TS test.
func synthesizeSemanticHints(_ document: BabelDocIL.Document) -> BabelDocSemanticDocument {
  var blocks: [BabelDocSemanticBlock] = []
  var ordinal = 0
  for pageIndex in document.page.indices {
    for paragraphIndex in document.page[pageIndex].pdf_paragraph.indices {
      let paragraph = document.page[pageIndex].pdf_paragraph[paragraphIndex]
      guard let text = paragraph.unicode?.trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty, text.count >= 12 else { continue }
      let position = paragraphIndex
      guard position % 3 == ordinal % 3 || position % 3 == 1 else { continue }
      let kind: BabelDocSemanticBlockKind
      switch paragraph.layout_label {
      case "figure_caption": kind = .figureCaption
      case "table_caption": kind = .tableCaption
      case "abstract": kind = .abstract
      default: kind = .paragraph
      }
      let compressed = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      blocks.append(.init(
        id: "mock-\(pageIndex)-\(paragraphIndex)",
        ordinal: ordinal,
        kind: kind,
        alignmentText: String(compressed.prefix(220)),
        translationTemplate: compressed,
        rawSource: compressed,
        sectionPath: [.init(level: 1, title: "Introduction")],
        headingLevel: nil,
        environment: nil,
        containerKind: nil,
        parentID: nil,
        atoms: []
      ))
      ordinal += 1
    }
  }
  return .init(sourceIdentifier: "parity-mock", blocks: blocks)
}

func writeSemanticContexts(_ contexts: [SemanticParagraphAddress: SemanticParagraphContext], to url: URL) throws {
  let entries: [(String, J)] = contexts.sorted { lhs, rhs in
    if lhs.key.pageIndex != rhs.key.pageIndex { return lhs.key.pageIndex < rhs.key.pageIndex }
    return lhs.key.paragraphIndex < rhs.key.paragraphIndex
  }.map { address, context in
    ("\(address.pageIndex):\(address.paragraphIndex)", J.o([
      "sourceBlockIDs": J.a(context.sourceBlockIDs.map { J.s($0) }),
      "role": .s(context.role.rawValue),
      "environment": context.environment.map { J.s($0) } ?? .null,
      "sectionPath": J.a(context.sectionPath.map { entry in
        J.o(["level": .i(entry.level), "title": .s(entry.title)])
      }),
      "previousSourceParagraph": context.previousSourceParagraph.map { J.s($0) } ?? .null,
      "nextSourceParagraph": context.nextSourceParagraph.map { J.s($0) } ?? .null,
      "completeSourceText": .s(context.completeSourceText),
      "translationTemplate": context.translationTemplate.map { J.s($0) } ?? .null,
      "atoms": .i(context.atoms.count),
      "matchConfidence": .s(context.matchConfidence.rawValue),
      "continuationGroupID": context.continuationGroupID.map { J.s($0) } ?? .null,
      "fragmentIndex": .i(context.fragmentIndex),
      "fragmentCount": .i(context.fragmentCount),
      "associatedLayoutID": context.associatedLayoutID.map { J.i($0) } ?? .null,
    ]))
  }
  var dictionary: [String: J] = [:]
  for (key, value) in entries { dictionary[key] = value }
  try writeRaw(J.o(dictionary), to: url)
}

func writeTranslationReport(_ report: ILTranslationReport, to url: URL) throws {
  let value = J.o([
    "candidateCount": .i(report.candidateCount),
    "translatedCount": .i(report.translatedCount),
    "failedCount": .i(report.failedCount),
    "placeholderValidationFailureCount": .i(report.placeholderValidationFailureCount),
    "providerFailureCount": .i(report.providerFailureCount),
    "semanticFallbackCount": .i(report.semanticFallbackCount),
    "continuationGroupCount": .i(report.continuationGroupCount),
    "failedParagraphAddresses": J.a(report.failedParagraphAddresses.map {
      J.o(["page": .i($0.pageIndex), "paragraph": .i($0.paragraphIndex)])
    }.sorted { a, b in
      if case let .o(lhs) = a, case let .o(rhs) = b,
         case let .i(left) = lhs["page"]!, case let .i(right) = rhs["page"]!,
         case let .i(leftParagraph) = lhs["paragraph"]!, case let .i(rightParagraph) = rhs["paragraph"]! {
        if left != right { return left < right }
        return leftParagraph < rightParagraph
      }
      return false
    }),
  ])
  try writeRaw(value, to: url)
}

func writeSemanticReport(_ report: SemanticEnrichmentReport, to url: URL) throws {
  let value = J.o([
    "pdfParagraphCount": .i(report.pdfParagraphCount),
    "matchedPDFParagraphCount": .i(report.matchedPDFParagraphCount),
    "flowPDFParagraphCount": .i(report.flowPDFParagraphCount),
    "matchedFlowPDFParagraphCount": .i(report.matchedFlowPDFParagraphCount),
    "matchedPDFCoverage": .d(report.matchedPDFCoverage),
    "highConfidenceMatchCount": .i(report.highConfidenceMatchCount),
    "mediumConfidenceMatchCount": .i(report.mediumConfidenceMatchCount),
    "lowConfidenceMatchCount": .i(report.lowConfidenceMatchCount),
    "structuralChangesEnabled": .b(report.structuralChangesEnabled),
    "diagnostics": J.a(report.diagnostics.map { diagnostic in
      J.o([
        "kind": .s(String(describing: diagnostic.kind)),
        "accepted": .b(diagnostic.accepted),
        "sourceBlockIDs": J.a(diagnostic.sourceBlockIDs.map { J.s($0) }),
        "pdfParagraphIDs": J.a(diagnostic.pdfParagraphIDs.map { J.s($0) }),
      ])
    }),
    "matches": J.a(report.alignment.matches.map { match in
      J.o([
        "source": J.o(["start": .i(match.sourceRange.lowerBound), "end": .i(match.sourceRange.upperBound)]),
        "pdf": J.o(["start": .i(match.pdfRange.lowerBound), "end": .i(match.pdfRange.upperBound)]),
        "score": .d(match.score),
        "confidence": .s(match.confidence.rawValue),
      ])
    }),
  ])
  try writeRaw(value, to: url)
}

let encoder = BabelDocIL.Document.makeJSONEncoder()

func write<T: Encodable>(_ value: T, to url: URL) throws {
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try encoder.encode(value).write(to: url)
}

let command = try parse(CommandLine.arguments)

switch command.mode {
case "frontend":
  let document = try PDFFrontendExtractor.extract(
    pdfURL: command.input,
    pages: command.options.pages.map { Array($0) },
    mupdfLibraryPath: command.options.mupdfLibrary
  )
  try write(document, to: command.output)
  print("frontend pages=\(document.page.count)")

case "stages":
  let options = command.options
  var document = try PDFFrontendExtractor.extract(
    pdfURL: command.input,
    pages: options.pages.map { Array($0) },
    mupdfLibraryPath: options.mupdfLibrary
  )
  try write(document, to: command.output.appendingPathComponent("00-frontend.json"))

  let detector = try LayoutDetector(configuration: .init(
    modelPath: options.model.path,
    confidenceThreshold: BabelDocModelMetadata.defaultConfidenceThreshold,
    preferCoreML: !options.cpu
  ))
  let selectedPages = options.pages ?? 0..<max(document.total_pages ?? document.page.count, 1)
  var pageResults: [PageLayoutResult] = []
  for pageNumber in selectedPages {
    let loaded = try DocumentLoader.loadPages(
      from: command.input.path,
      selectedPage: pageNumber + 1,
      pdfRenderer: .mupdf(libraryPath: options.mupdfLibrary)
    )
    guard let page = loaded.first else { throw CommandLineError("page \(pageNumber + 1) unavailable") }
    pageResults.append(try detector.detect(page: page))
  }
  try write(pageResults, to: command.output.appendingPathComponent("01-layout-detections.json"))

  try LayoutParser.writeLayouts(to: &document, pageResults: pageResults)
  try write(document, to: command.output.appendingPathComponent("02-il-after-layout.json"))

  for index in document.page.indices {
    LayoutParser.appendFallbackLines(to: &document.page[index])
  }
  try write(document, to: command.output.appendingPathComponent("03-il-after-fallback.json"))

  do {
    try ParagraphFinder.process(&document)
    try write(document, to: command.output.appendingPathComponent("04-il-after-paragraph.json"))
    print("stages paragraphs=\(document.page.reduce(0) { $0 + $1.pdf_paragraph.count })")

    guard let fontDirectory = options.fontDirectory else {
      throw CommandLineError("--font-directory is required for the style stages")
    }
    StylesAndFormulas.process(
      &document,
      configuration: .init(targetFontDirectory: fontDirectory)
    )
    try write(document, to: command.output.appendingPathComponent("05-il-after-styles.json"))

    // Deterministic semantic hints derived from the styles-stage document; the
    // snapshot is taken after enrichment, as the pipeline does.
    let semanticHints = synthesizeSemanticHints(document)
    let semanticResult = try SemanticHintEnricher.process(&document, hints: semanticHints)
    try write(document, to: command.output.appendingPathComponent("055-il-after-semantic.json"))
    try writeSemanticReport(semanticResult.report, to: command.output.appendingPathComponent("055-semantic-report.json"))
    try writeSemanticContexts(semanticResult.paragraphContexts, to: command.output.appendingPathComponent("055-semantic-contexts.json"))

    let snapshot = SourceParagraphSnapshot(document: document)
    try writeSnapshot(snapshot, to: command.output.appendingPathComponent("05-source-snapshot.json"))

    let mockTranslator = ParityMockTranslator()
    let translationReport = try await ILTranslator.processAsync(
      &document,
      using: mockTranslator,
      configuration: .init(documentTitle: "Parity Mock Paper", glossary: "term\\nglossary")
    )
    try write(document, to: command.output.appendingPathComponent("065-il-after-translation.json"))
    try writeTranslationReport(translationReport, to: command.output.appendingPathComponent("065-translation-report.json"))

    let typesettingReport = try Typesetting.process(
      &document,
      configuration: .init(
        targetLanguage: "zh",
        targetFontDirectory: fontDirectory,
        preservedParagraphAddresses: translationReport.failedParagraphAddresses
      )
    )
    try write(document, to: command.output.appendingPathComponent("07-il-after-typesetting.json"))
    try writeTypesettingReport(typesettingReport, to: command.output.appendingPathComponent("07-typesetting-report.json"))

    let plan = SourcePreservingPlanner.makePlan(
      document: document, snapshot: snapshot, typesetting: typesettingReport
    )
    try writePlan(plan, to: command.output.appendingPathComponent("07-source-plan.json"))

    let rebuild = try NativePDFBackend.write(
      sourcePDF: command.input,
      document: document,
      outputPDF: command.output.appendingPathComponent("08-backend-rebuild.pdf"),
      configuration: .init(
        targetFontDirectory: fontDirectory,
        mupdfLibraryPath: options.mupdfLibrary,
        renderingMode: .rebuildFromIL
      )
    )
    try writeBackendReport(rebuild, to: command.output.appendingPathComponent("08-backend-report-rebuild.json"))

    let preserved = try NativePDFBackend.write(
      sourcePDF: command.input,
      document: document,
      outputPDF: command.output.appendingPathComponent("09-backend-source-preserving.pdf"),
      configuration: .init(
        targetFontDirectory: fontDirectory,
        mupdfLibraryPath: options.mupdfLibrary,
        renderingMode: .sourcePreserving
      ),
      sourcePlan: plan
    )
    try writeBackendReport(preserved, to: command.output.appendingPathComponent("09-backend-report-source-preserving.json"))
    print("stages backends rebuild=\(rebuild.pages.map { $0.outcome.rawValue }.joined(separator: ","))")
  } catch let error as ParagraphFinderError {
    // Synthetic fixtures can be entirely textless; the earlier stages still compare.
    print("stages paragraph stage skipped: \(error.errorDescription ?? "no paragraphs")")
  }

default:
  throw CommandLineError("Unknown mode: \(command.mode)")
}
