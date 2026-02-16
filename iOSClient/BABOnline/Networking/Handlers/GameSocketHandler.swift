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
                   let pos = dict["position"] as? Int {
                    self.gameState.drawResults.append(DrawResult(username: username, position: pos, cardIndex: dict["cardIndex"] as? Int ?? 0))
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
                let bid = dict["bid"] as? Int ?? 0
                self.gameState.recordBid(position: position, bid: bid)

                if let t1m = dict["team1Mult"] as? Int { self.gameState.team1Mult = t1m }
                if let t2m = dict["team2Mult"] as? Int { self.gameState.team2Mult = t2m }
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

                // Clear trick state after delay (let animation play)
                DispatchQueue.main.asyncAfter(deadline: .now() + LayoutConstants.collectTrickDuration + 0.3) {
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
                self.gameState.reset()
                self.appState.screen = .mainRoom
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
                    self.gameState.updatePlayerUsername(position: pos, username: botUsername)
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
                self.appState.screen = .mainRoom
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
    }

    private func handleCardPlayed(_ dict: [String: Any]) {
        guard let cardDict = dict["card"] as? [String: Any],
              let card = Card.from(cardDict),
              let position = dict["position"] as? Int else { return }

        // Track lead
        if gameState.playedCardIndex == 0 {
            gameState.leadCard = card
            gameState.leadPosition = position
        }

        // Update trump broken
        if let tb = dict["trump"] as? Bool { gameState.trumpBroken = tb }
        if let tb = dict["trumpBroken"] as? Bool { gameState.trumpBroken = tb }

        // Add to played cards
        gameState.playedCards.append(PlayedCard(card: card, position: position))
        gameState.playedCardIndex += 1
        gameState.cardPlayedSubject.send(PlayedCard(card: card, position: position))

        // Confirm optimistic play
        gameState.confirmCardPlay()

        if gameState.playedCardIndex >= 4 {
            gameState.playedCardIndex = 0
        }
    }

    private func handleHandComplete(_ dict: [String: Any]) {
        if let score = dict["score"] as? [String: Any],
           let myPos = gameState.position {
            let t1 = score["team1"] as? Int ?? 0
            let t2 = score["team2"] as? Int ?? 0
            if myPos % 2 != 0 {
                gameState.teamScore = t1
                gameState.oppScore = t2
            } else {
                gameState.teamScore = t2
                gameState.oppScore = t1
            }
        }

        gameState.handCompleteSubject.send(dict)
        gameState.resetForNewHand()
    }
}
