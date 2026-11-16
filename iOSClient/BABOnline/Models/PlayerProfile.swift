import Foundation

/// A profile's totals as the server stores them (`profile.stats` of profileResponse /
/// playerProfileResponse: users.stats, users.botStats or both summed, by scope). Every key is
/// optional on the wire (an account with no games has none): a missing one counts 0.
struct ProfileStats: Equatable {
    var gamesPlayed = 0.0
    var wins = 0.0
    var losses = 0.0
    var totalPoints = 0.0
    var totalTricksBid = 0.0
    var totalTricksTaken = 0.0
    var totalHands = 0.0
    var totalSets = 0.0
    var totalSetPoints = 0.0
    var totalFaults = 0.0
    var totalHSI = 0.0

    init() {}

    init(wire: Any?) {
        let dict = wire as? [String: Any] ?? [:]
        func n(_ key: String) -> Double { StatsWire.number(dict[key]) ?? 0 }
        gamesPlayed = n("gamesPlayed")
        wins = n("wins")
        losses = n("losses")
        totalPoints = n("totalPoints")
        totalTricksBid = n("totalTricksBid")
        totalTricksTaken = n("totalTricksTaken")
        totalHands = n("totalHands")
        totalSets = n("totalSets")
        totalSetPoints = n("totalSetPoints")
        totalFaults = n("totalFaults")
        totalHSI = n("totalHSI")
    }

    /// One cell of the grid.
    struct Cell: Equatable, Identifiable {
        let id: String
        let label: String
        let value: String
        /// What VoiceOver says for the label ("Points per game").
        let spokenLabel: String
    }

    /// The web's 3 x 4 grid (ProfilePage.js createStatsGrid): the same twelve cells, order,
    /// labels and number formats ("0" / "0%" where there is nothing to divide by).
    var cells: [Cell] {
        func fixed(_ v: Double, _ digits: Int) -> String { String(format: "%.\(digits)f", v) }
        func count(_ v: Double) -> String { String(Int(v.rounded())) }
        func per(_ total: Double, _ digits: Int = 1) -> String { gamesPlayed > 0 ? fixed(total / gamesPlayed, digits) : "0" }
        let winRate = gamesPlayed > 0 ? fixed(wins / gamesPlayed * 100, 1) + "%" : "0%"
        let tricksPerBid = totalTricksBid > 0 ? fixed(totalTricksTaken / totalTricksBid, 2) : "0"
        let setRate = totalHands > 0 ? fixed(totalSets / totalHands * 100, 1) + "%" : "0%"
        let hsi = totalHands > 0 ? fixed(totalHSI / totalHands, 1) : "0"
        return [
            Cell(id: "gamesPlayed", label: "Games Played", value: count(gamesPlayed), spokenLabel: "Games played"),
            Cell(id: "wins", label: "Wins", value: count(wins), spokenLabel: "Wins"),
            Cell(id: "losses", label: "Losses", value: count(losses), spokenLabel: "Losses"),
            Cell(id: "winRate", label: "Win Rate", value: winRate, spokenLabel: "Win rate"),
            Cell(id: "pointsPerGame", label: "Points/Game", value: per(totalPoints), spokenLabel: "Points per game"),
            Cell(id: "bidsPerGame", label: "Bids/Game", value: per(totalTricksBid), spokenLabel: "Bids per game"),
            Cell(id: "tricksPerGame", label: "Tricks/Game", value: per(totalTricksTaken), spokenLabel: "Tricks per game"),
            Cell(id: "tricksPerBid", label: "Tricks/Bid", value: tricksPerBid, spokenLabel: "Tricks per bid"),
            Cell(id: "setRate", label: "Set Rate", value: setRate, spokenLabel: "Set rate"),
            Cell(id: "drag", label: "Drag", value: per(totalSetPoints), spokenLabel: "Drag"),
            Cell(id: "faultsPerGame", label: "Faults/Game", value: per(totalFaults, 2), spokenLabel: "Faults per game"),
            Cell(id: "hsi", label: "HSI", value: hsi, spokenLabel: "Hand strength index"),
        ]
    }
}

/// A profile reply's player: the name, the picture and the stats of the scope asked for.
struct PlayerProfile: Equatable {
    let username: String
    /// The stock picture (1...82): what shows when there is no custom picture.
    let profilePic: Int
    /// The custom picture's versioned path (`/avatar/<name>?v=<version>`, the reply's `avatarUrl`).
    let avatarPath: String?
    let stats: ProfileStats

    /// The key the avatar caches load (AvatarImageView): the custom picture, else the stock one.
    var pictureKey: String { avatarPath ?? String(profilePic) }

    /// A successful profileResponse / playerProfileResponse; nil for a failure or a reply
    /// without a named profile.
    static func from(response dict: [String: Any]) -> PlayerProfile? {
        guard dict["success"] as? Bool == true, let profile = dict["profile"] as? [String: Any],
              let username = StatsWire.string(profile["username"]) else { return nil }
        let url = StatsWire.string(dict["avatarUrl"]).flatMap { HTTPAvatarLoader.isAvatarPath($0) ? $0 : nil }
        return PlayerProfile(username: username, profilePic: ProfilePicture.stock(StatsWire.int(profile["profilePic"])),
                             avatarPath: url, stats: ProfileStats(wire: profile["stats"]))
    }
}

extension StatsScope {
    /// Under a Bot games grid with no games (the web's BOT_STATS_EMPTY_NOTE).
    static let botStatsEmptyNote = "No bot games recorded yet. Games with bots count toward stats from now on."

    /// The profile requests always name the scope (human included), so every success echoes it.
    var profilePayload: [String: Any] { ["scope": rawValue] }
}
