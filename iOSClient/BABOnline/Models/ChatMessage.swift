import Foundation

struct ChatMessage: Identifiable, Equatable {
    let id: UUID
    let username: String
    let message: String
    let timestamp: Date
    var type: MessageType
    var position: Int?

    enum MessageType: String, Equatable {
        case player
        case system
        case spectator
    }

    /// `timestamp`: when the server sent the line (its `timestamp` / `at`); a live
    /// game line has none and is stamped when it arrives.
    init(username: String, message: String, type: MessageType = .player, position: Int? = nil, timestamp: Date = Date()) {
        self.id = UUID()
        self.username = username
        self.message = message
        self.timestamp = timestamp
        self.type = type
        self.position = position
    }

    static func from(_ dict: [String: Any]) -> ChatMessage? {
        let username = dict["username"] as? String ?? "System"
        let message = dict["message"] as? String ?? ""
        let typeStr = dict["type"] as? String ?? "player"
        var type = MessageType(rawValue: typeStr) ?? .player
        // Tournament messages use isSpectator boolean instead of type string
        if dict["isSpectator"] as? Bool == true {
            type = .spectator
        }
        let position = dict["position"] as? Int
        let sent = serverDate(dict["timestamp"]) ?? serverDate(dict["at"]) ?? Date()
        return ChatMessage(username: username, message: message, type: type, position: position, timestamp: sent)
    }

    /// A server time: epoch milliseconds (Date.now(), as every chat line and the
    /// snapshot log's `at` send it) as a number or numeric string; an ISO 8601
    /// string; a value that small is taken as seconds. nil for anything else.
    static func serverDate(_ value: Any?) -> Date? {
        let number: Double?
        switch value {
        case let n as NSNumber where CFGetTypeID(n) != CFBooleanGetTypeID(): number = n.doubleValue
        case let i as Int: number = Double(i)
        case let d as Double: number = d
        case let s as String:
            if let d = Double(s) { number = d } else {
                let iso = ISO8601DateFormatter()
                iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let date = iso.date(from: s) { return date }
                iso.formatOptions = [.withInternetDateTime]
                return iso.date(from: s)
            }
        default: number = nil
        }
        guard let n = number, n.isFinite, n > 0 else { return nil }
        return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n)
    }
}
