// Runs the Swift LaTeXTransKit over the fixture corpus in tests/fixtures/latex-trans and
// writes everything the TypeScript port must reproduce to parity.json. Model calls use
// scripted answers; the fixture records each request with its answer so the TypeScript
// tests can replay them in order.
//
// Usage: latextrans-parity <tests/fixtures/latex-trans> <LaTeXTransKit/resources>
import CryptoKit
import Foundation
import LaTeXTransKit

// `--compile <project>` compiles a project with the Swift compiler and reports its attempts.
if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "--compile" {
    let compiler = MacOSLaTeXCompiler(engines: [.xeLaTeX, .pdfLaTeX, .luaLaTeX])
    do {
        let artifact = try await compiler.compile(projectDirectory: URL(fileURLWithPath: CommandLine.arguments[2]), configuration: .init(targetLanguage: .simplifiedChinese))
        print("ok", artifact.pdfURL.path, artifact.attempts.map { "\($0.engine.rawValue):\($0.exitCode.map(String.init) ?? "-"):\($0.succeeded)" })
    } catch let LaTeXCompilationError.allAttemptsFailed(attempts) {
        print("failed", attempts.map { "\($0.engine.rawValue):\($0.exitCode.map(String.init) ?? "-"):\($0.succeeded)" })
    }
    exit(0)
}

let fixtures = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let resources = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
// Not below /var: macOS reaches it through a symbolic link, and the Swift project copier
// then computes wrong relative paths (it resolves the root but not the enumerated items).
let work = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    .deletingLastPathComponent()
    .appendingPathComponent("parity-work-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: work) }

// MARK: JSON values

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

func opt(_ value: String?) -> J { value.map(J.s) ?? .null }
func opt(_ value: Int?) -> J { value.map(J.i) ?? .null }

/// Paths in messages are replaced by `<root>` (the project) or `<fixtures>`, in every spelling macOS uses.
func normalized(_ text: String, root: URL? = nil) -> String {
    var result = text
    for (url, name) in [(root, "<root>"), (fixtures, "<fixtures>"), (work, "<work>")] {
        guard let path = url?.standardizedFileURL.path else { continue }
        let bare = path.hasPrefix("/private/") ? String(path.dropFirst("/private".count)) : path
        for prefix in ["/private" + bare, bare] {
            result = result.replacingOccurrences(of: prefix, with: name)
        }
    }
    return result
}

func errorJSON(_ error: Error, root: URL? = nil) -> J {
    .o(["type": .s(String(describing: type(of: error))), "message": .s(normalized(error.localizedDescription, root: root))])
}

func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// Every regular file below `directory`: UTF-8 text verbatim, anything else by hash.
func tree(_ directory: URL) -> J {
    var files: [String: J] = [:]
    let root = directory.resolvingSymlinksInPath().path
    guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey]) else { return .o([:]) }
    for case let url as URL in enumerator {
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
        let path = url.resolvingSymlinksInPath().path
        // Foundation reports decomposed names; compare them composed.
        let relative = String(path.dropFirst(root.count + 1)).precomposedStringWithCanonicalMapping
        let data = (try? Data(contentsOf: url)) ?? Data()
        if relative.hasSuffix(".tex") || relative.hasSuffix(".sty") || relative.hasSuffix(".cls"), let text = String(data: data, encoding: .utf8) {
            files[relative] = .o(["text": .s(text)])
        } else {
            files[relative] = .o(["sha256": .s(sha256(data)), "size": .i(data.count)])
        }
    }
    return .o(files)
}

func copyProject(_ name: String) throws -> URL {
    let source = fixtures.appendingPathComponent("projects/\(name)", isDirectory: true)
    let destination = work.appendingPathComponent("sources/\(UUID().uuidString)/\(name)", isDirectory: true)
    try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: source, to: destination)
    return destination
}

// MARK: Model encoding

func unitJSON(_ unit: LaTeXUnit) -> J {
    .o(["id": .s(unit.id), "kind": .s(unit.kind.rawValue), "source": .s(unit.source), "shouldTranslate": .b(unit.shouldTranslate)])
}

func translatedJSON(_ unit: TranslatedLaTeXUnit) -> J {
    .o(["id": .s(unit.id), "kind": .s(unit.kind.rawValue), "source": .s(unit.source), "translation": .s(unit.translation), "completeness": .s(unit.completeness.rawValue)])
}

func issueJSON(_ issue: ValidationIssue) -> J {
    .o(["id": .s(issue.id), "unitID": .s(issue.unitID), "severity": .s(issue.severity.rawValue), "code": .s(issue.code), "message": .s(issue.message)])
}

func parsedJSON(_ parsed: ParsedLaTeXProject, root: URL) -> J {
    let rootPath = root.resolvingSymlinksInPath().path
    let main = parsed.mainFile.resolvingSymlinksInPath().path
    return .o([
        "mainFile": .s(main.hasPrefix(rootPath + "/") ? String(main.dropFirst(rootPath.count + 1)) : normalized(main)),
        "units": .a(parsed.units.map(unitJSON)),
        "inputs": .a(parsed.inputs.map { .o(["command": .s($0.command), "begin": .s($0.beginPlaceholder), "end": .s($0.endPlaceholder), "path": .s($0.path)]) }),
        "environments": .a(parsed.environments.map { .o(["placeholder": .s($0.placeholder), "env_name": .s($0.name), "content": .s($0.content), "trans_content": .s($0.translatedContent), "need_trans": .b($0.needsTranslation)]) }),
        "captions": .a(parsed.captions.map { .o(["placeholder": .s($0.placeholder), "cap_type": .s($0.type), "content": .s($0.content), "trans_content": .s($0.translatedContent)]) }),
        "newCommands": .a(parsed.newCommands.map { .o(["placeholder": .s($0.placeholder), "name": .s($0.name), "content": .s($0.content)]) }),
        "sections": .a(parsed.sections.map { .o(["section": .s($0.identifier), "content": .s($0.content), "trans_content": .s($0.translatedContent)]) }),
    ])
}

