import Foundation

/// Generated from contract/events.schema.json by npm run contract:gen — do not edit
enum SocketEvents {
    // MARK: - Client → Server

    enum Client {
        // Auth
        static let signIn = "signIn"
        static let signUp = "signUp"
        static let deleteAccount = "deleteAccount"
        static let changePassword = "changePassword"

        // Safety / moderation
        static let reportUser = "reportUser"
        static let blockUser = "blockUser"
        static let unblockUser = "unblockUser"

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
        static let setSpectatorsCanTalk = "setSpectatorsCanTalk"
        static let releaseLobbyHold = "releaseLobbyHold"
        static let lobbyReturnSeen = "lobbyReturnSeen"

        // Session
        static let restoreSession = "restoreSession"
        static let clientHello = "clientHello"
        static let clientError = "clientError"

        // Game
        static let draw = "draw"
        static let playerBid = "playerBid"
        static let playCard = "playCard"
        static let chatMessage = "chatMessage"
        static let rejoinGame = "rejoinGame"
        static let forceResign = "forceResign"

        // Spectator
        static let joinAsSpectator = "joinAsSpectator"
        static let watchHand = "watchHand"

        // Bots
        static let addBot = "addBot"
        static let removeBot = "removeBot"

        // Leaderboard and records
        static let getLeaderboard = "getLeaderboard"
        static let getRecords = "getRecords"

        // Profile
        static let getProfile = "getProfile"
        static let updateProfilePic = "updateProfilePic"
        static let uploadProfilePic = "uploadProfilePic"
        static let getPlayerProfile = "getPlayerProfile"

        // Tournament
        static let createTournament = "createTournament"
        static let joinTournament = "joinTournament"
        static let leaveTournament = "leaveTournament"
        static let tournamentReady = "tournamentReady"
        static let tournamentUnready = "tournamentUnready"
        static let beginTournament = "beginTournament"
        static let beginNextRound = "beginNextRound"
        static let tournamentChat = "tournamentChat"
        static let spectateTournament = "spectateTournament"
        static let spectateTournamentGame = "spectateTournamentGame"
        static let returnToTournament = "returnToTournament"
        static let cancelTournament = "cancelTournament"

        // Voice
        static let voiceOffer = "voiceOffer"
        static let voiceAnswer = "voiceAnswer"
        static let voiceIceCandidate = "voiceIceCandidate"
        static let getVoiceIceServers = "getVoiceIceServers"

        // Snapshot v2
        static let requestSnapshot = "requestSnapshot"

        // Admin panel
        static let adminRequest = "adminRequest"
    }

    // MARK: - Server → Client

    enum Server {
        // Auth
        static let signInResponse = "signInResponse"
        static let signUpResponse = "signUpResponse"
        static let restoreSessionResponse = "restoreSessionResponse"
        static let forceLogout = "forceLogout"
        static let activeGameFound = "activeGameFound"
        static let deleteAccountResponse = "deleteAccountResponse"
        static let changePasswordResponse = "changePasswordResponse"

        // Safety / moderation
        static let reportUserResponse = "reportUserResponse"
        static let blockListUpdated = "blockListUpdated"

        // Main Room
        static let mainRoomJoined = "mainRoomJoined"
        static let mainRoomMessage = "mainRoomMessage"
        static let mainRoomPlayerJoined = "mainRoomPlayerJoined"
        static let lobbiesUpdated = "lobbiesUpdated"
        static let mainRoomPlayerLeft = "mainRoomPlayerLeft"

        // Lobby
        static let lobbyCreated = "lobbyCreated"
        static let lobbyReturn = "lobbyReturn"
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
        static let actionRejected = "actionRejected"
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
        static let abortGame = "abortGame"

        // Resignation & Lazy Mode
        static let resignationAvailable = "resignationAvailable"
        static let playerResigned = "playerResigned"
        static let playerLazyMode = "playerLazyMode"
        static let playerActiveMode = "playerActiveMode"
        static let leftGame = "leftGame"
        static let restorePlayerState = "restorePlayerState"
        static let spectatorJoined = "spectatorJoined"
        static let spectatorsUpdated = "spectatorsUpdated"
        static let bidClock = "bidClock"
        static let seatLeft = "seatLeft"
        static let assistHint = "assistHint"
        static let assistState = "assistState"
        static let watchHandRefused = "watchHandRefused"

        // Tournament
        static let tournamentCreated = "tournamentCreated"
        static let tournamentJoined = "tournamentJoined"
        static let tournamentPlayerJoined = "tournamentPlayerJoined"
        static let tournamentPlayerLeft = "tournamentPlayerLeft"
        static let tournamentReadyUpdate = "tournamentReadyUpdate"
        static let tournamentMessage = "tournamentMessage"
        static let tournamentRoundStart = "tournamentRoundStart"
        static let tournamentGameAssignment = "tournamentGameAssignment"
        static let tournamentGameComplete = "tournamentGameComplete"
        static let tournamentRoundComplete = "tournamentRoundComplete"
        static let tournamentComplete = "tournamentComplete"
        static let tournamentLeft = "tournamentLeft"
        static let tournamentCancelled = "tournamentCancelled"

        // Leaderboard and records
        static let leaderboardResponse = "leaderboardResponse"
        static let recordsResponse = "recordsResponse"

        // Profile
        static let profileResponse = "profileResponse"
        static let profilePicUpdateResponse = "profilePicUpdateResponse"
        static let profilePicUploadResponse = "profilePicUploadResponse"
        static let playerProfileResponse = "playerProfileResponse"
        static let badgesAwarded = "badgesAwarded"

        // Voice
        static let voiceOffer = "voiceOffer"
        static let voiceAnswer = "voiceAnswer"
        static let voiceIceCandidate = "voiceIceCandidate"
        static let voicePeerList = "voicePeerList"
        static let voicePeerJoined = "voicePeerJoined"
        static let voicePeerLeft = "voicePeerLeft"
        static let voiceIceServers = "voiceIceServers"
        static let voiceSettings = "voiceSettings"

        // Connection
        static let connect = "connect"
        static let disconnect = "disconnect"
        static let serverShutdown = "serverShutdown"
        static let serverError = "serverError"

        // Snapshot v2
        static let stateSnapshot = "stateSnapshot"

        // Admin panel
        static let adminResponse = "adminResponse"
    }
}
