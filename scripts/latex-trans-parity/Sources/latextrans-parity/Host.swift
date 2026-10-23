// Copied from read-paper (ReadPaper/Services/LaTeXTranslationService.swift and

// AcademicTranslationPrompt.swift): the host behavior Freddie ports alongside the kit.

import Foundation

import LaTeXTransKit



struct TranslationGlossaryPreference {
    static let maximumLength = 12_000

    static func normalized(_ value: String?) -> String {
        guard let value else { return "" }
        let normalizedLines = value
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.isEmpty == false }
        return String(normalizedLines.joined(separator: "\n").prefix(maximumLength))
    }

}

enum ReadPaperArXivIdentifier {
    static func resolving(id: String, version: String?) -> String {
        let identifier = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard identifier.range(of: #"v\d+$"#, options: .regularExpression) == nil,
              let rawVersion = version?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawVersion.isEmpty else {
            return identifier
        }
        if rawVersion.range(of: #"^v\d+$"#, options: .regularExpression) != nil {
            return identifier + rawVersion
        }
        if rawVersion.range(of: #"^\d+$"#, options: .regularExpression) != nil {
            return identifier + "v" + rawVersion
        }
        return identifier
    }
}

enum ReadPaperLaTeXTerminology {
    static func entries(from glossary: String) -> [TerminologyEntry] {
        TranslationGlossaryPreference.normalized(glossary)
            .split(separator: "\n")
            .compactMap { line in
                let text = String(line)
                for separator in ["=>", "→", "=", "\t"] {
                    let parts = text.components(separatedBy: separator)
                    guard parts.count == 2 else { continue }
                    let source = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
                    let target = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
                    if !source.isEmpty, !target.isEmpty {
                        return TerminologyEntry(source: source, target: target)
                    }
                }
                return nil
            }
    }
}

struct ReadPaperLaTeXEngineCompatibilityPreamblePolicy: LaTeXPreambleTransforming {
    private let base: any LaTeXPreambleTransforming

    init(base: any LaTeXPreambleTransforming = ReferenceLanguagePreamblePolicy()) {
        self.base = base
    }

    func transform(_ source: String, targetLanguage: TranslationLanguage) throws -> String {
        let transformed = try base.transform(source, targetLanguage: targetLanguage)
        return Self.normalizeEngineSpecificSource(transformed)
    }

    static func normalizeEngineSpecificSource(_ source: String) -> String {
        var result = source
        // Repair translated projects produced by the short-lived buggy rewrite that
        // emitted a literal "n" where the command separator should have been.
        result = replacingLines(
            matching: #"(?m)^([ \t]*)\\providecommand\{\\chinese\}\{\}n\\renewcommand\{\\chinese\}([^\r\n]*)$"#,
            with: #"$1\\providecommand{\\chinese}{}"#
                + "\n"
                + #"$1\\renewcommand{\\chinese}$2"#,
            in: result
        )
        // ctex owns \chinese as a numeral command. Legacy projects sometimes use the
        // same name as a CJK text wrapper, so make their definition safe to override.
        result = replacingLines(
            matching: #"(?m)^([ \t]*)\\newcommand[ \t]*(?:\{[ \t]*\\chinese[ \t]*\}|\\chinese)([^\r\n]*)$"#,
            with: #"$1\\providecommand{\\chinese}{}"#
                + "\n"
                + #"$1\\renewcommand{\\chinese}$2"#,
            in: result
        )
        result = replacingLines(
            matching: #"(?m)^([ \t]*)\\(pdfoutput|pdfsuppresswarningpagegroup|pdfminorversion|pdfcompresslevel|pdfobjcompresslevel|pdfinclusioncopyfonts|pdfgentounicode)[ \t]*=[ \t]*([+-]?\d+)([ \t]*(?:%[^\r\n]*)?)$"#,
            with: #"$1\\ifdefined\\$2\\$2=$3\\fi$4"#,
            in: result
        )
        result = replacingLines(
            matching: #"(?m)^([ \t]*)(\\(pdfmapline|pdfmapfile|pdfglyphtounicode)[^%\r\n]*)([ \t]*(?:%[^\r\n]*)?)$"#,
            with: #"$1\\ifdefined\\$3$2\\fi$4"#,
            in: result
        )
        result = replacingLines(
            matching: #"(?m)^([ \t]*)(\\DisableLigatures[^%\r\n]*)([ \t]*(?:%[^\r\n]*)?)$"#,
            with: #"$1\\ifdefined\\pdftexversion$2\\fi$3"#,
            in: result
        )
        return replacingLines(
            matching: #"(?m)^([ \t]*)(\\(?:usepackage|RequirePackage))[ \t]*(?:\[[^\]]*\])?[ \t]*\{inputenc\}([ \t]*(?:%[^\r\n]*)?)$"#,
            with: #"$1\\ifdefined\\pdftexversion$2[utf8]{inputenc}\\fi$3"#,
            in: result
        )
    }

