import Foundation

struct ChatMessage: Identifiable, Equatable {
    let id: UUID
    let username: String
    let message: String
    let timestamp: Date
    var type: MessageType

    enum MessageType: String, Equatable {
        case player
        case system
        case spectator
    }

    init(username: String, message: String, type: MessageType = .player) {
        self.id = UUID()
        self.username = username
        self.message = message
        self.timestamp = Date()
        self.type = type
    }

    static func from(_ dict: [String: Any]) -> ChatMessage? {
        let username = dict["username"] as? String ?? "System"
        let message = dict["message"] as? String ?? ""
        let typeStr = dict["type"] as? String ?? "player"
        let type = MessageType(rawValue: typeStr) ?? .player
        return ChatMessage(username: username, message: message, type: type)
    }
}
