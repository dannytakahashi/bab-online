import Foundation
import Combine

/// Draw result for draw phase
struct DrawResult: Equatable {
    let username: String
    let position: Int
    let cardIndex: Int
}

/// Game phases
enum GamePhase: String {
    case none, lobby, draw, bidding, playing, ended
}

/// Core game state — mirrors the web client's GameState.js
final class GameState: ObservableObject {

    // MARK: - Player Identity

    @Published var playerId: String?
    @Published var username: String?
    @Published var position: Int?
    @Published var pic: String?

    // MARK: - Game Info

    @Published var gameId: String?
    @Published var phase: GamePhase = .none
    @Published var currentHand: Int = 0
    @Published var dealer: Int?

    // MARK: - Trump

    @Published var trump: Card?
    @Published var trumpBroken: Bool = false

    // MARK: - Turn

    @Published var currentTurn: Int?
    @Published var isBidding: Bool = false

    // MARK: - Cards

    @Published var myCards: [Card] = []
    @Published var playedCards: [PlayedCard] = []

    // MARK: - Trick State

    @Published var leadCard: Card?
    @Published var leadPosition: Int?
    @Published var playedCardIndex: Int = 0
    @Published var trickWinner: Int?

    // MARK: - Bids

    @Published var bids: [Int: Int] = [:]  // position → bid
    @Published var teamBids: String?
    @Published var oppBids: String?
    @Published var team1Mult: Int = 1
    @Published var team2Mult: Int = 1
    @Published var tempBids: [String] = []

    // MARK: - Scores

    @Published var teamTricks: Int = 0
    @Published var oppTricks: Int = 0
    @Published var teamScore: Int = 0
    @Published var oppScore: Int = 0
    @Published var teamRainbows: Int = 0
    @Published var oppRainbows: Int = 0

    // MARK: - Trick History

    @Published var teamTrickHistory: [[PlayedCard]] = []
    @Published var oppTrickHistory: [[PlayedCard]] = []

    // MARK: - Players

    @Published var playerData: PlayerData?
    @Published var players: [Int: PlayerInfo] = [:]
    @Published var partnerName: String?
    @Published var opp1Name: String?
    @Published var opp2Name: String?

    // MARK: - UI Flags

    @Published var hasPlayedCard: Bool = false
    @Published var hasDrawn: Bool = false
    @Published var isUICreated: Bool = false

    // MARK: - Draw Phase

    @Published var drawCardCount: Int = 0
    @Published var drawnCard: Card?
    @Published var drawResults: [DrawResult] = []
    @Published var teamsAnnouncedData: [String: Any]?

    // MARK: - HSI

    @Published var hsiValues: [Int: Double] = [:]

    // MARK: - Disconnection

    @Published var disconnectedPlayers: [Int: String] = [:]  // pos → username
    @Published var resignationAvailable: (position: Int, username: String)?

    // MARK: - Game Log / Chat

    @Published var gameLog: [ChatMessage] = []

    // MARK: - Game End

    @Published var gameEndData: GameEndData?

    // MARK: - Error

    @Published var errorMessage: String?

    // MARK: - Combine Subjects (one-shot events for SpriteKit)

    let cardPlayedSubject = PassthroughSubject<PlayedCard, Never>()
    let trickCompleteSubject = PassthroughSubject<Int, Never>()    // winner position
    let handCompleteSubject = PassthroughSubject<[String: Any], Never>()
    let destroyHandsSubject = PassthroughSubject<Void, Never>()
    let rainbowSubject = PassthroughSubject<Int, Never>()          // position
    let chatBubbleSubject = PassthroughSubject<(message: String, position: Int), Never>()

    // MARK: - Optimistic Update State

    private var pendingCard: Card?
    private var previousCards: [Card]?
    private var pendingBid: Int?

    // MARK: - Init

    init() {}

    // MARK: - Reset