func tokenJSON(_ token: LaTeXStructuralToken) -> J {
    switch token {
    case let .command(value): .o(["kind": .s("command"), "value": .s(value)])
    case let .beginEnvironment(value): .o(["kind": .s("beginEnvironment"), "value": .s(value)])
    case let .endEnvironment(value): .o(["kind": .s("endEnvironment"), "value": .s(value)])
    case let .placeholder(value): .o(["kind": .s("placeholder"), "value": .s(value)])
    case let .numericAssignment(command, value): .o(["kind": .s("numericAssignment"), "command": .s(command), "value": .s(value)])
    case let .mathDelimiter(value): .o(["kind": .s("mathDelimiter"), "value": .s(value)])
    case let .openingDelimiter(value): .o(["kind": .s("openingDelimiter"), "value": .s(value)])
    case let .closingDelimiter(value): .o(["kind": .s("closingDelimiter"), "value": .s(value)])
    }
}

// MARK: Scripted model

struct Slot: Decodable { let id: String; let source: String }

func slots(in request: LaTeXPromptRequest) -> [Slot] {
    guard let user = request.messages.last?.content,
          let range = user.range(of: "[Translation slots JSON]\n") else { return [] }
    let line = user[range.upperBound...].split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? "[]"
    return (try? JSONDecoder().decode([Slot].self, from: Data(line.utf8))) ?? []
}

func encodeAnswer(_ pairs: [(String, String)]) -> String {
    struct Answer: Encodable { let id: String; let translation: String }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(data: try! encoder.encode(pairs.map { Answer(id: $0.0, translation: $0.1) }), encoding: .utf8)!
}

