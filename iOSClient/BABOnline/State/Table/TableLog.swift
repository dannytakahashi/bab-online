import Foundation
import os

/// The table's release-build log (Console / sysdiagnose): only event names, coding paths and
/// enum values (DecodeTrace), never payload values, names or chat. The same text goes to the
/// server once per kind per launch (ErrorReporter, c2s clientError).
enum TableLog {
    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "BABOnline", category: "table")

    static func decodeFailed(_ error: WireError, reporter: ErrorReporter = .shared) {
        switch error {
        case .unknownEvent(let name):
            logger.error("unknown event \(name, privacy: .public)")
            reporter.report(kind: "decode", message: "unknown event \(name)", location: name)
        case .missingPayload(let name):
            logger.error("\(name, privacy: .public): no payload")
            reporter.report(kind: "decode", message: "\(name): no payload", location: name)
        case .decode(let name, let message):
            logger.error("\(name, privacy: .public) undecodable: \(message, privacy: .public); resyncing")
            reporter.report(kind: "decode", message: "\(name) undecodable: \(message)", location: name)
        case .snapshot(let name, let requestId, let problem):
            logger.error("\(name, privacy: .public) snapshot not shown (\(requestId ?? "-", privacy: .public)): \(problem.summary, privacy: .public)")
            // its own kind: the unreadable-snapshot path (UnreadableSnapshotTests) is the one to hear about
            reporter.report(kind: "snapshot", message: "\(name) snapshot not shown: \(problem.summary)", location: name)
        }
    }

    static func unreadable(failures: Int, reporter: ErrorReporter = .shared) {
        logger.fault("table unreadable after \(failures, privacy: .public) snapshots; showing the update message")
        reporter.report(kind: "unreadable", message: "table unreadable after \(failures) snapshots")
    }
}
