#if DEBUG
import UIKit

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
    static let picksSamplePhoto: Bool = isActive && UserDefaults.standard.bool(forKey: "uiPickPhoto")
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
            answer { $0.applyOwn(response: profileMode == "error" ? failure : profileReply(name, pic: 31, stats: ownStats(scope), scope: scope)) }
        }
        profile.sendPlayer = { name, scope in
            let unknown = name.hasPrefix("🤖") || name == "Mary" || name == "ghost"
            let reply: [String: Any] = profileMode == "error" ? failure
                : unknown ? ["success": false, "message": "Player not found"]
                : profileReply(name, pic: 1 + abs(seed(name)) % ProfilePicture.stockCount, stats: playerStats(name, scope), scope: scope,
                               avatarUrl: name == "kim" ? "/avatar/kim?v=3" : nil)
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

    private static func profileReply(_ name: String, pic: Int, stats: [String: Any], scope: StatsScope, avatarUrl: String? = nil) -> [String: Any] {
        var reply: [String: Any] = [
            "success": true, "scope": scope.rawValue,
            "profile": ["username": name, "profilePic": pic, "customProfilePic": NSNull(), "stats": stats] as [String: Any],
        ]
        if let avatarUrl { reply["avatarUrl"] = avatarUrl }
        return reply
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
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let colors = [UIColor.systemTeal.cgColor, UIColor.systemIndigo.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                ctx.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            UIColor.systemYellow.setFill()
            UIBezierPath(ovalIn: CGRect(x: 230, y: 120, width: 160, height: 160)).fill()
        }
        return image.jpegData(compressionQuality: 0.9) ?? Data()
    }
}
#endif
