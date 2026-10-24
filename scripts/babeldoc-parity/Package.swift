// swift-tools-version: 6.0
// Records the observable behavior of the Swift BabelDoc pipeline (reWriteBabelDoc)
// as parity fixtures for the TypeScript port in BabelDocKit. Run through
// `npm run sync:babeldoc -- --parity`; the reWriteBabelDoc checkout is only a
// local path dependency and is never modified.
import Foundation
import PackageDescription

let kitPath = Context.environment["BABELDOC_SWIFT"] ?? "../../../reWriteBabelDoc"
let kitIdentity = URL(fileURLWithPath: kitPath).lastPathComponent

let package = Package(
    name: "BabelDocParity",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: kitPath)],
    targets: [
        .executableTarget(
            name: "babeldoc-parity",
            dependencies: [.product(name: "BabelDocLayoutCore", package: kitIdentity)],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
