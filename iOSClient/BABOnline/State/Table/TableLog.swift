import Foundation
import os

/// The table's release-build log (Console / sysdiagnose): only event names, coding paths and
/// enum values (DecodeTrace), never payload values, names or chat.
enum TableLog {
    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "BABOnline", category: "table")

    static func decodeFailed(_ error: WireError) {
        switch error {
        case .unknownEvent(let name):
            logger.error("unknown event \(name, privacy: .public)")
        case .missingPayload(let name):
            logger.error("\(name, privacy: .public): no payload")
        case .decode(let name, let message):
            logger.error("\(name, privacy: .public) undecodable: \(message, privacy: .public); resyncing")
        case .snapshot(let name, let requestId, let problem):
            logger.error("\(name, privacy: .public) snapshot not shown (\(requestId ?? "-", privacy: .public)): \(problem.summary, privacy: .public)")
        }
    }

    static func unreadable(failures: Int) {
        logger.fault("table unreadable after \(failures, privacy: .public) snapshots; showing the update message")
    }
}
