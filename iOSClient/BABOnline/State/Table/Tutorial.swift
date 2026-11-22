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
//    log row "Tutorial: <text>" (the log's first tutorial row ends " (only you see this)":
//    TableReducer.tutorialNote). Not tied to the turn: up until closed, the
//    next tip, or my own bid or card. ONE TIP CARD AT A TIME (lead 2026-11-19; the stack pushed
//    the advice below the fold): a newer rule tip replaces an older one; VoiceOver hears each
//    once. The welcome (T.welcome) is never a card (below).
//  - assistHint {source 'tutorial', kind 'status'}: the private reply to /tutorial (a /help status).
//  - s2c assistState {tutorial, auto, uses, freeUses, assisted, unlimited?}: on every change and
//    after a rejoin; the snapshot's viewer.assist.tutorial / auto after a relaunch. My seat has
//    the tutorial's switch all game, on or off: the round corner button under the log's
//    (TutorialCornerButton), the iPhone Duo's vertical bar item there. Turning it on asks first
//    where that makes the game bot-assisted for me (`needsConfirm`, owner 2026-11-21). The
//    welcome tip is no card on iOS: its row goes to the log (TableReducer.tutorialTip), never
//    announced, with iOS's own words (`hiddenWelcomeText`).
//
// Commands go as chat lines (no c2s of their own): /tutorial (toggle), /tutorial on|off (the
// switch), and, typed only (iOS draws no welcome card since build 29), /tutorial keep and
// /tutorial close (the web's welcome buttons; close ends an auto-start's "pending" account).
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
    static let closeCommand = "/tutorial close"
    /// The words after /tutorial the server knows (a typed line keeps them).
    static let arguments = ["on", "off", "keep", "close"]
    /// The welcome tip's id (never a card on iOS: its row only).
    static let welcomeId = "T.welcome"
    /// The welcome's actions this build decodes (assistHint.actions; it draws no welcome card).
    static let knownActions = ["keep", "off"]

    /// The chat command list's line for /tutorial.
    static let describeOff = "Tutorial: tips and advice every turn"
    static let describeOn = "Turn off the tutorial"
    static func commandDescription(on: Bool) -> String { on ? describeOn : describeOff }

    /// The chip over the table while it is on, and its switch (VoiceOver: "Tutorial", "On").
    static let chipText = "Tutorial on"
    static let chipLabel = "Tutorial"
    static let chipHint = "Turns off the tutorial's tips and advice. /help still works any time."
    /// The vertical bar's switch while the tutorial is off (GameContainerView.tutorialBarToggle).
    static let barOffText = "Tutorial off"
    static let barOnHint = "Turns on tips and advice for every turn."
    /// The alert before the switch turns it on where that makes the game bot-assisted for me
    /// (the server's words: "a win goes in your bot-game stats, a loss or tie stays in your human stats").
    static let confirmTitle = "Turn on the tutorial?"
    static let confirmMessage = "You'll get tips and advice on every turn. This game will count as bot-assisted for you: a win goes in your bot-game stats, a loss or tie stays in your human stats."
    static let confirmButton = "Turn on"
    static let confirmCancel = "Cancel"

    /// The switch asks before turning it on: the server's /tutorial on makes the game
    /// bot-assisted for me (tutorialEver), unless it already is (the server's `assisted`: more
    /// than 3 counted /help uses, or the tutorial on earlier) or the game has a native bot seat
    /// (its stats are bot-game stats anyway, and players see nothing about bot-assisted there:
    /// AssistRules.isFreeHelpGame).
    static func needsConfirm(_ s: TableState) -> Bool {
        !AssistRules.isFreeHelpGame(s) && s.table.assistUses?.assisted != true
    }
    /// The welcome's row in the log on iOS, where it is no card (TableReducer.tutorialTip): the
    /// server's text names the card's Turn off, which iOS does not draw; the switch is the cap.
    static let hiddenWelcomeText = "Tips will appear above your cards. Only you see them. Close one with \u{00D7}, or tap the graduation cap to stop them."
    /// A tip's close button.
    static let closeLabel = "Close tip"

    /// The private log rows' label for what the tutorial says (tips and its status replies;
    /// /help's own rows keep "Help").
    static let rowLabel = "Tutorial"

    /// The note on a private row's end: /help's rows always, the tutorial's on a log's first
    /// row only (owner 2026-11-19: once is enough; TableReducer.tutorialNote).
    static let privateNote = " (only you see this)"

    /// The dim private log row of a tip (never sent): "Tutorial: <text>", plus " (only you see
    /// this)" with `note`; the title when a tip has no text. Every tip gets one, shown as a card or not.
    static func logLine(_ h: AssistHint, note: Bool = true) -> String {
        "\(rowLabel): \(h.reasons.first ?? h.headline)\(note ? privateNote : "")"
    }

    /// What VoiceOver hears, once per tip: "Tip: Trump. Trump this hand is hearts ♥. ...".
    static func announcement(_ h: AssistHint) -> String {
        func end(_ s: String) -> String { [".", "!", "?"].contains(where: s.hasSuffix) ? s : s + "." }
        var parts = ["Tip: \(end(h.headline))"]
        if let text = h.reasons.first { parts.append(end(text)) }
        return parts.joined(separator: " ")
    }

    // A watched seat's rule tip (the over-the-shoulder view; AssistRules "A watched seat's
    // hint"): the card names whose hand it is, "Alice's tip"; its × only takes it down.

    /// The heading's words after the name: "Alice" + "'s tip".
    static let watchedSuffix = "'s tip"

    /// "Alice's tip" (nil for a blank name).
    static func watchedHeading(_ name: String?) -> String? {
        AssistRules.watchedHeadingName(name).map { $0 + watchedSuffix }
    }

    /// The tip card's VoiceOver label: "Tip for Alice" ("Tip" for a blank name).
    static func watchedLabel(_ name: String?) -> String {
        AssistRules.watchedHeadingName(name).map { "Tip for \($0)" } ?? "Tip"
    }

    /// What VoiceOver hears, once per watched tip: "Tip for Alice: Trump. Trump this hand is ...".
    static func watchedAnnouncement(_ h: AssistHint, name: String?) -> String {
        "\(watchedLabel(name)): " + announcement(h).dropFirst("Tip: ".count)
    }

    /// The same tip again (a welcome re-sent after a rejoin, a restated hand score): one row and
    /// one announcement only.
    static func seenKey(_ h: AssistHint) -> String { "\(h.tipId ?? "-")|\(h.reasons.first ?? h.headline)" }

    /// The welcome tip (its row only on iOS).
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
