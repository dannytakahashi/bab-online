import Foundation
import Combine

/// Handles all game-phase socket events.
final class GameSocketHandler {
    private let socket: SocketService
    private let gameState: GameState
    private let appState: AppState

    init(socket: SocketService, gameState: GameState, appState: AppState) {
        self.socket = socket
        self.gameState = gameState
        self.appState = appState
    }

    func register() {
        registerSetupPhase()
        registerBiddingPhase()
        registerPlayingPhase()
        registerGameEnd()
        registerSpecialEvents()
        registerReconnection()
        registerSpectatorAndLazy()
    }

    // MARK: - Setup Phase

    private func registerSetupPhase() {
        socket.on(SocketEvents.Server.positionUpdate) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.setPlayerData(dict)
                if let pos = dict["yourPosition"] as? Int {
                    self.gameState.position = pos
                    self.gameState.updatePlayerNames()
                }
            }
        }

        socket.on(SocketEvents.Server.startDraw) { [weak self] data, _ in
            guard let self else { return }
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async {
                self.gameState.phase = .draw
                self.gameState.hasDrawn = false
                if let numCards = dict?["numCards"] as? Int {
                    self.gameState.drawCardCount = numCards
                }
                self.appState.screen = .game
            }
        }

        socket.on(SocketEvents.Server.youDrew) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.hasDrawn = true
                if let cardDict = dict["card"] as? [String: Any], let card = Card.from(cardDict) {
                    self.gameState.drawnCard = card
                }
                if let pos = dict["position"] as? Int {
                    self.gameState.position = pos
                }
            }
        }

        socket.on(SocketEvents.Server.playerDrew) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let username = dict["username"] as? String,
                   let drawOrder = dict["drawOrder"] as? Int {
                    let card: Card? = (dict["card"] as? [String: Any]).flatMap { Card.from($0) }
                    self.gameState.drawResults.append(DrawResult(username: username, position: drawOrder, cardIndex: dict["cardIndex"] as? Int ?? 0, card: card))
                }
            }
        }

        socket.on(SocketEvents.Server.teamsAnnounced) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.teamsAnnouncedData = dict
            }
        }

        socket.on(SocketEvents.Server.createUI) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                self.gameState.isUICreated = true
            }
        }

        socket.on(SocketEvents.Server.gameStart) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.handleGameStart(dict)
            }
        }
    }

    // MARK: - Bidding Phase

    private func registerBiddingPhase() {
        socket.on(SocketEvents.Server.bidReceived) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let position = dict["position"] as? Int ?? 0

                // Server sends bid as String (e.g. "5", "B", "2B") or Int
                let bid: String
                if let bidStr = dict["bid"] as? String {
                    bid = bidStr
                } else if let bidInt = dict["bid"] as? Int {
                    bid = String(bidInt)
                } else {
                    bid = "0"
                }

                self.gameState.recordBid(position: position, bid: bid)

                if let t1m = dict["team1Mult"] as? Int { self.gameState.team1Mult = t1m }
                if let t2m = dict["team2Mult"] as? Int { self.gameState.team2Mult = t2m }

                // Client-side log entry
                let name = self.gameState.getPlayerName(position: position)
                self.gameState.addSystemLog("\(name) bid \(bid)")
            }
        }

        socket.on(SocketEvents.Server.doneBidding) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.isBidding = false
                self.gameState.phase = .playing
                self.gameState.hasPlayedCard = false
                self.gameState.playedCards = []
                self.gameState.playedCardIndex = 0
                self.gameState.leadCard = nil
                self.gameState.leadPosition = nil
                self.gameState.trumpBroken = false

                if let lead = dict["lead"] as? Int {
                    self.gameState.currentTurn = lead
                }

                // Client-side log: bidding summary
                if self.gameState.isSpectator {
                    let team1Name = "\(self.gameState.getPlayerName(position: 1))/\(self.gameState.getPlayerName(position: 3))"
                    let team2Name = "\(self.gameState.getPlayerName(position: 2))/\(self.gameState.getPlayerName(position: 4))"
                    let t1Bids = "\(self.gameState.bids[1] ?? "-")/\(self.gameState.bids[3] ?? "-")"
                    let t2Bids = "\(self.gameState.bids[2] ?? "-")/\(self.gameState.bids[4] ?? "-")"
                    self.gameState.addSystemLog("Bidding complete — \(team1Name): \(t1Bids), \(team2Name): \(t2Bids)")
                } else if let teamBids = self.gameState.teamBids, let oppBids = self.gameState.oppBids {
                    self.gameState.addSystemLog("Bidding complete — Your team: \(teamBids), Opponents: \(oppBids)")
                }
            }
        }
    }

    // MARK: - Playing Phase

    private func registerPlayingPhase() {
        socket.on(SocketEvents.Server.updateTurn) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let turn = dict["currentTurn"] as? Int ?? dict["turn"] as? Int ?? 0
                self.gameState.currentTurn = turn
                self.gameState.hasPlayedCard = false
            }
        }

        socket.on(SocketEvents.Server.cardPlayed) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.handleCardPlayed(dict)
            }
        }

        socket.on(SocketEvents.Server.trickComplete) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let winner = dict["winner"] as? Int ?? 0
                self.gameState.trickWinner = winner
                self.gameState.trickCompleteSubject.send(winner)

                // Update trick counts
                if let myPos = self.gameState.position {
                    if Positions.getTeamNumber(winner) == Positions.getTeamNumber(myPos) {
                        self.gameState.teamTricks += 1
                    } else {
                        self.gameState.oppTricks += 1
                    }
                }

                // Client-side log entry
                let winnerName = self.gameState.getPlayerName(position: winner)
                self.gameState.addSystemLog("\(winnerName) won the trick (\(self.gameState.teamTricks)-\(self.gameState.oppTricks))")

                // Clear trick state after delay (let animation play).
                // Guard: if a new trick's card has already been played
                // (playedCardIndex > 0), skip to avoid wiping new trick state.
                DispatchQueue.main.asyncAfter(deadline: .now() + LayoutConstants.collectTrickDuration + 0.3) {
                    guard self.gameState.playedCardIndex == 0 else { return }
                    self.gameState.clearTrick()
                }
            }
        }

        socket.on(SocketEvents.Server.handComplete) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.handleHandComplete(dict)
            }
        }

        socket.on(SocketEvents.Server.destroyHands) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                self.gameState.destroyHandsSubject.send()
            }
        }
    }

    // MARK: - Game End

    private func registerGameEnd() {
        socket.on(SocketEvents.Server.gameEnd) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.phase = .ended
                self.gameState.gameEndData = GameEndData.from(dict)
            }
        }
    }

    // MARK: - Special Events

    private func registerSpecialEvents() {
        socket.on(SocketEvents.Server.rainbow) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let position = dict["position"] as? Int ?? 0
                self.gameState.rainbowSubject.send(position)

                if let myPos = self.gameState.position {
                    if Positions.getTeamNumber(position) == Positions.getTeamNumber(myPos) {
                        self.gameState.teamRainbows += 1
                    } else {
                        self.gameState.oppRainbows += 1
                    }
                }
            }
        }

        socket.on(SocketEvents.Server.abortGame) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                let savedTournamentId = self.gameState.tournamentId
                self.gameState.reset()
                if savedTournamentId != nil {
                    TournamentEmitter.returnToTournament()
                } else {
                    self.appState.screen = .mainRoom
                }
            }
        }

        socket.on(SocketEvents.Server.roomFull) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                self.gameState.errorMessage = "Room is full"
            }
        }

        // Disconnection/reconnection of other players
        socket.on(SocketEvents.Server.playerDisconnected) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let pos = dict["position"] as? Int ?? 0
                let username = dict["username"] as? String ?? ""
                self.gameState.disconnectedPlayers[pos] = username
            }
        }

        socket.on(SocketEvents.Server.playerReconnected) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let pos = dict["position"] as? Int ?? 0
                self.gameState.disconnectedPlayers.removeValue(forKey: pos)
            }
        }

        // Resignation
        socket.on(SocketEvents.Server.resignationAvailable) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let pos = dict["position"] as? Int ?? 0
                let username = dict["username"] as? String ?? ""
                self.gameState.resignationAvailable = (position: pos, username: username)
            }
        }

        socket.on(SocketEvents.Server.playerResigned) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let pos = dict["position"] as? Int ?? 0
                self.gameState.disconnectedPlayers.removeValue(forKey: pos)
                self.gameState.resignationAvailable = nil

                if let botUsername = dict["botUsername"] as? String {
                    let botPic: String? = (dict["botPic"] as? Int).map { String($0) } ?? dict["botPic"] as? String
                    self.gameState.players[pos] = GameState.PlayerInfo(username: botUsername, pic: botPic)
                    self.gameState.updatePlayerNames()
                }
            }
        }

        socket.on(SocketEvents.Server.gameLogEntry) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let message = dict["message"] as? String ?? ""
                let type = dict["type"] as? String ?? "system"
                let entry = ChatMessage(username: "System", message: message, type: ChatMessage.MessageType(rawValue: type) ?? .system)
                self.gameState.gameLog.append(entry)
            }
        }
    }

    // MARK: - Reconnection

    private func registerReconnection() {
        socket.on(SocketEvents.Server.rejoinSuccess) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.restoreFromRejoin(dict)
                if dict["isLazy"] as? Bool == true {
                    self.gameState.isLazy = true
                }
                self.appState.screen = .game
                print("[Game] Rejoin success")
            }
        }

        socket.on(SocketEvents.Server.rejoinFailed) { [weak self] data, _ in
            guard let self else { return }
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async {
                let reason = dict?["reason"] as? String ?? "Rejoin failed"
                print("[Game] Rejoin failed: \(reason)")
                // Don't navigate away if we're already in a game
                // (handles duplicate rejoin where first succeeded)
                if self.appState.screen != .game {
                    self.appState.screen = .mainRoom
                    LobbyEmitter.joinMainRoom()
                }
            }
        }
    }

    // MARK: - Spectator & Lazy Mode

    private func registerSpectatorAndLazy() {
        // spectatorJoined — either we're joining as spectator (full state) or someone else joined
        socket.on(SocketEvents.Server.spectatorJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if dict["players"] != nil && dict["trump"] != nil {
                    // We are joining as spectator — full game state provided
                    self.gameState.restoreFromSpectator(dict)
                    self.appState.screen = .game
                    print("[Game] Joined as spectator")
                } else {
                    // Someone else joined as spectator
                    let username = dict["username"] as? String ?? "Someone"
                    self.gameState.addSystemLog("\(username) joined as spectator")
                }
            }
        }

        // playerLazyMode — a player switched to lazy (bot takes over)
        socket.on(SocketEvents.Server.playerLazyMode) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let pos = dict["position"] as? Int ?? 0
                let botUsername = dict["botUsername"] as? String ?? "Bot"
                let botPic: String? = (dict["botPic"] as? Int).map { String($0) } ?? dict["botPic"] as? String

                self.gameState.players[pos] = GameState.PlayerInfo(username: botUsername, pic: botPic)
                self.gameState.updatePlayerNames()

                if pos == self.gameState.position {
                    self.gameState.isLazy = true
                }
            }
        }

        // playerActiveMode — a player took back control from bot
        socket.on(SocketEvents.Server.playerActiveMode) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let pos = dict["position"] as? Int ?? 0
                let username = dict["username"] as? String ?? ""
                let pic: String? = (dict["pic"] as? Int).map { String($0) } ?? dict["pic"] as? String

                self.gameState.players[pos] = GameState.PlayerInfo(username: username, pic: pic)
                self.gameState.updatePlayerNames()

                if pos == self.gameState.position {
                    self.gameState.isLazy = false
                }
            }
        }

        // leftGame — server confirmed we left the game
        socket.on(SocketEvents.Server.leftGame) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                let savedTournamentId = self.gameState.tournamentId
                self.gameState.reset()
                if savedTournamentId != nil {
                    TournamentEmitter.returnToTournament()
                } else {
                    self.appState.screen = .mainRoom
                    LobbyEmitter.joinMainRoom()
                }
            }
        }

        // restorePlayerState — player used /active from spectator mode
        socket.on(SocketEvents.Server.restorePlayerState) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.gameState.isSpectator = false
                self.gameState.isLazy = false
                self.gameState.restoreFromRejoin(dict)
                self.appState.screen = .game
                print("[Game] Player state restored from spectator")
            }
        }
    }

    // MARK: - Helpers

    private func handleGameStart(_ dict: [String: Any]) {
        if let pos = dict["position"] as? Int {
            gameState.position = pos
        }

        gameState.gameId = dict["gameId"] as? String
        gameState.currentHand = dict["currentHand"] as? Int ?? 0
        gameState.dealer = dict["dealer"] as? Int

        if let trumpDict = dict["trump"] as? [String: Any], let trump = Card.from(trumpDict) {
            gameState.trump = trump
        }

        if let handArr = dict["hand"] as? [[String: Any]] {
            gameState.myCards = Card.arrayFrom(handArr)
        }

        if let hsi = dict["hsiValues"] as? [String: Any] {
            var parsed: [Int: Double] = [:]
            for (key, val) in hsi {
                if let pos = Int(key), let v = val as? Double {
                    parsed[pos] = v
                }
            }
            gameState.hsiValues = parsed
        }

        // Update scores
        if let s1 = dict["score1"] as? Int, let s2 = dict["score2"] as? Int,
           let myPos = gameState.position {
            if myPos % 2 != 0 {
                gameState.teamScore = s1
                gameState.oppScore = s2
            } else {
                gameState.teamScore = s2
                gameState.oppScore = s1
            }
        }

        gameState.isBidding = true
        gameState.phase = .bidding
        gameState.isUICreated = true
        appState.screen = .game

        // Client-side log: new hand
        if let trump = gameState.trump {
            let trumpStr: String
            switch trump.suit {
            case .spades:   trumpStr = "\(trump.rank.rawValue)\u{2660}"
            case .hearts:   trumpStr = "\(trump.rank.rawValue)\u{2665}"
            case .diamonds: trumpStr = "\(trump.rank.rawValue)\u{2666}"
            case .clubs:    trumpStr = "\(trump.rank.rawValue)\u{2663}"
            case .joker:    trumpStr = trump.rank == .hi ? "High Joker" : "Low Joker"
            }
            gameState.addSystemLog("Hand \(gameState.currentHand) — Trump: \(trumpStr)")
        } else {
            gameState.addSystemLog("Hand \(gameState.currentHand) started")
        }
    }

    private func handleCardPlayed(_ dict: [String: Any]) {
        guard let cardDict = dict["card"] as? [String: Any],
              let card = Card.from(cardDict),
              let position = dict["position"] as? Int else { return }

        // Track lead
        if gameState.playedCardIndex == 0 {
            // Safety net: clear stale trick data if the delayed clearTrick() was skipped
            gameState.clearTrick()
            gameState.leadCard = card
            gameState.leadPosition = position
        }

        // Update trump broken
        if let tb = dict["trump"] as? Bool { gameState.trumpBroken = tb }
        if let tb = dict["trumpBroken"] as? Bool { gameState.trumpBroken = tb }

        // Add to played cards
        gameState.playedCards.append(PlayedCard(card: card, position: position))
        gameState.playedCardIndex += 1

        // OT detection: current card is trump/joker, previous card is trump/joker,
        // current rank > previous rank, and lead card is NOT trump.
        // Done here (not in SpriteKit scene) so playedCards state is guaranteed consistent.
        if gameState.playedCards.count >= 2,
           let leadCard = gameState.leadCard,
           let trump = gameState.trump {
            let previousCard = gameState.playedCards[gameState.playedCards.count - 2].card
            let leadIsTrump = leadCard.suit == trump.suit || leadCard.suit == .joker
            let currentIsTrump = card.suit == trump.suit || card.suit == .joker
            let previousIsTrump = previousCard.suit == trump.suit || previousCard.suit == .joker

            if !leadIsTrump && currentIsTrump && previousIsTrump {
                let currentRank = CardConstants.rankValues[card.rank] ?? 0
                let previousRank = CardConstants.rankValues[previousCard.rank] ?? 0
                if currentRank > previousRank {
                    gameState.overTrumpSubject.send()
                }
            }
        }

        gameState.cardPlayedSubject.send(PlayedCard(card: card, position: position))

        // Confirm optimistic play
        gameState.confirmCardPlay()

        if gameState.playedCardIndex >= 4 {
            gameState.playedCardIndex = 0
            // Immediately clear lead so trick winner can lead freely.
            // clearTrick() will clean up playedCards after the animation delay.
            gameState.leadCard = nil
            gameState.leadPosition = nil
        }
    }

    private func handleHandComplete(_ dict: [String: Any]) {
        guard let score = dict["score"] as? [String: Any] else {
            gameState.handCompleteSubject.send(dict)
            gameState.resetForNewHand()
            return
        }

        let t1 = score["team1"] as? Int ?? 0
        let t2 = score["team2"] as? Int ?? 0
        let t1Tricks = dict["team1Tricks"] as? Int ?? 0
        let t2Tricks = dict["team2Tricks"] as? Int ?? 0
        let t1OldScore = dict["team1OldScore"] as? Int ?? 0
        let t2OldScore = dict["team2OldScore"] as? Int ?? 0

        // Update scores (relative to player)
        if let myPos = gameState.position {
            if myPos % 2 != 0 {
                gameState.teamScore = t1
                gameState.oppScore = t2
            } else {
                gameState.teamScore = t2
                gameState.oppScore = t1
            }
        }

        // Build detailed score breakdown before reset clears bids/rainbows
        let team1Name = "\(gameState.getPlayerName(position: 1))/\(gameState.getPlayerName(position: 3))"
        let team2Name = "\(gameState.getPlayerName(position: 2))/\(gameState.getPlayerName(position: 4))"

        let t1Bid1 = gameState.bids[1] ?? "-"
        let t1Bid2 = gameState.bids[3] ?? "-"
        let t2Bid1 = gameState.bids[2] ?? "-"
        let t2Bid2 = gameState.bids[4] ?? "-"

        let t1Change = t1 - t1OldScore
        let t2Change = t2 - t2OldScore
        let t1ChangeStr = t1Change >= 0 ? "+\(t1Change)" : "\(t1Change)"
        let t2ChangeStr = t2Change >= 0 ? "+\(t2Change)" : "\(t2Change)"

        // Map relative rainbow counts to absolute team1/team2
        let team1Rainbows: Int
        let team2Rainbows: Int
        if let myPos = gameState.position {
            if myPos % 2 != 0 {
                team1Rainbows = gameState.teamRainbows
                team2Rainbows = gameState.oppRainbows
            } else {
                team1Rainbows = gameState.oppRainbows
                team2Rainbows = gameState.teamRainbows
            }
        } else {
            team1Rainbows = 0
            team2Rainbows = 0
        }

        // Build annotation strings for bore multipliers and rainbow bonuses
        func annotation(mult: Int, rainbows: Int) -> String {
            var parts: [String] = []
            if mult > 1 { parts.append("\(mult)x") }
            if rainbows > 0 { parts.append("rainbow +\(rainbows * 10)") }
            return parts.isEmpty ? "" : " (\(parts.joined(separator: ", ")))"
        }

        let t1Annotation = annotation(mult: gameState.team1Mult, rainbows: team1Rainbows)
        let t2Annotation = annotation(mult: gameState.team2Mult, rainbows: team2Rainbows)

        // Add detailed log entries
        gameState.addSystemLog("--- HAND COMPLETE ---")
        gameState.addSystemLog("\(team1Name): Bid \(t1Bid1)/\(t1Bid2), Won \(t1Tricks), \(t1ChangeStr) → \(t1)\(t1Annotation)")
        gameState.addSystemLog("\(team2Name): Bid \(t2Bid1)/\(t2Bid2), Won \(t2Tricks), \(t2ChangeStr) → \(t2)\(t2Annotation)")

        gameState.handCompleteSubject.send(dict)
        gameState.resetForNewHand()
    }
}
