import Foundation
import WebRTC

enum VoiceEmitter {
    private static var socket: SocketService { .shared }

    static func sendOffer(targetSocketId: String, offer: RTCSessionDescription, username: String?) {
        socket.emit(SocketEvents.Client.voiceOffer, [
            "targetSocketId": targetSocketId,
            "offer": ["type": offer.type.webString, "sdp": offer.sdp],
            "username": username ?? ""
        ])
    }

    static func sendAnswer(targetSocketId: String, answer: RTCSessionDescription) {
        socket.emit(SocketEvents.Client.voiceAnswer, [
            "targetSocketId": targetSocketId,
            "answer": ["type": answer.type.webString, "sdp": answer.sdp]
        ])
    }

    static func sendIceCandidate(targetSocketId: String, candidate: RTCIceCandidate) {
        socket.emit(SocketEvents.Client.voiceIceCandidate, [
            "targetSocketId": targetSocketId,
            "candidate": [
                "candidate": candidate.sdp,
                "sdpMLineIndex": candidate.sdpMLineIndex,
                "sdpMid": candidate.sdpMid ?? ""
            ]
        ])
    }
}

// MARK: - RTCSdpType extension

extension RTCSdpType {
    var webString: String {
        switch self {
        case .offer: return "offer"
        case .prAnswer: return "pranswer"
        case .answer: return "answer"
        case .rollback: return "rollback"
        @unknown default: return "offer"
        }
    }

    init?(from string: String) {
        switch string {
        case "offer": self = .offer
        case "pranswer": self = .prAnswer
        case "answer": self = .answer
        case "rollback": self = .rollback
        default: return nil
        }
    }
}
