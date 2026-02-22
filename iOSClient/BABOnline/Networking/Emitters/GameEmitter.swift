import Foundation

enum GameEmitter {
    private static var socket: SocketService { .shared }

    static func draw(cardIndex: Int) {
        socket.emit(SocketEvents.Client.draw, ["num": cardIndex])
    }

    static func playerBid(bid: Int, position: Int) {
        socket.emit(SocketEvents.Client.playerBid, ["bid": bid, "position": position])
    }

    static func playerBidBore(bid: String, position: Int) {
        socket.emit(SocketEvents.Client.playerBid, ["bid": bid, "position": position])
    }

    static func playCard(card: Card, position: Int) {
        socket.emit(SocketEvents.Client.playCard, [
            "card": ["suit": card.suit.rawValue, "rank": card.rank.rawValue],
            "position": position
        ])
    }

    static func forceResign(position: Int) {
        socket.emit(SocketEvents.Client.forceResign, ["position": position])
    }
}
