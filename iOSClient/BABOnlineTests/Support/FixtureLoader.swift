import Foundation
import XCTest
@testable import BAB_Online

/// Test fixtures: the contract snapshot fixtures (folder reference `v2/`) and
/// the recorded event logs (BABOnlineTests/Fixtures/events, flattened).
enum FixtureLoader {
    private final class Token {}
    static var bundle: Bundle { Bundle(for: Token.self) }

    /// Names of every contract v2 fixture (from v2/index.json).
    static func v2Names() throws -> [String] {
        let index = try json(url: try XCTUnwrap(bundle.url(forResource: "index", withExtension: "json", subdirectory: "v2"))) as? [String: Any]
        let list = try XCTUnwrap(index?["fixtures"] as? [[String: Any]])
        return list.compactMap { $0["name"] as? String }
    }

    /// The whole fixture file `{name, description, capturedFrom, viewerRole, snapshot}`.
    static func v2(_ name: String) throws -> [String: Any] {
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json", subdirectory: "v2"), "missing v2/\(name).json")
        return try XCTUnwrap(try json(url: url) as? [String: Any])
    }

    /// The fixture's snapshot as the JSONSerialization value a socket delivers.
    static func v2Snapshot(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try v2(name)["snapshot"] as? [String: Any])
    }

    /// A recorded event log (`npm run ios:fixtures`).
    static func eventLog(_ name: String) throws -> [String: Any] {
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json"), "missing \(name).json (npm run ios:fixtures)")
        return try XCTUnwrap(try json(url: url) as? [String: Any])
    }

    static let eventLogNames = ["events-bots-s12", "events-bots-s14", "events-humans-s13"]

    static func json(url: URL) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(contentsOf: url), options: [.fragmentsAllowed])
    }
}
