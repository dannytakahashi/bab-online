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

    init(username: String, message: String, type: MessageType = .player, position: Int? = nil) {
        self.id = UUID()
        self.username = username
        self.message = message
        self.timestamp = Date()
        self.type = type
        self.position = position
    }

    static func from(_ dict: [String: Any]) -> ChatMessage? {
        let username = dict["username"] as? String ?? "System"
        let message = dict["message"] as? String ?? ""
        let typeStr = dict["type"] as? String ?? "player"
        let type = MessageType(rawValue: typeStr) ?? .player
        let position = dict["position"] as? Int
        return ChatMessage(username: username, message: message, type: type, position: position)
    }
}
