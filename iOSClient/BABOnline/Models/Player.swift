import Foundation

/// Decode a profile pic from a server payload. Pics are usually numbers (1-82),
/// or a String for custom (base64) pics. `NSNumber as? String` is nil, so a
/// plain `as? String` silently drops every numeric pic.
func picString(from value: Any?) -> String? {
    if let s = value as? String { return s }
    if let n = value as? Int { return String(n) }
    return nil
}

struct Player: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var position: Int?
    var pic: String?
    var isReady: Bool = false
    var isBot: Bool = false
    var isDisconnected: Bool = false
}
