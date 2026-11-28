#if DEBUG
import Foundation

/// Live checks only (Debug builds, `LiveSfuVoiceTests`): `-sfuRelay 127.0.0.1:<port>` routes the
/// SFU session's media through a local UDP relay the run controls (scripts/voice-sfu-ios-live.mjs
/// starts it), so the run can cut the simulator's network to the SFU and bring it back, or move it
/// to a new source port (a NAT rebinding), without touching the Mac's network. The SFU's UDP IPv4
/// candidates in every remote description are rewritten to the relay (every other candidate is
/// dropped, so media cannot bypass it) and the real address is posted to the relay's control port
/// (`-sfuRelayCtl <port>`). The spike did the same in its web pages (spike/sfu/reconnect).
enum SfuRelay {
    static func rewriter() -> (@MainActor (String) -> String)? {
        guard let relay = UserDefaults.standard.string(forKey: "sfuRelay"),
              let colon = relay.lastIndex(of: ":"), relay.hasPrefix("127.0.0.1:"),
              let relayPort = Int(relay[relay.index(after: colon)...]) else { return nil }
        let ctl = UserDefaults.standard.integer(forKey: "sfuRelayCtl")
        return { sdp in rewrite(sdp, relayPort: relayPort, ctlPort: ctl) }
    }

    static func rewrite(_ sdp: String, relayPort: Int, ctlPort: Int) -> String {
        var target: String?
        let lines = sdp.components(separatedBy: "\r\n").compactMap { line -> String? in
            guard line.hasPrefix("a=candidate:") else { return line }
            var parts = line.split(separator: " ").map(String.init)
            // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
            guard parts.count >= 8, parts[2].lowercased() == "udp", parts[4].contains("."), !parts[4].contains(":") else { return nil }
            if target == nil { target = "\(parts[4]):\(parts[5])" }
            parts[4] = "127.0.0.1"
            parts[5] = String(relayPort)
            return parts.joined(separator: " ")
        }
        if let target, ctlPort > 0, let url = URL(string: "http://127.0.0.1:\(ctlPort)/target") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.httpBody = Data(target.utf8)
            URLSession.shared.dataTask(with: req).resume()
            print("[VoiceSFU] relay: SFU media through 127.0.0.1:\(relayPort)")
        }
        return lines.joined(separator: "\r\n")
    }
}
#endif
