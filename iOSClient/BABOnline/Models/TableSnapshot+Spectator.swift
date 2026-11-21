import Foundation

/// A spectator entry (snapshot `watching.spectators[]`, spectatorsUpdated `spectators[]`),
/// decoded as the generated synthesis did, except `shoulder` (2026-11-21, the
/// over-the-shoulder view: the seat this watcher looks over the shoulder of, sent only to
/// a socket with the cap shoulderView): leniently, so a `shoulder` this build cannot read
/// is no shoulder and never costs the whole list or snapshot. Strict decoding (the contract
/// fixture tests) still throws on a mistyped one. The seat's range (1...4) is WatchingList's.
extension TableSnapshot.Spectator {
    private enum Keys: String, CodingKey { case username, pic, avatarUrl, shoulder }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        username = try c.decode(String.self, forKey: .username)
        pic = try c.decodeIfPresent(Int.self, forKey: .pic)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        if decoder.userInfo[.contractStrict] as? Bool == true {
            shoulder = try c.decodeIfPresent(Int.self, forKey: .shoulder)
        } else {
            shoulder = (try? c.decodeIfPresent(Int.self, forKey: .shoulder)) ?? nil
        }
    }
}
