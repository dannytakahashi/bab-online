import Foundation

// The tutorial on iOS (2026-11-19, the LEAN scope with the fade-out; server and wire:
// docs/claude/assist.md "The tutorial"; the build after 20). The clientHello cap `tutorial`
// (ServerConfig `ClientHello.caps`) tells the server this build renders:
//
//  - assistHint {source 'tutorial', kind 'bid' | 'card'}: the /help answer pushed on my own
//    non-forced decision while the tutorial is on (from the end of the 2-card hand only for
//    tricky choices). Shown as a /help answer (AssistCardView, the card's or bid's ring), never
//    counted: its footer has no count and it adds no log row (one per turn would flood the log).
//  - assistHint {source 'tutorial', kind 'tip', tipId}: a rule tip (headline = its title,
//    reasons = [its text]) in the neutral TutorialTipView above the answer, with a dim private
//    log row "Tip: <text>". Not tied to the turn: up until closed, the next tip, or my own bid
//    or card. VoiceOver hears each tip once. The welcome (T.welcome, `actions` keep / off) has
//    its own slot with Keep / Turn off, so the first decision's tip and advice never push it away.
//  - assistHint {source 'tutorial', kind 'status'}: the private reply to /tutorial (a /help status).
//  - s2c assistState {tutorial, auto, uses, freeUses, assisted, unlimited?}: on every change and
//    after a rejoin; the snapshot's viewer.assist.tutorial / auto after a relaunch. While on, my
//    seat shows the "Tutorial on" chip (TutorialChipView) with an off switch.
//
// Commands go as chat lines (no c2s of their own): /tutorial (toggle), /tutorial on|off, and
// /tutorial keep (the welcome's Keep or ×: silent; it ends an auto-start's "pending" account).
// Names only in every text (the server's tip texts are linted there).

/// My seat's tutorial as the server last said (assistState, the snapshot's viewer.assist).
struct TutorialStatus: Equatable {
    /// On now (the chip shows).
    var on = false
    /// Turned on by the auto-start in a new account's first game (not by the player).
    var auto = false
}

enum TutorialRules {
    /// The chat command (toggle) and its arguments the client sends.
    static let command = "/tutorial"
    static let onCommand = "/tutorial on"
    static let offCommand = "/tutorial off"
    static let keepCommand = "/tutorial keep"
    /// The words after /tutorial the server knows (a typed line keeps them).
    static let arguments = ["on", "off", "keep"]
    /// The welcome tip's id: its own slot, with Keep / Turn off.
    static let welcomeId = "T.welcome"
    /// The welcome's buttons this build draws (assistHint.actions).
    static let knownActions = ["keep", "off"]

    /// The chat command list's line for /tutorial.
    static let describeOff = "Tutorial: tips and advice every turn"
    static let describeOn = "Turn off the tutorial"
    static func commandDescription(on: Bool) -> String { on ? describeOn : describeOff }

    /// The chip over the table while it is on, and its switch (VoiceOver: "Tutorial", "On").
    static let chipText = "Tutorial on"
    static let chipLabel = "Tutorial"
    static let chipHint = "Turns off the tutorial's tips and advice. /help still works any time."
    /// The welcome's buttons and a tip's close button.
    static let keepLabel = "Keep"
    static let offLabel = "Turn off"
    static let closeLabel = "Close tip"

    /// The dim private log row of a tip (never sent): "Tip: <text>" (the server's own line for a
    /// client without the cap), the title when a tip has no text.
    static func logLine(_ h: AssistHint) -> String { "Tip: \(h.reasons.first ?? h.headline)" }

    /// What VoiceOver hears, once per tip: "Tip: Trump. Trump this hand is hearts ♥. ...".
    static func announcement(_ h: AssistHint) -> String {
        func end(_ s: String) -> String { [".", "!", "?"].contains(where: s.hasSuffix) ? s : s + "." }
        var parts = ["Tip: \(end(h.headline))"]
        if let text = h.reasons.first { parts.append(end(text)) }
        return parts.joined(separator: " ")
    }

    /// The same tip again (a welcome re-sent after a rejoin, a restated hand score): one row and
    /// one announcement only.
    static func seenKey(_ h: AssistHint) -> String { "\(h.tipId ?? "-")|\(h.reasons.first ?? h.headline)" }

    /// The welcome tip (its own slot, with Keep / Turn off).
    static func isWelcome(_ h: AssistHint) -> Bool { h.kind == .tip && h.tipId == welcomeId }

    /// A typed "/tutorial <word>" (or a unique prefix of /tutorial with a word): what to send.
    /// nil when the line is not /tutorial with an argument.
    static func typedLine(_ line: String, commands: [String]) -> String? {
        let words = line.lowercased().split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard words.count >= 2, words[0].count > 1 else { return nil }
        let first = words[0]
        guard first == command || (command.hasPrefix(first) && commands.filter { $0.hasPrefix(first) } == [command]) else { return nil }
        // any other word gets the server's "Type /tutorial on or /tutorial off."
        return "\(command) \(words[1...].joined(separator: " "))"
    }
}
