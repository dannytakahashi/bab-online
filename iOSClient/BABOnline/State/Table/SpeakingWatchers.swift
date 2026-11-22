import Foundation

/// Which spectators are talking now (voice, family lobbies: every voice spectator may talk,
/// docs/claude/voice.md "Spectator voice"). A seated player talking lights their seat (the
/// scene's speaking glow, TableRenderModel.seat(forVoicePeer:)) and my own talking is my mic's
/// ring, so neither ever counts here: what is left is a voice member with no seat, a spectator,
/// and the spectator badge (the eye) wears the green outline while one talks
/// (SpectatorBadgeView; the web's SpectatorBadge.setSpeaking).
///
/// The match, per talking voice peer (VoiceChatManager.speakingPeers, by socket id; the peer's
/// username from voicePeerList / voiceOffer):
/// - "self" (my own level) and a peer named as I am never count;
/// - a peer that is a seat's owner or the name a seat shows, or whose socket id is a seat's
///   (positionUpdate), is that seat's, never the eye's; so is a human entrant before seating;
/// - a named peer counts when the spectator list (`watching`) names it; one the list does not
///   name counts only while the list is cut short (more watchers than names: the server sends
///   at most 50), so a watcher who left (its call may end a moment after the list drops it)
///   stops lighting the eye at once;
/// - a peer with no username that is not at a seat is a voice member with no seat, a spectator:
///   it counts, unnamed.
struct SpeakingWatchers: Equatable {
    /// The talking spectators' usernames, in the spectator list's order (then any the list
    /// does not show).
    var names: [String] = []
    /// Talking voice peers with no username that are not at a seat.
    var unnamed = 0

    static let none = SpeakingWatchers()

    /// The eye wears the speaking outline.
    var isLit: Bool { !names.isEmpty || unnamed > 0 }
    var count: Int { names.count + unnamed }

    func isTalking(_ username: String) -> Bool { names.contains(username) }

    /// The badge's VoiceOver value: "Bo is talking", "Bo and Cy are talking", "3 spectators are
    /// talking" past two; "" while nobody watching talks (VoiceOver then reads no value).
    var accessibilityValue: String {
        switch (count, names.count) {
        case (0, _): return ""
        case (1, 1): return "\(names[0]) is talking"
        case (1, _): return "A spectator is talking"
        case (2, 2): return "\(names[0]) and \(names[1]) are talking"
        case (2, 1): return "\(names[0]) and a spectator are talking"
        default: return "\(count) spectators are talking"
        }
    }

    /// The talking spectators among `speaking` (voice socket ids; "self" is mine).
    static func select(speaking: Set<String>, username peerName: (String) -> String?,
                       players: PlayersSlice, me: String?) -> SpeakingWatchers {
        guard !speaking.isEmpty else { return .none }
        var seatNames = Set<String>()
        for seat in players.seats.values {
            if let n = seat.ownerUsername, !n.isEmpty { seatNames.insert(n) }
            if let n = seat.username, !n.isEmpty { seatNames.insert(n) }
        }
        for n in players.entrantHumans ?? [] where !n.isEmpty { seatNames.insert(n) }
        let seatSockets = Set(players.socketBySeat.values)
        let listed = players.watching.spectators.map(\.username)
        let listCut = players.watching.count > listed.count

        var talking = Set<String>()
        var unnamed = 0
        for id in speaking where id != "self" && !seatSockets.contains(id) {
            guard let name = peerName(id), !name.isEmpty else {
                unnamed += 1
                continue
            }
            if name == me || seatNames.contains(name) { continue }
            if listed.contains(name) || listCut { talking.insert(name) }
        }
        let ordered = listed.filter { talking.contains($0) } + talking.subtracting(listed).sorted()
        return SpeakingWatchers(names: ordered, unnamed: unnamed)
    }
}
