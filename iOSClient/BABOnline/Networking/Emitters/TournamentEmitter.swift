import Foundation

enum TournamentEmitter {
    private static var socket: SocketService { .shared }

    static func createTournament() {
        socket.emit(SocketEvents.Client.createTournament, [:])
    }

    static func joinTournament(tournamentId: String) {
        socket.emit(SocketEvents.Client.joinTournament, ["tournamentId": tournamentId])
    }

    static func leaveTournament() {
        socket.emit(SocketEvents.Client.leaveTournament)
    }

    static func tournamentReady() {
        socket.emit(SocketEvents.Client.tournamentReady)
    }

    static func tournamentUnready() {
        socket.emit(SocketEvents.Client.tournamentUnready)
    }

    static func beginTournament() {
        socket.emit(SocketEvents.Client.beginTournament)
    }

    static func beginNextRound() {
        socket.emit(SocketEvents.Client.beginNextRound)
    }

    static func tournamentChat(message: String) {
        socket.emit(SocketEvents.Client.tournamentChat, ["message": message])
    }

    static func spectateTournament(tournamentId: String) {
        socket.emit(SocketEvents.Client.spectateTournament, ["tournamentId": tournamentId])
    }

    static func spectateTournamentGame(gameId: String) {
        socket.emit(SocketEvents.Client.spectateTournamentGame, ["gameId": gameId])
    }

    static func returnToTournament() {
        socket.emit(SocketEvents.Client.returnToTournament)
    }
}
