import Foundation
import Testing
@testable import Signaller

/// Loads captured API responses from the test bundle.
///
/// `Bundle.module` is SwiftPM-only; an Xcode unit-test bundle is found via a
/// type inside it. The JSON is real output from a running backend, so these
/// catch server shape drift at build time.
enum Fixtures {
    private final class BundleToken {}

    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        let url = try #require(
            bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
                ?? bundle.url(forResource: name, withExtension: "json"),
            "fixture \(name).json is missing from the test bundle"
        )
        return try Data(contentsOf: url)
    }

    static func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try JSONDecoder.signaller.decode(type, from: data(name))
    }
}
