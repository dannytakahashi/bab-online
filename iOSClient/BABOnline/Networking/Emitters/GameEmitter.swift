import Foundation

enum GameEmitter {
    private static var socket: SocketService { .shared }

    static func draw(cardIndex: Int) {
        socket.emit(SocketEvents.Client.draw, ["num": cardIndex])
    }

    static func playerBid(bid: Int, position: Int) {
        socket.emit(SocketEvents.Client.playerBid, LiveGameEmitter.playerBidPayload(String(bid), position: position))
    }

    static func playerBidBore(bid: String, position: Int) {
        socket.emit(SocketEvents.Client.playerBid, LiveGameEmitter.playerBidPayload(bid, position: position))
    }

    static func playCard(card: Card, position: Int) {
        socket.emit(SocketEvents.Client.playCard, LiveGameEmitter.playCardPayload(card, position: position))
    }

    /// Snapshot v2 resync (contract/README.md): the reply is stateSnapshot with this requestId.
    static func requestSnapshot(requestId: String, log: Bool, customPics: Bool) {
        socket.emit(SocketEvents.Client.requestSnapshot, ["requestId": requestId, "log": log, "customPics": customPics])
    }

    /// The over-the-shoulder view (a pure spectator only; State/Table/Shoulder.swift): watch
    /// seat `position` read-only, or stop (nil). The reply is stateSnapshot `reason: 'watchHand'`
    /// or watchHandRefused.
    static func watchHand(gameId: String, position: Int?) {
        socket.emit(SocketEvents.Client.watchHand, LiveGameEmitter.watchHandPayload(gameId: gameId, position: position))
    }

    static func forceResign(position: Int) {
        socket.emit(SocketEvents.Client.forceResign, ["position": position])
    }
}