    private static func replacingLines(
        matching pattern: String,
        with replacement: String,
        in source: String
    ) -> String {
        source.replacingOccurrences(
            of: pattern,
            with: replacement,
            options: .regularExpression
        )
    }
}

enum ReadPaperLaTeXProjectCompatibilityNormalizer {
    private static let sourceExtensions: Set<String> = [
        "tex", "cls", "sty", "ltx", "def", "cfg",
    ]

    static func normalizeProject(
        at projectDirectory: URL,
        literalPercentMarker: String? = nil,
        fileManager: FileManager = .default
    ) throws {
        let resourceKeys: [URLResourceKey] = [
            .isRegularFileKey,
            .isSymbolicLinkKey,
        ]
        guard let enumerator = fileManager.enumerator(
            at: projectDirectory,
            includingPropertiesForKeys: resourceKeys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            throw CocoaError(.fileReadUnknown)
        }

        for case let fileURL as URL in enumerator {
            try Task.checkCancellation()
            guard sourceExtensions.contains(fileURL.pathExtension.lowercased()) else {
                continue
            }
            let values = try fileURL.resourceValues(forKeys: Set(resourceKeys))
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                continue
            }
            guard let source = try? String(contentsOf: fileURL, encoding: .utf8) else {
                continue
            }
            var normalized = ReadPaperLaTeXEngineCompatibilityPreamblePolicy
                .normalizeEngineSpecificSource(source)
            if let literalPercentMarker {
                normalized = normalized.replacingOccurrences(
                    of: literalPercentMarker,
                    with: "%"
                )
            }
            if normalized != source {
                try normalized.write(to: fileURL, atomically: true, encoding: .utf8)
            }
        }
    }

    @discardableResult
    static func enableDraftModeForFrozenMintedCaches(
        at projectDirectory: URL,
        fileManager: FileManager = .default
    ) throws -> Bool {
        let resourceKeys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey]
        guard let enumerator = fileManager.enumerator(
            at: projectDirectory,
            includingPropertiesForKeys: resourceKeys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            throw CocoaError(.fileReadUnknown)
        }

        var changed = false
        for case let fileURL as URL in enumerator {
            try Task.checkCancellation()
            guard sourceExtensions.contains(fileURL.pathExtension.lowercased()) else {
                continue
            }
            let values = try fileURL.resourceValues(forKeys: Set(resourceKeys))
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let source = try? String(contentsOf: fileURL, encoding: .utf8) else {
                continue
            }
            let normalized = replacingFrozenMintedCacheOption(in: source)
            guard normalized != source else { continue }
            try normalized.write(to: fileURL, atomically: true, encoding: .utf8)
            changed = true
        }
        return changed
    }

    static func replacingFrozenMintedCacheOption(in source: String) -> String {
        let pattern = #"(?m)(\\(?:usepackage|RequirePackage)\s*\[)([^\]\r\n]*)(\]\s*\{minted\})"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return source
        }
        var result = source
        let matches = expression.matches(
            in: source,
            range: NSRange(source.startIndex..<source.endIndex, in: source)
        )
        for match in matches.reversed() {
            guard let wholeRange = Range(match.range, in: result),
                  let optionsRange = Range(match.range(at: 2), in: result) else {
                continue
            }
            let options = result[optionsRange]
                .split(separator: ",", omittingEmptySubsequences: false)
                .map(String.init)
            guard options.contains(where: {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
                    .caseInsensitiveCompare("frozencache") == .orderedSame
            }) else {
                continue
            }
            let replacementOptions = options.map { option in
                if option.trimmingCharacters(in: .whitespacesAndNewlines)
                    .caseInsensitiveCompare("frozencache") == .orderedSame {
                    return "draft"
                }
                return option
            }.joined(separator: ",")
            let whole = String(result[wholeRange])
            let originalOptions = String(result[optionsRange])
            result.replaceSubrange(
                wholeRange,
                with: whole.replacingOccurrences(of: originalOptions, with: replacementOptions)
            )
        }
        return result
    }
}

