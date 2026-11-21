#if DEBUG
import Foundation

/// The tutorial in fixture mode (TutorialUITests; no server; State/Table/Tutorial.swift).
/// `-uiTutorial YES`: the tutorial is on as an auto-start leaves it (assistState {tutorial, auto}),
/// and 1.5 s after launch the server's pushes for this turn come in its order: the welcome tip
/// (T.welcome, Keep / Turn off), a rule tip for the moment (my bid turn: T.bid "Bidding"; my
/// play turn following a suit: T.follow "Following suit"; else T.trump), and on my own bid or
/// play turn the advice (the /help answer with source `tutorial`, never counted).
/// `-uiTutorialOff YES`: off at the start (assistState off, no pushes), its commands still answered
/// (the iPhone Duo's bar switch turning it on). `-uiTutorialWelcome NO`: no welcome (it was kept
/// in an earlier session). The chat's
/// /tutorial, /tutorial on, /tutorial off, /tutorial keep and /tutorial close are answered as the server does
/// (assistState, "Tips off. /help still works any time."). Every line shows in "fixture.sent";
/// the chip in the probe "table.tutorial".
extension UIFixture {
    static let tutorialMode: Bool = isActive && UserDefaults.standard.bool(forKey: "uiTutorial")
    static let tutorialWelcome: Bool = UserDefaults.standard.string(forKey: "uiTutorialWelcome")?.uppercased() != "NO"
    static let tutorialStartsOff: Bool = UserDefaults.standard.bool(forKey: "uiTutorialOff")

    @MainActor private static weak var tutorialStore: GameState?
    @MainActor private static var tutorialOnNow = false

    /// The server's texts (server/game/assist/curriculum.js; docs/claude/assist.md, The tutorial).
    static let welcomeText = "Tips will appear above your cards. Only you see them. Close one with \u{00D7}, or choose Turn off to stop them."
    static let tipsOffText = "Tips off. /help still works any time."

    @MainActor
    static func seedTutorial(_ store: GameState, auth: AuthState) {
        guard tutorialMode else { return }
        tutorialStore = store
        auth.isAuthenticated = true  // the toast layer
        if tutorialStartsOff { setTutorial(false); return }
        setTutorial(true, auto: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { MainActor.assumeIsolated { pushTurn() } }
    }

    /// assistState as the server sends it.
    @MainActor
    static func setTutorial(_ on: Bool, auto: Bool = false) {
        guard let store = tutorialStore else { return }
        tutorialOnNow = on
        _ = store.apply(serverEvent: "assistState", payload: [[
            "tutorial": on, "auto": on && auto, "uses": 0, "freeUses": 3, "assisted": false,
        ] as [String: Any]])
    }

    /// The pushes of this turn, in the server's order (welcome, rule tip, advice).
    @MainActor
    static func pushTurn() {
        guard let store = tutorialStore, tutorialOnNow else { return }
        let s = store.state
        if tutorialWelcome { push(store, tip(s, "T.welcome", "Tutorial on", welcomeText, actions: ["keep", "off"])) }
        push(store, ruleTip(s))
        if case .choosing = s.myTurn {
            var advice = assistPayload(s, uses: 0, free: false)
            advice["source"] = "tutorial"
            advice["counted"] = false
            advice.removeValue(forKey: "note")
            if advice["kind"] as? String != "status" { push(store, advice) }
        }
    }

    @MainActor
    private static func push(_ store: GameState, _ p: [String: Any]) {
        _ = store.apply(serverEvent: "assistHint", payload: [p])
    }

    private static func tip(_ s: TableState, _ id: String, _ title: String, _ text: String, actions: [String]? = nil) -> [String: Any] {
        let dealSeq = s.table.deal?.dealSeq ?? 1
        let stage = s.table.phase.kind == .playing ? "PLAYING" : "BIDDING"
        var p: [String: Any] = [
            "v": 1, "source": "tutorial", "kind": "tip", "turnKey": "\(dealSeq)|\(stage)|\(s.table.phase.turn ?? 0)|0|0",
            "headline": title, "reasons": [text], "uses": 0, "freeUses": 3, "assisted": false, "counted": false, "tipId": id,
        ]
        if let actions { p["actions"] = actions }
        return p
    }

    /// The rule tip the curriculum picks first for this moment (names from the table).
    static func ruleTip(_ s: TableState) -> [String: Any] {
        let me = max(s.table.viewer.position ?? 1, 1)
        let partner = s.players.name(Positions.team(me))
        switch s.myTurn {
        case .choosing(.bid):
            return tip(s, "T.bid", "Bidding",
                       "Bid how many tricks you expect to win. Your bid adds to the bid of \(partner) (your partner): together you must win at least that many.")
        case .choosing(.play):
            if case .playing(let p) = s.table.phase, let led = p.trick.first?.card.suit, led != .joker {
                let name = led.rawValue
                let one = String(name.dropLast())
                return tip(s, "T.follow", "Following suit", "\(name.prefix(1).uppercased() + name.dropFirst()) were led: you must play a \(one) if you have one.")
            }
        default:
            break
        }
        return tip(s, "T.trump", "Trump",
                   "Trump this hand is hearts \u{2665}. Any heart beats any card of another suit, and the two jokers are the highest trumps.")
    }

    /// A chat line the app sent: /tutorial's commands are answered as the server does.
    static func answerTutorialLater(_ line: String) {
        guard tutorialMode else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { answerTutorial(line) } }
    }

    @MainActor
    static func answerTutorial(_ line: String) {
        guard let store = tutorialStore else { return }
        let word = line.split(separator: " ").dropFirst().first.map(String.init)
        let status = { (text: String) in
            push(store, ["v": 1, "source": "tutorial", "kind": "status", "turnKey": "1|BIDDING|0|0|0", "headline": text,
                         "reasons": [String](), "uses": 0, "freeUses": 3, "assisted": false, "counted": false])
        }
        switch word {
        case nil:
            setTutorial(!tutorialOnNow)
            if !tutorialOnNow { status(tipsOffText) }
        case "on":
            if tutorialOnNow { status("The tutorial is already on.") } else { setTutorial(true) }
        case "off":
            if tutorialOnNow { setTutorial(false); status(tipsOffText) } else { status("The tutorial is already off.") }
        case "keep", "close":
            break  // silent
        default:
            status("Type /tutorial on or /tutorial off.")
        }
    }
}
#endif