/// A deterministic answer in one of several shapes, good and bad.
func answer(_ strategy: String, _ request: LaTeXPromptRequest) -> String {
    let slots = slots(in: request)
    let translated = slots.map { ($0.id, "译" + $0.source) }
    switch strategy {
    case "translate": return encodeAnswer(translated)
    case "garbage": return "I cannot help with that request."
    case "partial": return encodeAnswer(Array(translated.dropLast()))
    case "echo": return encodeAnswer(slots.map { ($0.id, $0.source) })
    case "unsafe": return encodeAnswer(translated.enumerated().map { $0.offset == 0 ? ($0.element.0, #"\textbf{坏}"#) : ($0.offset == 1 ? ($0.element.0, "$x$") : $0.element) })
    case "fenced": return "Here you go:\n```json\n" + encodeAnswer(translated) + "\n```\nDone."
    case "duplicate": return encodeAnswer(translated + translated.prefix(1).map { ($0.0, "重复") })
    case "whitespace": return encodeAnswer(translated.map { ($0.0, "  \n" + $0.1 + "\t ") })
    case "empty": return ""
    case "nonstring": return #"[{"id": 1, "translation": "x"}]"#
    case "trailing": return "[" + translated.map { #"{"id":""# + $0.0 + #"","translation":"# + "\"" + $0.1 + "\"}" }.joined(separator: ",") + ",]"
    case "firstwins": return "[" + translated.map { #"{"id":""# + $0.0 + #"","translation":"# + "\"" + $0.1 + #"","translation":"后"}"# }.joined(separator: ",") + "]"
    case "prompt-echo": return request.messages.last?.content ?? ""
    default: fatalError("unknown strategy \(strategy)")
    }
}

actor ScriptedClient: LaTeXPromptCompleting {
    private(set) var calls: [J] = []
    private var counts: [String: Int] = [:]
    private let plan: @Sendable (String, Int) -> String
    private let summary: String

    init(summary: String = "The paper studies structured translation of LaTeX sources.", plan: @escaping @Sendable (String, Int) -> String) {
        self.plan = plan
        self.summary = summary
    }

    func complete(_ request: LaTeXPromptRequest) async throws -> String {
        let purpose: J
        let response: String
        switch request.purpose {
        case let .translation(unitID, kind, attempt):
            let count = counts[unitID, default: 0]
            counts[unitID] = count + 1
            purpose = .o(["kind": .s("translation"), "unitID": .s(unitID), "unitKind": .s(kind.rawValue), "attempt": .i(attempt)])
            response = answer(plan(unitID, count), request)
        case .summary:
            purpose = .o(["kind": .s("summary")])
            response = summary
        }
        calls.append(.o([
            "purpose": purpose,
            "messages": .a(request.messages.map { .o(["role": .s($0.role.rawValue), "content": .s($0.content)]) }),
            "temperature": .d(request.temperature),
            "maximumOutputTokens": .i(request.maximumOutputTokens),
            "response": .s(response),
        ]))
        return response
    }
}

actor RecordingCheckpoints: TranslationCheckpointStoring {
    private(set) var store: [String: String]
    private(set) var operations: [J] = []

    init(_ initial: [String: String] = [:]) { store = initial }

    func translation(unitID: String, fingerprint: String) -> String? {
        operations.append(.o(["op": .s("get"), "unitID": .s(unitID), "fingerprint": .s(fingerprint)]))
        return store[unitID + "\u{1F}" + fingerprint]
    }

    func saveTranslation(_ translation: String, unitID: String, fingerprint: String) {
        operations.append(.o(["op": .s("save"), "unitID": .s(unitID), "fingerprint": .s(fingerprint), "translation": .s(translation)]))
        store[unitID + "\u{1F}" + fingerprint] = translation
    }
}

let strategyPlans: [[String]] = [
    ["translate"],
    ["garbage", "translate"],
    ["partial", "partial", "partial"],
    ["echo", "echo", "echo"],
    ["unsafe", "fenced", "translate"],
    ["duplicate", "whitespace"],
    ["empty", "translate"],
    ["nonstring", "trailing"],
    ["firstwins"],
    ["prompt-echo", "garbage", "partial"],
]

@Sendable func planByHash(_ unitID: String, _ count: Int) -> String {
    let plan = strategyPlans[unitID.utf8.reduce(0) { ($0 &* 31 &+ Int($1)) & 0xFFFF } % strategyPlans.count]
    return plan[min(count, plan.count - 1)]
}

func contextJSON(_ context: TranslationContext) -> J {
    .o([
        "sourceLanguage": .s(context.sourceLanguage.identifier),
        "targetLanguage": .s(context.targetLanguage.identifier),
        "attempt": .i(context.attempt),
        "validationIssues": .a(context.validationIssues.map(issueJSON)),
        "previousTranslations": .a(context.previousTranslations.map(translatedJSON)),
        "terminology": .a(context.terminology.map { .o(["source": .s($0.source), "target": .s($0.target)]) }),
        "documentSummary": opt(context.documentSummary),
        "maximumConcurrentTranslations": .i(context.maximumConcurrentTranslations),
        "previousContextUnitCount": .i(context.previousContextUnitCount),
    ])
}

// MARK: Corpus

let unitSources: [(String, String)] = [
    ("section:math-retry", #"Dynamic mode uses n$\times$640$\times$640 tiles and outputs $n\times100+256$."#),
    ("section:math-syntax", #"Inline \(x+y\), display \[z\], dollars $$q$$, cost 5\% and literal \$5."#),
    ("section:commands", #"See \autoref{fig:api}; \textsection\ref{sec:x}; \underline{\textit{\smash{flow}}}. \begin{quote}Text \% \$ \\ \end{quote}"#),
    ("section:list-options", #"\thispagestyle{fancy}\begin{itemize}[leftmargin=2em, itemsep=-0.3em, topsep=-0.2em]\item First item.\end{itemize}"#),
    ("section:argument-roles", #"\begin{projectbox}[mode=fast]{5cm}\fontsize{10pt}{12pt}\selectfont \makebox[3cm][l]{Body} \textcolor[named]{red}{Warning} \href[page=2]{manual.pdf}{Manual} \raisebox{1ex}[2ex][0pt]{Raised text}\end{projectbox}"#),
    ("section:looseness-1", #"\looseness=-1 Source prose."#),
    ("section:looseness-2", #"\looseness=+12 Source prose."#),
    ("section:looseness-3", #"\looseness90 Source prose."#),
    ("section:looseness-whitespace", #"\looseness = - 12 Source prose."#),
    ("section:verbatim", #"Use \texttt{language=Python}, \lstinline[language=TeX]|$x+\alpha$|, \mintinline[bgcolor=gray]{python}|print("x")|, \verb|raw code|, \Verb[formatcom=\small]|$raw$|, and \verbatiminput{code.py}. After."#),
    ("section:unknown-command", #"Before \project_macro:nn[mode={fast,[safe]}]{5cm}{Opaque {payload}} after."#),
    ("section:text-arguments", #"\section[Short title]{Long title}\item[Named label] Body"#),
    ("section:unsafe", #"\begin{abstract}\section{Background}\noindent\textit{Stage $x$.} Text <PLACEHOLDER_ENV_4> and \autoref{fig:x}.\end{abstract}"#),
    ("section:math-atoms", #"At 9-10$\times$, accuracy is $\sim$90\%; at 10-12$\times$, it is $\sim$60\%; also 16$\times$ and n$\times$640$\times$640."#),
    ("section:boundary", "<PLACEHOLDER_content/introduction.tex_begin>\nSource text.\n<PLACEHOLDER_ENV_1>\n<PLACEHOLDER_content/introduction.tex_end>"),
    ("caption:<PLACEHOLDER_CAP_1>", #"\caption{Overview of the pipeline: units flow from parsing to reconstruction.}"#),
    ("section:comments", "Text before % a comment with $math$ and \\cmd\nnext line \\% not a comment $a$ 50\\% done."),
    ("section:placeholder-collision", "Literal <PLACEHOLDER_TRANSLATION_MATH_1> and <PLACEHOLDER_TRANSLATION_COMMAND_1> appear with $x$ and \\emph{y}."),
    ("section:unicode", "Caf\u{E9} and cafe\u{301} \u{4E00}$x$ with \u{FF15}$y$ and \u{BD}$z$; emoji \u{1F44D}\u{1F3FD} \\textbf{e\u{301}t\u{E9}}\\ignore\u{301} after.\r\nCRLF line\rCR line\u{2028}separator."),
    ("section:short", "a"),
    ("section:identifiers", "See github.com/user_name and foo@bar.org or A:B; x."),
    ("section:prose-echo", "This sentence has more than six words so echo is untranslated."),
    ("environment:<PLACEHOLDER_ENV_2>", "\\begin{theorem}[Main result]\nEvery structured unit can be translated independently.\n\\end{theorem}"),
    ("section:nested-groups", #"\footnote[3]{A note with \cite[p.~4]{key} and \textbf{bold {nested} text}.} \caption*{Starred} \multirow{2}{*}{Merged cells} \url{http://x.org/a%20b} \path{C:\dir}"#),
    ("section:unterminated", #"Broken \textbf{unclosed group and $unclosed math and \verb|unterminated"#),
    ("section:escapes", ##"Escaped \{ braces \} and \\ newline \& amp \# hash \_ under \^ caret \~ tilde."##),
    ("section:begin-space", #"\begin {center} Spaced begin. \end {center} \begin{tabular}{lc} a & b \\ \end{tabular}"#),
    ("section:operators", "Ranges 1.5$x$, 3/4$y$, 2:1$z$, 5\u{2013}6$w$ and a$b$ c1$d$ x$y$z."),
]

let validationPairs: [(String, String)] = [
    (#"Keep \textbf{bold} and $x$ with <PLACEHOLDER_CAP_1>."#, #"保留 \textbf{粗体} 和 $x$ <PLACEHOLDER_CAP_1>。"#),
    (#"Keep \textbf{bold} and $x$ with <PLACEHOLDER_CAP_1>."#, #"保留 \emph{粗体} 和 x <PLACEHOLDER_CAP_2> <PLACEHOLDER_CAP_2>。"#),
    (#"\autoref{a} and \ref{b}"#, #"\ref{a} 和 \ref{b} \cite{c}"#),
    (#"$a$ then \(b\)"#, #"\(b\) 然后 $a$"#),
    (#"$a$ then \(b\)"#, #"$a$ 然后 \[b\]"#),
    (#"{balanced} [ok] (yes)"#, #"{不平衡 [好] (是)"#),
    (#"{unbalanced"#, #"{仍不平衡"#),
    (#"\looseness=-1 Text \looseness=2 more"#, #"\looseness=-2 文本 \looseness=2 更多"#),
    (#"\looseness=-1 Text"#, #"文本"#),
    (#"\begin{itemize}\item A\end{itemize}"#, #"\begin{enumerate}\item 甲\end{enumerate}"#),
    (#"\eg and \ie stay"#, #"不要"#),
    (#"% comment \cmd {"#, #"% 注释"#),
    (#"\verb|\x{| done"#, #"\verb|\x{| 完成"#),
    (#"<PLACEHOLDER_A> <PLACEHOLDER_B"#, #"<PLACEHOLDER_A>"#),
    (#"\section*{Title} \\ \, \;"#, #"\section{标题}"#),
]

let preambleSources: [String] = [
    "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
    "\\documentclass[11pt]{article}\n\\usepackage[fontset=ubuntu]{ctex}\n\\begin{document}\nx\n\\end{document}\n",
    "\\documentclass{article}\n\\usepackage[ utf8 , scheme=plain]{ctex}\n",
    "\\documentclass{article}\n\\usepackage{ctex}\n",
    "\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{CJKutf8}\n\\RequirePackage [ x ] {CJKutf8}\n\\begin{document}\n\\begin {CJK*} {UTF8} {gbsn}\nx\n\\end {CJK*}\n\\begin{CJK}{UTF8}{gkai}y\\end{CJK}\n\\end{document}\n",
    "% LaTeXTransKit: portable Unicode font compatibility\n\\documentclass{article}\n",
    "\\documentclass{article}\n\\usepackage{luatexja}\n",
    "No document class here.\n",
    "\\documentclass[a,b]{report}\\usepackage{x}",
]

let boundarySources: [String] = [
    #"\alpha中文 and \beta 中文 and \gamma{中}"#,
    #"\@internal译文 \ref{x}译 \\中 \textbf中"#,
    "\\cmd\u{E9}t\u{E9} \\cmde\u{301} \\x\u{1F44D} \\y\u{4E00}",
    #"\\\\段落"#,
]

// MARK: Run

var output: [String: J] = [:]

// Parser maps for every project, including failures.
var parserResults: [J] = []
let projectNames = try FileManager.default.contentsOfDirectory(atPath: fixtures.appendingPathComponent("projects").path).filter { !$0.hasPrefix(".") }.sorted()
var parsedProjects: [String: (URL, ParsedLaTeXProject)] = [:]
for name in projectNames {
    let root = try copyProject(name)
    do {
        let parsed = try await StructuredLaTeXParser().parse(PreparedProject(identifier: name, sourceDirectory: root, workspaceDirectory: work))
        parsedProjects[name] = (root, parsed)
        parserResults.append(.o(["name": .s(name), "parsed": parsedJSON(parsed, root: root)]))
    } catch {
        parserResults.append(.o(["name": .s(name), "error": errorJSON(error, root: root)]))
    }
}
output["parser"] = .a(parserResults)

// The token counter behind short-section merging, through a parser that merges below a threshold.
output["tokenizer"] = .a((unitSources.map(\.1) + validationPairs.flatMap { [$0.0, $0.1] }).map { text in
    .o(["text": .s(text), "tokens": .a(LaTeXStructuralTokenizer().tokenize(text).map(tokenJSON))])
})

// Translation scenarios.
let corpusUnits = unitSources.map { LaTeXUnit(id: $0.0, kind: $0.0.hasPrefix("caption:") ? .caption : $0.0.hasPrefix("environment:") ? .environment : .section, source: $0.1) }

func scenario(_ name: String, units: [LaTeXUnit], context: TranslationContext, checkpoints: [String: String] = [:], attempts: Int = 3, summarizer: Bool = false, summaryText: String = "The paper studies structured translation of LaTeX sources.", plan: @escaping @Sendable (String, Int) -> String = planByHash) async -> (J, [String: String]) {
    let client = ScriptedClient(summary: summaryText, plan: plan)
    let store = RecordingCheckpoints(checkpoints)
    let translator = PromptingLaTeXTranslator(
        client: client,
        summarizer: summarizer ? PromptLaTeXDocumentSummarizer(client: client) : nil,
        checkpointStore: store,
        maximumResponseAttempts: attempts
    )
    var result: J
    do {
        result = .a(try await translator.translate(units, context: context).map(translatedJSON))
    } catch {
        result = .o(["error": errorJSON(error)])
    }
    return (.o([
        "name": .s(name),
        "units": .a(units.map(unitJSON)),
        "context": contextJSON(context),
        "maximumResponseAttempts": .i(attempts),
        "summarizer": .b(summarizer),
        "summaryText": .s(summaryText),
        "initialCheckpoints": .o(checkpoints.mapValues(J.s)),
        "calls": .a(await client.calls),
        "checkpointOperations": .a(await store.operations),
        "result": result,
    ]), await store.store)
}

let terminology = [
    TerminologyEntry(source: "unit", target: "单元"),
    TerminologyEntry(source: "Unit", target: "单位"),
    TerminologyEntry(source: "accuracy", target: "准确率"),
    TerminologyEntry(source: "Écart", target: "偏差"),
    TerminologyEntry(source: "ecart", target: "差"),
]
var translationScenarios: [J] = []
let baseContext = TranslationContext(sourceLanguage: .english, targetLanguage: .simplifiedChinese, attempt: 0, terminology: terminology, documentSummary: "  A configured summary.  ", maximumConcurrentTranslations: 1, previousContextUnitCount: 1)
let (initial, saved) = await scenario("initial", units: corpusUnits, context: baseContext)
translationScenarios.append(initial)
let (resumed, _) = await scenario("resumed", units: corpusUnits, context: baseContext, checkpoints: saved)
translationScenarios.append(resumed)
// A legacy all-source checkpoint of a prose unit is requested again.
let proseUnit = corpusUnits.first { $0.id == "section:prose-echo" }!
let (probe, probeStore) = await scenario("probe", units: [proseUnit], context: baseContext, plan: { _, _ in "translate" })
translationScenarios.append(probe)
let sourceOnly = probeStore.mapValues { _ in proseUnit.source }
translationScenarios.append(await scenario("source-only-checkpoint", units: [proseUnit], context: baseContext, checkpoints: sourceOnly, plan: { _, _ in "translate" }).0)
let retryContext = TranslationContext(
    sourceLanguage: .english, targetLanguage: .japanese, attempt: 2,
    validationIssues: [
        ValidationIssue(unitID: "section:math-retry", severity: .error, code: "math-delimiter-mismatch", message: "Missing: '$' x2."),
        ValidationIssue(unitID: "section:commands", severity: .error, code: "command-mismatch", message: #"Missing or changed: '\autoref' x1."#),
        ValidationIssue(unitID: "section:commands", severity: .warning, code: "note", message: "Second issue."),
    ],
    previousTranslations: [TranslatedLaTeXUnit(id: "section:math-retry", kind: .section, source: "x", translation: #"动态模式使用n个640$\times$640分块"#)],
    maximumConcurrentTranslations: 1, previousContextUnitCount: 2
)
translationScenarios.append(await scenario("validation-retry", units: Array(corpusUnits.prefix(6)), context: retryContext, summarizer: true).0)
let summaryContext = TranslationContext(sourceLanguage: .english, targetLanguage: .simplifiedChinese, attempt: 0, maximumConcurrentTranslations: 1, previousContextUnitCount: 0)
translationScenarios.append(await scenario("summarized", units: Array(corpusUnits.suffix(5)), context: summaryContext, summarizer: true).0)
translationScenarios.append(await scenario("echoed-summary", units: Array(corpusUnits.suffix(3)), context: summaryContext, summarizer: true, summaryText: "Summarize the academic source text as compact context for translating the same document.").0)
translationScenarios.append(await scenario("copied-summary", units: [proseUnit], context: summaryContext, summarizer: true, summaryText: " This sentence has more than six words so echo is untranslated. ").0)
translationScenarios.append(await scenario("empty-responses", units: [proseUnit], context: summaryContext, plan: { _, _ in "empty" }).0)
translationScenarios.append(await scenario("single-attempt", units: Array(corpusUnits.prefix(8)), context: summaryContext, attempts: 1).0)
output["translation"] = .a(translationScenarios)

// Validation of rendered translations and of hand-made mismatches.
var validationResults: [J] = []
let validator = StructuralLaTeXValidator()
for (index, pair) in validationPairs.enumerated() {
    let unit = LaTeXUnit(id: "pair:\(index)", kind: .section, source: pair.0)
    let issues = try await validator.validate(sourceUnits: [unit], translatedUnits: [TranslatedLaTeXUnit(id: unit.id, kind: unit.kind, source: pair.0, translation: pair.1)])
    validationResults.append(.o(["source": .s(pair.0), "translation": .s(pair.1), "issues": .a(issues.map(issueJSON))]))
}
output["validation"] = .a(validationResults)

output["preamble"] = .a(try preambleSources.flatMap { source in
    try ["zh-Hans", "ja", "en"].map { language in
        .o(["source": .s(source), "language": .s(language), "output": .s(try ReferenceLanguagePreamblePolicy().transform(source, targetLanguage: TranslationLanguage(identifier: language)))])
    }
})

// The boundary normalizer is internal; it is observed through reconstruction of a one-section project.
var boundaryResults: [J] = []
for source in boundarySources {
    let root = work.appendingPathComponent("boundary-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try "\\documentclass{article}\n".write(to: root.appendingPathComponent("main.tex"), atomically: true, encoding: .utf8)
    let parsed = ParsedLaTeXProject(mainFile: root.appendingPathComponent("main.tex"), units: [LaTeXUnit(id: "section:1", kind: .section, source: "x")], sections: [LaTeXSection(identifier: "1", content: "x")])
    let destination = try await StructuredLaTeXReconstructor(preamblePolicy: IdentityPolicy()).reconstruct(
        project: PreparedProject(identifier: "boundary", sourceDirectory: root, workspaceDirectory: work.appendingPathComponent("boundary-out-\(UUID().uuidString)")),
        parsedProject: parsed,
        translatedUnits: [TranslatedLaTeXUnit(id: "section:1", kind: .section, source: "x", translation: source)],
        configuration: .init()
    )
    boundaryResults.append(.o(["input": .s(source), "output": .s(try String(contentsOf: destination.appendingPathComponent("main.tex"), encoding: .utf8))]))
}
output["boundary"] = .a(boundaryResults)

struct IdentityPolicy: LaTeXPreambleTransforming {
    func transform(_ source: String, targetLanguage: TranslationLanguage) throws -> String { source }
}

// Whole pipelines over the projects: kit components only, then read-paper's host components.
func pipelineRun(_ name: String, language: TranslationLanguage, host: Bool, summary: String?, terminology: [TerminologyEntry]) async throws -> J {
    let root = try copyProject(name)
    let workspace = work.appendingPathComponent("workspaces/\(name)-\(language.identifier)-\(host)-\(UUID().uuidString)", isDirectory: true)
    let client = ScriptedClient(plan: planByHash)
    let store = RecordingCheckpoints()
    let marker = "READPAPERLITERALPERCENTFIXTURE"
    let pipeline = LaTeXTranslationPipeline(
        preparer: LocalDirectoryProjectPreparer(),
        parser: host ? ReadPaperLiteralPercentPreservingLaTeXParser(marker: marker) : StructuredLaTeXParser(),
        translator: PromptingLaTeXTranslator(client: client, summarizer: PromptLaTeXDocumentSummarizer(client: client), checkpointStore: store),
        validator: StructuralLaTeXValidator(),
        reconstructor: StructuredLaTeXReconstructor(preamblePolicy: host ? ReadPaperLaTeXEngineCompatibilityPreamblePolicy() : ReferenceLanguagePreamblePolicy())
    )
    let configuration = TranslationConfiguration(
        sourceLanguage: .english, targetLanguage: language, maximumValidationRetries: 3, compilationPolicy: .sourceOnly,
        validationFailurePolicy: .continueWithIssues, maximumConcurrentTranslations: 1, previousContextUnitCount: 1,
        terminology: terminology, documentSummary: summary
    )
    final class Events: @unchecked Sendable { var values: [J] = [] }
    let events = Events()
    var result: [String: J] = ["name": .s(name), "language": .s(language.identifier), "host": .b(host), "documentSummary": opt(summary), "terminology": .a(terminology.map { .o(["source": .s($0.source), "target": .s($0.target)]) })]
    do {
        let artifact = try await pipeline.run(TranslationRequest(source: .localDirectory(root), workspaceDirectory: workspace, configuration: configuration)) { event in
            events.values.append(.o(["stage": .s(event.stage.rawValue), "completedUnitCount": opt(event.completedUnitCount), "totalUnitCount": opt(event.totalUnitCount), "detail": opt(event.detail)]))
        }
        if host {
            try ReadPaperLaTeXProjectCompatibilityNormalizer.normalizeProject(at: artifact.projectDirectory, literalPercentMarker: marker)
        }
        result["projectDirectory"] = .s(String(artifact.projectDirectory.resolvingSymlinksInPath().path.dropFirst(workspace.resolvingSymlinksInPath().path.count + 1)))
        result["units"] = .a(artifact.units.map(translatedJSON))
        result["validationIssues"] = .a(artifact.validationIssues.map(issueJSON))
        result["output"] = tree(artifact.projectDirectory)
        result["source"] = tree(root)
    } catch {
        result["error"] = errorJSON(error, root: root)
    }
    result["events"] = .a(events.values)
    result["calls"] = .a(await client.calls)
    result["checkpointOperations"] = .a(await store.operations)
    return .o(result)
}

var pipelines: [J] = []
for name in projectNames {
    pipelines.append(try await pipelineRun(name, language: .simplifiedChinese, host: false, summary: name == "basic" ? nil : "Configured abstract.", terminology: name == "basic" ? terminology : []))
}
for name in ["basic", "cjk-legacy", "ctex-existing", "pdftex-specific", "environments", "crlf-bom"] {
    pipelines.append(try await pipelineRun(name, language: .simplifiedChinese, host: true, summary: "Configured abstract.", terminology: []))
}
pipelines.append(try await pipelineRun("basic", language: .japanese, host: false, summary: "", terminology: []))
pipelines.append(try await pipelineRun("basic", language: .english, host: true, summary: nil, terminology: []))
output["pipelines"] = .a(pipelines)

// Archive readers and secure extraction.
var archiveResults: [J] = []
let archiveNames = try FileManager.default.contentsOfDirectory(atPath: fixtures.appendingPathComponent("archives").path).filter { !$0.hasPrefix(".") }.sorted()
for name in archiveNames {
    let url = fixtures.appendingPathComponent("archives/\(name)")
    var result: [String: J] = ["name": .s(name)]
    do {
        var entries: [J] = []
        for try await entry in try await AutomaticTranslationArchiveReader().entries(in: url) {
            entries.append(.o(["path": .s(entry.path), "kind": .s(entry.kind.rawValue), "uncompressedSize": .i(Int(entry.uncompressedSize)), "sha256": .s(sha256(entry.contents)), "size": .i(entry.contents.count)]))
        }
        result["entries"] = .a(entries)
    } catch {
        result["entriesError"] = errorJSON(error)
    }
    let workspace = work.appendingPathComponent("archives/\(UUID().uuidString)", isDirectory: true)
    do {
        let prepared = try await SecureArchiveProjectPreparer(reader: AutomaticTranslationArchiveReader()).prepare(TranslationRequest(source: .localArchive(url), workspaceDirectory: workspace))
        result["prepared"] = .o(["identifier": .s(prepared.identifier), "directory": .s(String(prepared.sourceDirectory.resolvingSymlinksInPath().path.dropFirst(workspace.resolvingSymlinksInPath().path.count + 1))), "files": tree(prepared.sourceDirectory)])
    } catch {
        result["preparedError"] = errorJSON(error)
        result["preparedLeftovers"] = tree(workspace)
    }
    archiveResults.append(.o(result))
}
output["archives"] = .a(archiveResults)

// read-paper host helpers.
let glossaries = ["", "unit => 单元\r\n  accuracy → 准确率 \r\rbad line\nx = y = z\nterm\tterm2\n=>\n a=>b=>c ", String(repeating: "长", count: 12_005)]
output["host"] = .o([
    "glossary": .a(glossaries.map { .o(["input": .s($0), "normalized": .s(TranslationGlossaryPreference.normalized($0)), "terminology": .a(ReadPaperLaTeXTerminology.entries(from: $0).map { .o(["source": .s($0.source), "target": .s($0.target)]) })]) }),
    "identifiers": .a([("2401.12345", nil), ("2401.12345", "v2"), ("2401.12345", "3"), ("2401.12345v1", "v2"), ("hep-th/9901001", " 4 "), ("2401.12345", "x"), (" 2401.12345 ", "")].map { pair in
        .o(["id": .s(pair.0), "version": opt(pair.1), "resolved": .s(ReadPaperArXivIdentifier.resolving(id: pair.0, version: pair.1))])
    }),
    "engine": .a(try projectNames.flatMap { name -> [J] in
        let root = fixtures.appendingPathComponent("projects/\(name)")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL }.filter { ["tex", "sty", "cls"].contains($0.pathExtension) } ?? []
        return try files.sorted { $0.path < $1.path }.compactMap { file in
            guard let source = try? String(contentsOf: file, encoding: .utf8) else { return nil }
            return .o([
                "source": .s(source),
                "normalized": .s(ReadPaperLaTeXEngineCompatibilityPreamblePolicy.normalizeEngineSpecificSource(source)),
                "minted": .s(ReadPaperLaTeXProjectCompatibilityNormalizer.replacingFrozenMintedCacheOption(in: source)),
                "percent": .s(ReadPaperLiteralPercentPreservingLaTeXParser.protectingLiteralPercents(in: source, marker: "MARK")),
                "policy": .s(try ReadPaperLaTeXEngineCompatibilityPreamblePolicy().transform(source, targetLanguage: .simplifiedChinese)),
            ])
        }
    } + [
        "\\providecommand{\\chinese}{}n\\renewcommand{\\chinese}[1]{#1}\n  \\pdfgentounicode=1\r\n\\pdfglyphtounicode{f_f}{FB00} % map\n\\usepackage [ frozencache , cachedir=x]{minted}\n\\RequirePackage[FrozenCache]{minted}\n\\begin{verbatim}%\\end{verbatim} \\begin {minted*}{c}% x\\end{minted*}",
    ].map { source in
        .o([
            "source": .s(source),
            "normalized": .s(ReadPaperLaTeXEngineCompatibilityPreamblePolicy.normalizeEngineSpecificSource(source)),
            "minted": .s(ReadPaperLaTeXProjectCompatibilityNormalizer.replacingFrozenMintedCacheOption(in: source)),
            "percent": .s(ReadPaperLiteralPercentPreservingLaTeXParser.protectingLiteralPercents(in: source, marker: "MARK")),
            "policy": .s(try ReadPaperLaTeXEngineCompatibilityPreamblePolicy().transform(source, targetLanguage: .simplifiedChinese)),
        ])
    }),
    "progress": .a([
        PipelineEvent(stage: .preparing), PipelineEvent(stage: .parsing),
        PipelineEvent(stage: .translating, completedUnitCount: 0, totalUnitCount: 12),
        PipelineEvent(stage: .translating, completedUnitCount: 12, totalUnitCount: 12),
        PipelineEvent(stage: .translating, completedUnitCount: 3, totalUnitCount: 0),
        PipelineEvent(stage: .validating, detail: "attempt 0"), PipelineEvent(stage: .reconstructing),
        PipelineEvent(stage: .compiling), PipelineEvent(stage: .finished),
    ].map { event in
        let update = ReadPaperLaTeXProgressMapper.update(for: event)
        return .o(["stage": .s(event.stage.rawValue), "completedUnitCount": opt(event.completedUnitCount), "totalUnitCount": opt(event.totalUnitCount), "fractionCompleted": .d(update.fractionCompleted)])
    }),
])

// Unicode property tables that Character's predicates use.
func ranges(_ test: (Unicode.Scalar) -> Bool) -> [UInt32] {
    var result: [UInt32] = []
    var start: UInt32?
    for value in UInt32(0)...0x10FFFF {
        let included = Unicode.Scalar(value).map(test) ?? false
        if included, start == nil { start = value }
        if !included, let first = start { result += [first, value - 1]; start = nil }
    }
    if let first = start { result += [first, 0x10FFFF] }
    return result
}
let unicode: [String: [UInt32]] = [
    "alphabetic": ranges { $0.properties.isAlphabetic },
    "numeric": ranges { $0.properties.numericType != nil },
    "whitespace": ranges { $0.properties.isWhitespace },
]
let compact = JSONEncoder()
compact.outputFormatting = [.sortedKeys]
try (String(data: try compact.encode(unicode), encoding: .utf8)! + "\n").write(to: resources.appendingPathComponent("unicode-properties.json"), atomically: true, encoding: .utf8)

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
try encoder.encode(J.o(output)).write(to: fixtures.appendingPathComponent("parity.json"))
print("Wrote \(fixtures.appendingPathComponent("parity.json").path)")

// MARK: Real arXiv sources

/// Hash of the compact, key-sorted JSON form of a value.
func digest(_ value: J) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return sha256(try! encoder.encode(value))
}

struct ArchiveAcquirer: ArXivProjectAcquiring {
    let archive: URL
    func acquireProject(identifier: String, workspaceDirectory: URL) async throws -> TranslationProjectSource { .localArchive(archive) }
}

/// Runs read-paper's composition (with a scripted model) over every distinct arXiv source
/// archive below the corpus folder and records a hash of each stage.
func corpusRun(_ archive: URL) async throws -> J {
    let identifier = archive.deletingPathExtension().lastPathComponent
    let workspace = work.appendingPathComponent("corpus/\(identifier)", isDirectory: true)
    let client = ScriptedClient(plan: planByHash)
    let store = RecordingCheckpoints()
    let marker = "READPAPERLITERALPERCENTFIXTURE"
    let pipeline = LaTeXTranslationPipeline(
        preparer: RoutedProjectPreparer(arXiv: ArXivProjectPreparer(acquirer: ArchiveAcquirer(archive: archive), archiveReader: AutomaticTranslationArchiveReader())),
        parser: ReadPaperLiteralPercentPreservingLaTeXParser(marker: marker),
        translator: PromptingLaTeXTranslator(client: client, summarizer: PromptLaTeXDocumentSummarizer(client: client), checkpointStore: store),
        validator: StructuralLaTeXValidator(),
        reconstructor: StructuredLaTeXReconstructor(preamblePolicy: ReadPaperLaTeXEngineCompatibilityPreamblePolicy())
    )
    let configuration = TranslationConfiguration(
        sourceLanguage: .english, targetLanguage: .simplifiedChinese, maximumValidationRetries: 3, compilationPolicy: .sourceOnly,
        validationFailurePolicy: .fail, maximumConcurrentTranslations: 1, previousContextUnitCount: 1,
        terminology: ReadPaperLaTeXTerminology.entries(from: "model => 模型\nlanguage model => 语言模型"), documentSummary: "Configured abstract."
    )
    var result: [String: J] = ["archive": .s(archive.lastPathComponent), "sha256": .s(sha256(try Data(contentsOf: archive)))]
    final class Events: @unchecked Sendable { var values: [J] = [] }
    let events = Events()
    do {
        let artifact = try await pipeline.run(TranslationRequest(source: .arxiv(identifier: identifier), workspaceDirectory: workspace, configuration: configuration)) { event in
            events.values.append(.o(["stage": .s(event.stage.rawValue), "completedUnitCount": opt(event.completedUnitCount), "totalUnitCount": opt(event.totalUnitCount), "detail": opt(event.detail)]))
        }
        try ReadPaperLaTeXProjectCompatibilityNormalizer.normalizeProject(at: artifact.projectDirectory, literalPercentMarker: marker)
        result["units"] = .s(digest(.a(artifact.units.map(translatedJSON))))
        result["unitCount"] = .i(artifact.units.count)
        result["issues"] = .s(digest(.a(artifact.validationIssues.map(issueJSON))))
        result["prepared"] = .s(digest(tree(workspace.appendingPathComponent("prepared/\(identifier)"))))
        result["output"] = .s(digest(tree(artifact.projectDirectory)))
    } catch {
        result["error"] = errorJSON(error)
    }
    let calls = await client.calls
    result["calls"] = .s(digest(.a(calls)))
    result["callCount"] = .i(calls.count)
    result["checkpoints"] = .s(digest(.a(await store.operations)))
    result["events"] = .s(digest(.a(events.values)))
    return .o(result)
}

if let corpusIndex = CommandLine.arguments.firstIndex(of: "--corpus"), corpusIndex + 1 < CommandLine.arguments.count {
    let corpus = URL(fileURLWithPath: CommandLine.arguments[corpusIndex + 1])
    var archives: [String: URL] = [:]
    let found = (FileManager.default.enumerator(at: corpus, includingPropertiesForKeys: nil)?.allObjects as? [URL]) ?? []
    for url in found {
        guard url.pathExtension == "tar", url.path.contains("/translations/latex/"), url.path.contains("/downloads/") else { continue }
        archives[url.lastPathComponent] = archives[url.lastPathComponent] ?? url
    }
    var runs: [J] = []
    for name in archives.keys.sorted() {
        runs.append(try await corpusRun(archives[name]!))
        print("Recorded \(name)")
    }
    try encoder.encode(J.a(runs)).write(to: fixtures.appendingPathComponent("corpus.json"))
    print("Wrote \(fixtures.appendingPathComponent("corpus.json").path)")
}
