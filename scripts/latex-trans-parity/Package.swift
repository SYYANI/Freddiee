// swift-tools-version: 6.0
// Records the observable behavior of the Swift LaTeXTransKit as parity fixtures for the
// TypeScript port. Run it through `npm run sync:latex -- /path/to/arxivLatex`.
import Foundation
import PackageDescription

let kitPath = Context.environment["LATEXTRANS_SWIFT"] ?? "../../../arxivLatex"
let kitIdentity = URL(fileURLWithPath: kitPath).lastPathComponent

let package = Package(
    name: "LaTeXTransParity",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: kitPath)],
    targets: [
        .executableTarget(
            name: "latextrans-parity",
            dependencies: [.product(name: "LaTeXTransKit", package: kitIdentity)],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
