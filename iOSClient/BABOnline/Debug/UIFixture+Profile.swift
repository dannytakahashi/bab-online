#if DEBUG
import SwiftUI

/// Profiles in fixture mode (no socket): ProfileState's requests are answered here, 0.4 s
/// later, with wire-shaped replies that go through the same decoding as the server's.
/// `-uiProfile` picks the answers: `ok` (the default), `error` (Database error for the stats
/// and the picture changes), `silent` (never answers: the timeouts, shortened to 3 s).
/// My own stats: human games and all games have numbers, bot games none (the empty note).
/// Another player's: numbers made from the name; a name starting with the bot mark, "Mary"
/// (the game lobby's bot) and "ghost" answer "Player not found"; kim has a custom picture.
/// Block / unblock / report are answered as the server does (blockListUpdated,
/// reportUserResponse) and, like the picture changes, show in "fixture.sent".
/// `-uiPickPhoto YES`: Upload Photo skips the system picker and sends a generated photo
/// through the same crop and encoding. `UI_FIXTURE_AVATARS=<client/assets>` (environment):
/// stock avatars load from that folder (screenshots; otherwise every avatar is its initial).
extension UIFixture {
    static let profileMode: String = UserDefaults.standard.string(forKey: "uiProfile") ?? "ok"
    static let picksSamplePhoto: Bool = UserDefaults.standard.bool(forKey: "uiPickPhoto")
    static let avatarFolder: String? = ProcessInfo.processInfo.environment["UI_FIXTURE_AVATARS"]

    private static weak var fixtureSafety: SafetyState?