struct ReadPaperLiteralPercentPreservingLaTeXParser: LaTeXProjectParsing {
    private static let sourceExtensions: Set<String> = [
        "tex", "cls", "sty", "ltx", "def", "cfg",
    ]
    private static let verbatimEnvironmentPattern =
        #"(?s)\\begin\s*\{(minted\*?|lstlisting\*?|verbatim\*?)\}.*?\\end\s*\{\1\}"#

    private let marker: String
    private let base: any LaTeXProjectParsing

    init(
        marker: String,
        base: any LaTeXProjectParsing = StructuredLaTeXParser()
    ) {
        self.marker = marker
        self.base = base
    }

    func parse(_ project: PreparedProject) async throws -> ParsedLaTeXProject {
        let snapshots = try protectLiteralPercents(in: project.sourceDirectory)
        do {
            let parsed = try await base.parse(project)
            try restore(snapshots)
            return parsed
        } catch {
            try? restore(snapshots)
            throw error
        }
    }

    private func protectLiteralPercents(in projectDirectory: URL) throws -> [SourceSnapshot] {
        let fileManager = FileManager.default
        let resourceKeys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey]
        guard let enumerator = fileManager.enumerator(
            at: projectDirectory,
            includingPropertiesForKeys: resourceKeys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            throw CocoaError(.fileReadUnknown)
        }

        var snapshots: [SourceSnapshot] = []
        do {
            for case let fileURL as URL in enumerator {
                try Task.checkCancellation()
                guard Self.sourceExtensions.contains(fileURL.pathExtension.lowercased()) else {
                    continue
                }
                let values = try fileURL.resourceValues(forKeys: Set(resourceKeys))
                guard values.isRegularFile == true, values.isSymbolicLink != true else {
                    continue
                }
                guard let source = try? String(contentsOf: fileURL, encoding: .utf8) else {
                    continue
                }
                let protected = Self.protectingLiteralPercents(in: source, marker: marker)
                guard protected != source else { continue }
                snapshots.append(SourceSnapshot(fileURL: fileURL, source: source))
                try protected.write(to: fileURL, atomically: true, encoding: .utf8)
            }
            return snapshots
        } catch {
            try? restore(snapshots)
            throw error
        }
    }

    private func restore(_ snapshots: [SourceSnapshot]) throws {
        for snapshot in snapshots {
            try snapshot.source.write(
                to: snapshot.fileURL,
                atomically: true,
                encoding: .utf8
            )
        }
    }

    static func protectingLiteralPercents(in source: String, marker: String) -> String {
        guard source.contains("%"),
              let expression = try? NSRegularExpression(
                  pattern: verbatimEnvironmentPattern
              ) else {
            return source
        }
        var result = source
        let matches = expression.matches(
            in: source,
            range: NSRange(source.startIndex..<source.endIndex, in: source)
        )
        for match in matches.reversed() {
            guard let range = Range(match.range, in: result) else { continue }
            let environment = result[range].replacingOccurrences(of: "%", with: marker)
            result.replaceSubrange(range, with: environment)
        }
        return result
    }

    private struct SourceSnapshot {
        let fileURL: URL
        let source: String
    }
}

enum ReadPaperLaTeXProgressMapper {
    static func update(for event: PipelineEvent) -> ProgressUpdate {
        let unitFraction: Double = {
            guard let completed = event.completedUnitCount,
                  let total = event.totalUnitCount,
                  total > 0 else {
                return 0
            }
            return min(max(Double(completed) / Double(total), 0), 1)
        }()
        let fraction: Double
        switch event.stage {
        case .preparing:
            fraction = 0.03
        case .parsing:
            fraction = 0.10
        case .translating:
            fraction = 0.15 + (0.55 * unitFraction)
        case .validating:
            fraction = 0.74
        case .reconstructing:
            fraction = 0.82
        case .compiling:
            fraction = 0.92
        case .finished:
            fraction = 1
        }
        return ProgressUpdate(
            stage: event.stage,
            completedUnits: event.completedUnitCount,
            totalUnits: event.totalUnitCount,
            fractionCompleted: fraction
        )
    }
}

struct ProgressUpdate: Equatable, Sendable {
    var stage: PipelineStage
    var completedUnits: Int?
    var totalUnits: Int?
    var fractionCompleted: Double
}