    func reset() {
        playerId = nil
        // Don't clear username — preserved for reconnection
        position = nil
        pic = nil

        gameId = nil
        phase = .none
        currentHand = 0
        dealer = nil
        trump = nil
        trumpBroken = false
        currentTurn = nil
        isBidding = false
        myCards = []
        playedCards = []
        leadCard = nil
        leadPosition = nil
        playedCardIndex = 0
        trickWinner = nil
        bids = [:]
        teamBids = nil
        oppBids = nil
        team1Mult = 1
        team2Mult = 1
        tempBids = []
        teamTricks = 0
        oppTricks = 0
        teamScore = 0
        oppScore = 0
        teamRainbows = 0
        oppRainbows = 0
        teamTrickHistory = []
        oppTrickHistory = []
        playerData = nil
        players = [:]
        partnerName = nil
        opp1Name = nil
        opp2Name = nil
        hasPlayedCard = false
        hasDrawn = false
        isUICreated = false
        drawCardCount = 0
        drawnCard = nil
        drawResults = []
        teamsAnnouncedData = nil
        hsiValues = [:]
        disconnectedPlayers = [:]
        resignationAvailable = nil
        gameLog = []
        gameEndData = nil
        errorMessage = nil
        pendingCard = nil
        previousCards = nil
        pendingBid = nil
    }

    /// Reset state for a new hand within the same game.
    func resetForNewHand() {
        playedCards = []
        playedCardIndex = 0
        leadCard = nil
        leadPosition = nil
        trumpBroken = false
        trickWinner = nil
        bids = [:]
        teamBids = nil
        oppBids = nil
        isBidding = true
        tempBids = []
        teamTricks = 0
        oppTricks = 0
        teamTrickHistory = []
        oppTrickHistory = []
        hasPlayedCard = false
        hasDrawn = false
        teamRainbows = 0
        oppRainbows = 0
    }

    // MARK: - Player Data

    struct PlayerData {
        var positions: [Int]
        var sockets: [String]
        var usernames: [String]
        var pics: [String?]
    }

    struct PlayerInfo: Equatable {
        let username: String
        var pic: String?
    }

    func setPlayerData(_ dict: [String: Any]) {
        let positions = dict["positions"] as? [Int] ?? dict["position"] as? [Int] ?? []
        let sockets = dict["sockets"] as? [String] ?? dict["socket"] as? [String] ?? []

        var usernames: [String] = []
        if let uArr = dict["usernames"] as? [[String: Any]] {
            usernames = uArr.compactMap { $0["username"] as? String }
        } else if let uArr = dict["username"] as? [[String: Any]] {
            usernames = uArr.compactMap { $0["username"] as? String }
        } else if let uArr = dict["usernames"] as? [String] {
            usernames = uArr
        } else if let uArr = dict["username"] as? [String] {
            usernames = uArr
        }

        let pics = dict["pics"] as? [String?] ?? Array(repeating: nil, count: positions.count)

        playerData = PlayerData(positions: positions, sockets: sockets, usernames: usernames, pics: pics)

        // Derive normalized players
        for (idx, pos) in positions.enumerated() {
            let uname = idx < usernames.count ? usernames[idx] : "P\(pos)"
            let p = idx < pics.count ? pics[idx] : nil
            players[pos] = PlayerInfo(username: uname, pic: p)
        }

        if position != nil {
            updatePlayerNames()
        }
    }

    func updatePlayerNames() {
        guard let myPos = position else { return }
        let rel = Positions.getRelativePositions(myPos: myPos)
        partnerName = players[rel.partner]?.username ?? "Partner"
        opp1Name = players[rel.opp1]?.username ?? "Opp1"
        opp2Name = players[rel.opp2]?.username ?? "Opp2"
    }

    func getPlayerName(position pos: Int) -> String {
        players[pos]?.username ?? "P\(pos)"
    }

    func updatePlayerUsername(position pos: Int, username: String) {
        players[pos] = PlayerInfo(username: username, pic: players[pos]?.pic)
        updatePlayerNames()
    }

    // MARK: - Bids

    func recordBid(position pos: Int, bid: Int) {
        bids[pos] = bid
        tempBids.append(String(bid).uppercased())
        updateTeamBids()
    }

    private func updateTeamBids() {
        guard let myPos = position else { return }
        let partnerPos = Positions.team(myPos)
        let myBid = bids[myPos]
        let partnerBid = bids[partnerPos]

        let oppPositions = myPos % 2 == 1 ? [2, 4] : [1, 3]
        let opp1Bid = bids[oppPositions[0]]
        let opp2Bid = bids[oppPositions[1]]

        teamBids = "\(myBid.map { String($0) } ?? "-")/\(partnerBid.map { String($0) } ?? "-")"
        oppBids = "\(opp1Bid.map { String($0) } ?? "-")/\(opp2Bid.map { String($0) } ?? "-")"
    }

    // MARK: - Trick

    func clearTrick() {
        playedCards = []
        playedCardIndex = 0
        leadCard = nil
        leadPosition = nil
        hasPlayedCard = false
        trickWinner = nil
    }

