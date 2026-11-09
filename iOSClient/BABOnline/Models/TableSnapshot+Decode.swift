import Foundation

enum SnapshotDecodeError: Error, Equatable {
    case notAnObject
    case unsupportedVersion(Int?)
}

extension TableSnapshot {
    /// Decode a snapshot from a Socket.IO payload value (`[String: Any]` built by
    /// JSONSerialization) by re-serializing it and running JSONDecoder.
    /// `strict` makes unknown enum values throw (XCTest); in production they
    /// decode as `.unknown`.
    static func decode(_ any: Any, strict: Bool = false) throws -> TableSnapshot {
        guard let dict = any as? [String: Any], JSONSerialization.isValidJSONObject(dict) else {
            throw SnapshotDecodeError.notAnObject
        }
        let version = (dict["v"] as? NSNumber)?.intValue
        guard version == 2 else { throw SnapshotDecodeError.unsupportedVersion(version) }
        let data = try JSONSerialization.data(withJSONObject: dict)
        return try decode(data: data, strict: strict)
    }

    static func decode(data: Data, strict: Bool = false) throws -> TableSnapshot {
        let decoder = JSONDecoder()
        if strict { decoder.userInfo[.contractStrict] = true }
        return try decoder.decode(TableSnapshot.self, from: data)
    }
}
