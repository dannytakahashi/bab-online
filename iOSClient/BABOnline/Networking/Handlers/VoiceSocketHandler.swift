import Foundation
import WebRTC

/// Handles incoming voice signaling events from the server.
/// Delegates all processing to VoiceChatManager.shared.
final class VoiceSocketHandler {
    private let socket: SocketService

    init(socket: SocketService) {
        self.socket = socket
    }

    func register() {
        // Peer list — server tells us which humans are already in voice
        socket.on(SocketEvents.Server.voicePeerList) { data, _ in
            guard let dict = data.first as? [String: Any],
                  let peers = dict["peers"] as? [[String: Any]] else { return }

            for peer in peers {
                guard let socketId = peer["socketId"] as? String,
                      let username = peer["username"] as? String else { continue }
                VoiceChatManager.shared.connectToPeer(socketId, username: username)
            }
        }

        // New peer joined — log only (they will initiate from their side via voicePeerList)
        socket.on(SocketEvents.Server.voicePeerJoined) { data, _ in
            guard let dict = data.first as? [String: Any],
                  let socketId = dict["socketId"] as? String,
                  let username = dict["username"] as? String else { return }
            print("[Voice] Peer joined: \(socketId) \(username)")
        }

        // Peer left
        socket.on(SocketEvents.Server.voicePeerLeft) { data, _ in
            guard let dict = data.first as? [String: Any],
                  let socketId = dict["socketId"] as? String else { return }
            VoiceChatManager.shared.removePeer(socketId)
        }

        // SDP offer from a peer
        socket.on(SocketEvents.Server.voiceOffer) { data, _ in
            guard let dict = data.first as? [String: Any],
                  let fromSocketId = dict["fromSocketId"] as? String,
                  let offerDict = dict["offer"] as? [String: Any],
                  let sdpString = offerDict["sdp"] as? String,
                  let typeString = offerDict["type"] as? String,
                  let sdpType = RTCSdpType(from: typeString) else { return }

            let username = dict["username"] as? String ?? "Unknown"
            let sdp = RTCSessionDescription(type: sdpType, sdp: sdpString)
            VoiceChatManager.shared.handleOffer(fromSocketId: fromSocketId, offer: sdp, username: username)
        }

        // SDP answer from a peer
        socket.on(SocketEvents.Server.voiceAnswer) { data, _ in
            guard let dict = data.first as? [String: Any],
                  let fromSocketId = dict["fromSocketId"] as? String,
                  let answerDict = dict["answer"] as? [String: Any],
                  let sdpString = answerDict["sdp"] as? String,
                  let typeString = answerDict["type"] as? String,
                  let sdpType = RTCSdpType(from: typeString) else { return }

            let sdp = RTCSessionDescription(type: sdpType, sdp: sdpString)
            VoiceChatManager.shared.handleAnswer(fromSocketId: fromSocketId, answer: sdp)
        }

        // ICE candidate from a peer
        socket.on(SocketEvents.Server.voiceIceCandidate) { data, _ in
            guard let dict = data.first as? [String: Any],
                  let fromSocketId = dict["fromSocketId"] as? String,
                  let candidateDict = dict["candidate"] as? [String: Any],
                  let candidateString = candidateDict["candidate"] as? String,
                  let sdpMLineIndex = candidateDict["sdpMLineIndex"] as? Int32 else { return }

            let sdpMid = candidateDict["sdpMid"] as? String
            let candidate = RTCIceCandidate(sdp: candidateString, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
            VoiceChatManager.shared.handleIceCandidate(fromSocketId: fromSocketId, candidate: candidate)
        }
    }
}
