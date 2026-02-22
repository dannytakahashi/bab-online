import Foundation

/// All socket event name constants — must match server's events.js exactly.
enum SocketEvents {
    // MARK: - Client → Server

    enum Client {
        // Auth
        static let signIn = "signIn"
        static let signUp = "signUp"

        // Main Room
        static let joinMainRoom = "joinMainRoom"
        static let mainRoomChat = "mainRoomChat"

        // Lobby
        static let createLobby = "createLobby"
        static let joinLobby = "joinLobby"
        static let leaveLobby = "leaveLobby"
        static let lobbyChat = "lobbyChat"
        static let playerReady = "playerReady"
        static let playerUnready = "playerUnready"

        // Session
        static let restoreSession = "restoreSession"

        // Game
        static let draw = "draw"
        static let playerBid = "playerBid"
        static let playCard = "playCard"
        static let chatMessage = "chatMessage"
        static let rejoinGame = "rejoinGame"
        static let forceResign = "forceResign"

        // Spectator
        static let joinAsSpectator = "joinAsSpectator"

        // Bots
        static let addBot = "addBot"
        static let removeBot = "removeBot"
    }

    // MARK: - Server → Client

    enum Server {
        // Auth
        static let signInResponse = "signInResponse"
        static let signUpResponse = "signUpResponse"
        static let restoreSessionResponse = "restoreSessionResponse"
        static let forceLogout = "forceLogout"
        static let activeGameFound = "activeGameFound"

        // Main Room
        static let mainRoomJoined = "mainRoomJoined"
        static let mainRoomMessage = "mainRoomMessage"
        static let mainRoomPlayerJoined = "mainRoomPlayerJoined"
        static let lobbiesUpdated = "lobbiesUpdated"

        // Lobby
        static let lobbyCreated = "lobbyCreated"
        static let lobbyJoined = "lobbyJoined"
        static let lobbyMessage = "lobbyMessage"
        static let lobbyPlayerJoined = "lobbyPlayerJoined"
        static let lobbyPlayerLeft = "lobbyPlayerLeft"
        static let leftLobby = "leftLobby"
        static let playerReadyUpdate = "playerReadyUpdate"
        static let allPlayersReady = "allPlayersReady"

        // Draw Phase
        static let startDraw = "startDraw"
        static let youDrew = "youDrew"
        static let playerDrew = "playerDrew"
        static let teamsAnnounced = "teamsAnnounced"

        // Game
        static let positionUpdate = "positionUpdate"
        static let createUI = "createUI"
        static let gameStart = "gameStart"
        static let bidReceived = "bidReceived"
        static let doneBidding = "doneBidding"
        static let updateTurn = "updateTurn"
        static let cardPlayed = "cardPlayed"
        static let trickComplete = "trickComplete"
        static let handComplete = "handComplete"
        static let gameEnd = "gameEnd"
        static let rainbow = "rainbow"
        static let destroyHands = "destroyHands"

        // Chat
        static let chatMessage = "chatMessage"
        static let gameLogEntry = "gameLogEntry"

        // Reconnection
        static let rejoinSuccess = "rejoinSuccess"
        static let rejoinFailed = "rejoinFailed"
        static let playerDisconnected = "playerDisconnected"
        static let playerReconnected = "playerReconnected"
        static let playerAssigned = "playerAssigned"
        static let abortGame = "abortGame"
        static let roomFull = "roomFull"

        // Resignation & Lazy Mode
        static let resignationAvailable = "resignationAvailable"
        static let playerResigned = "playerResigned"
        static let playerLazyMode = "playerLazyMode"
        static let playerActiveMode = "playerActiveMode"
        static let leftGame = "leftGame"
        static let restorePlayerState = "restorePlayerState"
        static let spectatorJoined = "spectatorJoined"

        // Connection
        static let connect = "connect"
        static let disconnect = "disconnect"
    }
}
