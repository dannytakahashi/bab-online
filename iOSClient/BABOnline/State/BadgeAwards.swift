import Foundation
import Combine

/// The "badge earned" toast's queue (iOS 1.2.7 (41); the web's main.js onBadgesAwarded and
/// ui/kit/toast.js `art`). s2c `badgesAwarded {gameId, badges}` comes privately, after the
/// game's stats are written (so shortly after gameEnd, over the score screen), only because
/// this build's clientHello carries the cap `badges`. Each award is one toast: the badges'
/// pictures (at most `Badges.toastArtMax`) and the web's words ("Badge earned: Felted" /
/// "Badges earned: Felted, Hammer Time"). The web's toast kit lets a newer success toast replace
/// the one on screen; here every award waits its turn instead, so none is lost. A badge
/// already toasted in this run is never toasted again (the server sends each once; a repeat
/// would be a replay). Up `visibleSeconds`, a tap dismisses it and the next one shows.
///
/// The toast shows where the server-error and connection toasts do (the top centre), so it
/// waits while one of them is up (`cover`), and then shows for its full time. VoiceOver hears
/// its words once, when it first shows. Main thread only.
final class BadgeAwards: ObservableObject {
    static let shared = BadgeAwards()

    struct Toast: Equatable, Identifiable {
        let id: Int
        let gameId: String
        let badges: [EarnedBadge]
        /// The web's words (Badges.earnedText).
        let text: String
        /// The pictures shown: the first `Badges.toastArtMax` badges (the words name every one).
        var art: [EarnedBadge] { Array(badges.prefix(Badges.toastArtMax)) }
    }

    /// What can sit in the toast's spot (ServerErrorToast's notice, the connection pill).
    enum Cover: Hashable { case notice, connection }

    /// How long one toast stays up (the web's BADGE_TOAST_MS, 8 s: a badge is rare news).
    static var visibleSeconds: TimeInterval = 8
    /// At most this many awards wait behind the one showing (more are dropped, oldest kept).
    static let maxWaiting = 8

    /// The award at the head of the queue (shown unless something covers the spot).
    @Published private(set) var current: Toast?
    @Published private(set) var covers: Set<Cover> = []
    /// The awards waiting their turn, in arrival order.
    private(set) var waiting: [Toast] = []

    /// The toast on screen now.
    var shown: Toast? { covers.isEmpty ? current : nil }

    /// Runs `body` after a delay (tests replace it to step time by hand).
    var schedule: (TimeInterval, @escaping () -> Void) -> Void = { delay, body in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: body)
    }
    /// Says the toast's words to VoiceOver (tests record them).
    var announce: (String) -> Void = { A11y.announce($0) }

    private var serial = 0
    private var toasted = Set<String>()
    private var announcedId: Int?
    /// Bumped on every show, cover, dismissal and reset: a timer from before does nothing.
    private var timerToken = 0

    /// s2c badgesAwarded, as the wire sends it. False when there is nothing to show (no
    /// badges worth drawing, or all of them already toasted).
    @discardableResult
    func receive(_ dict: [String: Any]) -> Bool {
        let gameId = dict["gameId"] as? String ?? ""
        return enqueue(gameId: gameId, badges: Badges.clean(dict["badges"]))
    }

    /// One award's toast, after the ones waiting.
    @discardableResult
    func enqueue(gameId: String, badges: [EarnedBadge]) -> Bool {
        let fresh = badges.filter { !toasted.contains($0.id) }
        guard !fresh.isEmpty else { return false }
        toasted.formUnion(fresh.map(\.id))
        serial += 1
        let toast = Toast(id: serial, gameId: gameId, badges: fresh, text: Badges.earnedText(fresh))
        if current == nil {
            current = toast
            arm()
        } else if waiting.count < Self.maxWaiting {
            waiting.append(toast)
        }
        return true
    }

    /// A tap, or its time is up: the next award shows.
    func dismiss() {
        timerToken += 1
        current = waiting.isEmpty ? nil : waiting.removeFirst()
        arm()
    }

    /// Another toast takes the spot (`covering`) or leaves it. A covered toast hides and its
    /// time stops; uncovered, it shows for its full time again (announced only once).
    func cover(_ cover: Cover, _ covering: Bool) {
        if covering {
            guard covers.insert(cover).inserted else { return }
            timerToken += 1
        } else {
            guard covers.remove(cover) != nil else { return }
            arm()
        }
    }

    /// Signed out: nothing waits, nothing shows, and the next account's badges toast afresh.
    func reset() {
        timerToken += 1
        current = nil
        waiting = []
        toasted = []
        announcedId = nil
    }

    /// Starts the shown toast's time and says it once.
    private func arm() {
        guard let toast = shown else { return }
        timerToken += 1
        let token = timerToken
        if announcedId != toast.id {
            announcedId = toast.id
            announce(toast.text)
        }
        schedule(Self.visibleSeconds) { [weak self] in
            guard let self, self.timerToken == token, self.current?.id == toast.id else { return }
            self.dismiss()
        }
    }
}