    // MARK: - Queries

    var isMyTurn: Bool {
        currentTurn == position
    }

    var partnerPosition: Int? {
        guard let pos = position else { return nil }
        return Positions.team(pos)
    }

    func isTeammate(_ pos: Int) -> Bool {
        guard let myPos = position else { return false }
        return Positions.team(myPos) == pos
    }

    var isLeading: Bool {
        playedCards.isEmpty
    }

    var sortedHand: [Card] {
        CardUtils.sortHand(myCards, trump: trump)
    }

    // MARK: - Optimistic Updates

    func optimisticPlayCard(_ card: Card) -> Bool {
        guard let index = myCards.firstIndex(of: card) else { return false }
        previousCards = myCards
        pendingCard = card
        myCards.remove(at: index)
        return true
    }

    func confirmCardPlay() {
        pendingCard = nil
        previousCards = nil
    }

    func rollbackCardPlay() {
        if let prev = previousCards {
            myCards = prev
            previousCards = nil
            pendingCard = nil
        }
    }

    func optimisticBid(_ bid: Int) {
        pendingBid = bid
    }

    func confirmBid() {
        if let bid = pendingBid, let pos = position {
            recordBid(position: pos, bid: bid)
            pendingBid = nil
        }
    }

    func rollbackBid() {
        pendingBid = nil
    }

    // MARK: - Restore from Rejoin

    func restoreFromRejoin(_ data: [String: Any]) {
        gameId = data["gameId"] as? String
        position = data["position"] as? Int
        currentHand = data["currentHand"] as? Int ?? 0
        dealer = data["dealer"] as? Int

        if let trumpDict = data["trump"] as? [String: Any] {
            trump = Card.from(trumpDict)
        }
        trumpBroken = data["trumpBroken"] as? Bool ?? false

        let bidding = data["isBidding"] as? Bool ?? data["bidding"] as? Bool ?? false
        isBidding = bidding
        currentTurn = data["currentTurn"] as? Int

        if let handArr = data["hand"] as? [[String: Any]] {
            myCards = Card.arrayFrom(handArr)
        }

        if let bidsDict = data["bids"] as? [String: Any] {
            bids = [:]
            for (key, val) in bidsDict {
                if let pos = Int(key), let bid = val as? Int {
                    bids[pos] = bid
                }
            }
            updateTeamBids()
        }

        if let tt = data["teamTricks"] as? Int { teamTricks = tt }
        if let ot = data["oppTricks"] as? Int { oppTricks = ot }
        if let ts = data["teamScore"] as? Int { teamScore = ts }
        if let os = data["oppScore"] as? Int { oppScore = os }

        // Restore scores from alternate format
        if let score = data["score"] as? [String: Any],
           let myPos = position {
            let t1 = score["team1"] as? Int ?? 0
            let t2 = score["team2"] as? Int ?? 0
            if myPos % 2 != 0 {
                teamScore = t1
                oppScore = t2
            } else {
                teamScore = t2
                oppScore = t1
            }
        }

        // Restore played cards
        if let pcArr = data["playedCards"] as? [[String: Any]?] {
            playedCards = []
            playedCardIndex = 0
            leadCard = nil
            leadPosition = nil
            for (index, cardDict) in pcArr.enumerated() {
                if let cd = cardDict, let card = Card.from(cd) {
                    let cardPos = index + 1
                    if leadCard == nil {
                        leadCard = card
                        leadPosition = cardPos
                    }
                    playedCards.append(PlayedCard(card: card, position: cardPos))
                    playedCardIndex += 1
                }
            }
        }

        // Restore player data
        if let playersArr = data["players"] as? [[String: Any]] {
            var positions: [Int] = []
            var sockets: [String] = []
            var usernames: [String] = []
            var pics: [String?] = []
            for p in playersArr {
                positions.append(p["position"] as? Int ?? 0)
                sockets.append(p["socketId"] as? String ?? "")
                usernames.append(p["username"] as? String ?? "")
                pics.append(p["pic"] as? String)
            }
            playerData = PlayerData(positions: positions, sockets: sockets, usernames: usernames, pics: pics)
            for (idx, pos) in positions.enumerated() {
                players[pos] = PlayerInfo(username: usernames[idx], pic: pics[idx])
            }
            updatePlayerNames()
        }

        phase = bidding ? .bidding : .playing
        isUICreated = true
    }
}