    static func seedProfile(_ profile: ProfileState, safety: SafetyState) {
        guard isActive else { return }
        fixtureSafety = safety
        if profileMode == "silent" { profile.timeout = 3 }
        func answer(_ apply: @escaping (ProfileState) -> Void) {
            guard profileMode != "silent" else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak profile] in profile.map(apply) }
        }
        let failure: [String: Any] = ["success": false, "message": "Database error"]
        profile.sendOwn = { [weak profile] scope in
            let name = profile?.ownUsername ?? "ivy"
            answer { $0.applyOwn(response: profileMode == "error" ? failure
                : profileReply(name, pic: 31, stats: ownStats(scope), scope: scope, badges: badgesFixture(for: name, own: true))) }
        }
        profile.sendPlayer = { name, scope in
            let unknown = name.hasPrefix("🤖") || name == "Mary" || name == "ghost"
            let reply: [String: Any] = profileMode == "error" ? failure
                : unknown ? ["success": false, "message": "Player not found"]
                : profileReply(name, pic: 1 + abs(seed(name)) % ProfilePicture.stockCount, stats: playerStats(name, scope), scope: scope,
                               avatarUrl: name == "kim" ? "/avatar/kim?v=3" : nil, badges: badgesFixture(for: name, own: false))
            answer { $0.applyPlayer(response: reply) }
        }
        profile.sendStockPic = { n in
            note("updateProfilePic:\(n)")
            answer { $0.applyStockPic(response: profileMode == "error" ? failure : ["success": true, "profilePic": n]) }
        }
        profile.sendUpload = { [weak profile] url in
            note("uploadProfilePic:\(url.hasPrefix("data:image/png;base64,") ? "png" : "?"):\(url.count)")
            let name = profile?.ownUsername ?? "ivy"
            answer {
                $0.applyUpload(response: profileMode == "error"
                    ? ["success": false, "message": "Could not read that image. Please try a PNG, JPEG, GIF or WebP."]
                    : ["success": true, "customProfilePic": url, "avatarUrl": "/avatar/\(name)?v=00000000000000aa"])
            }
        }
    }

    /// recordSent: the safety emits, answered as the server answers them; the probe's entry.
    static func profileSent(_ event: String, _ data: [String: Any]) -> String {
        let name = data["username"] as? String ?? "-"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            guard let safety = fixtureSafety else { return }
            switch event {
            case SocketEvents.Client.blockUser:
                safety.setBlockedUsers(Array(safety.blockedUsers.union([name])))
                safety.feedbackMessage = "Block list updated."
            case SocketEvents.Client.unblockUser:
                safety.setBlockedUsers(Array(safety.blockedUsers.subtracting([name])))
                safety.feedbackMessage = "Block list updated."
            default:
                safety.feedbackMessage = "Report submitted. Thank you."
            }
        }
        return "\(event):\(name)"
    }

    private static func note(_ message: String) {
        DispatchQueue.main.async {
            let probe = TableDebugProbe.shared
            probe.sent = probe.sent == "-" ? message : probe.sent + "|" + message
        }
    }

    private static func seed(_ name: String) -> Int {
        name.unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) % 100_003 }
    }

    private static func profileReply(_ name: String, pic: Int, stats: [String: Any], scope: StatsScope, avatarUrl: String? = nil,
                                     badges: [[String: Any]]? = nil) -> [String: Any] {
        var profile: [String: Any] = ["username": name, "profilePic": pic, "customProfilePic": NSNull(), "stats": stats]
        // the tournament history (iOS 1.2.7), the same in every scope
        for (key, value) in tournamentsFixture(for: name) { profile[key] = value }
        var reply: [String: Any] = ["success": true, "scope": scope.rawValue, "profile": profile]
        if let avatarUrl { reply["avatarUrl"] = avatarUrl }
        if let badges { reply["badges"] = badges }
        return reply
    }

    /// `-uiTournaments`: `ok` (the default; ivy, me, 6 played, 2 won, Cut for a buck 2 of 3 and five
    /// recent results: a tie, a cut won, another's cut, a place and a '[deleted]' winner; kim 3
    /// played, 1 won, 1 of 1, two results with a long name; hal one tournament before Cut for a buck (no cut, no cut stat);
    /// everyone else nothing: zeros, so no section), `absent` (no keys: a server from before the
    /// history) or `empty` (zeros for everyone). As profileHandlers.tournamentProfile sends it.
    static let tournamentsMode: String = UserDefaults.standard.string(forKey: "uiTournaments") ?? "ok"

    static func tournamentsFixture(for name: String) -> [String: Any] {
        if tournamentsMode == "absent" { return [:] }
        func r(_ id: String, _ t: String, _ day: Int, rounds: Int, players: Int, place: Int?, won: Bool, winners: [String],
               cut: String?) -> [String: Any] {
            ["id": id, "name": t, "completedAt": String(format: "2026-11-%02dT21:15:00.000Z", day), "totalRounds": rounds,
             "players": players, "place": place.map { $0 as Any } ?? NSNull(), "won": won, "winners": winners,
             "cutWinner": cut.map { $0 as Any } ?? NSNull()]
        }
        func reply(_ played: Int, _ won: Int, _ cutWins: Int, _ cutPlayed: Int, _ recent: [[String: Any]]) -> [String: Any] {
            ["tournaments": ["played": played, "won": won, "recent": recent] as [String: Any],
             "cutForABuck": ["wins": cutWins, "played": cutPlayed]]
        }
        let none = reply(0, 0, 0, 0, [])
        guard tournamentsMode == "ok" else { return none }
        switch name {
        case "ivy":
            return reply(6, 2, 2, 3, [
                r("t6", "Sunday Cup", 24, rounds: 3, players: 6, place: 1, won: true, winners: ["ivy", "kim"], cut: "ivy"),
                r("t5", "Friday Night Lights", 21, rounds: 4, players: 8, place: 2, won: false, winners: ["hal"], cut: "kim"),
                r("t4", "Bores Only", 18, rounds: 1, players: 4, place: 1, won: true, winners: ["ivy"], cut: "ivy"),
                r("t3", "Sunday Cup", 14, rounds: 5, players: 12, place: 7, won: false, winners: ["[deleted]"], cut: nil),
                r("t2", "Practice", 9, rounds: 2, players: 3, place: nil, won: false, winners: ["ora"], cut: nil),
            ])
        case "kim":
            return reply(3, 1, 1, 1, [
                r("t5", "Friday Night Lights", 21, rounds: 4, players: 8, place: 3, won: false, winners: ["hal"], cut: "kim"),
                r("k1", "The Extremely Long Tournament Name For Testing", 12, rounds: 4, players: 5, place: 1, won: true,
                  winners: ["kim"], cut: nil),
            ])
        case "hal":
            return reply(1, 1, 0, 0, [r("h1", "Tuesday League", 11, rounds: 4, players: 4, place: 1, won: true, winners: ["hal"], cut: nil)])
        default:
            return none
        }
    }

    /// `-uiBadges`: `ok` (the default; my profile has three earned badges, kim seven, everyone
    /// else none: `badges: []`, as the server sends it to a socket with the cap), `absent` (no
    /// `badges` key at all: a server without badges) or `unknown` (mine adds an id this build
    /// has no art for and a malformed entry, which is dropped). The server's shape: {id, name,
    /// description, at}, oldest first.
    static let badgesMode: String = UserDefaults.standard.string(forKey: "uiBadges") ?? "ok"

    static func badgesFixture(for name: String, own: Bool) -> [[String: Any]]? {
        if badgesMode == "absent" { return nil }
        func b(_ id: String, _ name: String, _ description: String) -> [String: Any] {
            ["id": id, "name": name, "description": description, "at": "2026-11-20T18:30:00.000Z"]
        }
        if own {
            var mine = [b("felted", "Felted", "Ended a game with a negative score."),
                        b("hammer-time", "Hammer Time", "Held the HI joker 5 times in a game."),
                        b("century", "Century", "Played 100 human games.")]
            if badgesMode == "unknown" {
                mine.append(b("brand-new-badge", "Brand New", "A badge this build has no art for."))
                mine.append(["id": "Not An Id", "name": "Dropped", "description": "A malformed id."])
            }
            return mine
        }
        guard name == "kim" else { return [] }
        return [b("five-hundred", "500", "Scored 500 points in a game."),
                b("comeback-kid", "Comeback Kid", "Won a game after trailing by more than 100 points."),
                b("hurt-people-mode", "Hurt People Mode", "Set the opponents 5 or more times in a game."),
                b("double-rainbow", "Double Rainbow", "Had a rainbow in the same hand as your partner."),
                b("go-big-or-go-home", "Go Big or Go Home", "Bid 6 or more on a single hand."),
                b("spectator", "Spectator", "Bid zero five times in a row."),
                b("chemistry", "Chemistry", "Played 20 games with the same partner.")]
    }

    /// `-uiBadgesAwarded YES|many` (any fixture; for the score screen, `game-end`): 1.5 s after
    /// launch s2c badgesAwarded arrives as the server sends it after the game's stats, through
    /// the same decoding: YES = two awards one after the other (Felted and Hurt People Mode,
    /// then Century), queued; `many` = one award of five badges (four pictures, five names).
    /// The toast stays up 60 s (a tap dismisses it); the toast layer needs a signed-in user.
    static func seedBadgeAwards(auth: AuthState) {
        guard isActive, let mode = UserDefaults.standard.string(forKey: "uiBadgesAwarded") else { return }
        auth.isAuthenticated = true
        BadgeAwards.visibleSeconds = 60
        func b(_ id: String, _ name: String, _ description: String) -> [String: Any] {
            ["id": id, "name": name, "description": description]
        }
        let first: [[String: Any]] = mode == "many"
            ? [b("felted", "Felted", "Ended a game with a negative score."),
               b("hurt-people-mode", "Hurt People Mode", "Set the opponents 5 or more times in a game."),
               b("in-the-red", "In the Red", "Had a score below -99 during a game."),
               b("choke-artist", "Choke Artist", "Lost a game after leading by 100 points."),
               b("exact-tie", "Exact Tie", "Ended a game in a tie.")]
            : [b("felted", "Felted", "Ended a game with a negative score."),
               b("hurt-people-mode", "Hurt People Mode", "Set the opponents 5 or more times in a game.")]
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            BadgeAwards.shared.receive(["gameId": "fixture-game", "badges": first])
            guard mode != "many" else { return }
            BadgeAwards.shared.receive(["gameId": "fixture-game", "badges": [b("century", "Century", "Played 100 human games.")]])
        }
    }

    private static func stats(games: Int, wins: Int) -> [String: Any] {
        ["gamesPlayed": games, "wins": wins, "losses": games - wins, "totalPoints": games * 231, "totalTricksBid": games * 25 / 2,
         "totalTricksTaken": games * 51 / 4, "totalHands": games * 13, "totalSets": games * 3 / 2, "totalSetPoints": games * 60,
         "totalFaults": games / 5, "totalHSI": Double(games * 13) * 8.1]
    }

    /// users.stats as the server sends it; bot games: an account with none (no keys at all).
    static func ownStats(_ scope: StatsScope) -> [String: Any] {
        switch scope {
        case .human: return stats(games: 51, wins: 30)
        case .bots: return [:]
        case .all: return stats(games: 51, wins: 30)
        }
    }

    static func playerStats(_ name: String, _ scope: StatsScope) -> [String: Any] {
        let games = 10 + seed(name) % 40
        switch scope {
        case .human: return stats(games: games, wins: games * 3 / 5)
        case .bots: return stats(games: 4, wins: 3)
        case .all: return stats(games: games + 4, wins: games * 3 / 5 + 3)
        }
    }

    /// A 600 x 400 photo (a gradient with a disc off centre), as a JPEG file's bytes.
    static func samplePhotoData() -> Data {
        let size = CGSize(width: 600, height: 400)
        let image = BitmapRenderer.image(pixelSize: size, standardRange: false) { gc in
            let colors = [PlatformColor.systemTeal.cgColor, PlatformColor.systemIndigo.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                gc.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            PlatformColor.systemYellow.setFill()
            PlatformBezierPath(ovalIn: CGRect(x: 230, y: 120, width: 160, height: 160)).fill()
        }
        return image.jpegData(compressionQuality: 0.9) ?? Data()
    }
}
#endif
