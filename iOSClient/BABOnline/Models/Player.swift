import Foundation

struct Player: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var position: Int?
    var pic: String?
    var isReady: Bool = false
    var isBot: Bool = false
    var isDisconnected: Bool = false
}
