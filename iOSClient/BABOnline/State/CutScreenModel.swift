import Foundation
import Combine
import CoreGraphics

/// What the cut's screen adds to the cut's state (CutState, TournamentState.cut): my draw on its
/// way, the verdict's wait while the cards turn over, the intro's clock, the reshuffle's flying
/// backs, the winner's moment, and the sounds, haptics and VoiceOver announcements that go with
/// each change (the web's CutForABuck.js update / scheduleVerdict / renderWinner). One per lobby
/// screen (TournamentLobbyView's @StateObject), shared by both halves of a tabletop layout.
/// Timers, sounds and the clock are injected (CutForABuckTests).
@MainActor
final class CutScreenModel: ObservableObject {
    enum Haptic { case light, warning, success }

    /// Animation timings (spec section 6 "Timing"; the web's TIMING).
    enum Timing {
        static let lift: TimeInterval = 0.12
        static let flight: TimeInterval = 0.35
        static let flipDelay: TimeInterval = 0.3
        static let flip: TimeInterval = 0.4
        static let flipStagger: TimeInterval = 0.04
        static let verdict: TimeInterval = 1.2
        static let reducedVerdict: TimeInterval = 0.3
        static let winnerGlide: TimeInterval = 0.7
        static let reshuffle: TimeInterval = 0.55
        /// The reminder before my auto-draw.
        static let reminder: TimeInterval = 5
    }

    /// The reveal whose verdict shows (the out players dim, the losing card's outline).
    @Published private(set) var verdictRound: Int?
    /// The round I sent my draw in (no second emit).
    @Published private(set) var sentRound: Int?
    /// The round I tapped in after the server drew for me (`CutState.canSayBack`).
    @Published private(set) var backSentRound: Int?
    /// The intro's start (nil: none playing).
    @Published private(set) var introStart: Date?
    /// How long the last intro ran before it ended (nil: none ended yet; the DEBUG probe
    /// `cut.introCheck`): its full length, unless something cut it short.
    @Published private(set) var lastIntroLength: TimeInterval?
    /// The reshuffle: each player's cards flying back to the deck (count), until they land.
    @Published private(set) var ghosts: [String: Int] = [:]
    @Published private(set) var ghostSeq = 0
    /// The winner shown centre stage (after the last verdict).
    @Published private(set) var winnerShown: String?
    /// Where my drawn card starts its flight (the touched card of the fan, stage points).
    @Published var myFlightFrom: CGPoint?

    var me: String?
    var spectator = false
    var reduceMotion = false

    var play: (SoundKind) -> Void = { _ in }
    var haptic: (Haptic) -> Void = { _ in }
    /// (text, urgent): one VoiceOver announcement.
    var announce: (String, Bool) -> Void = { _, _ in }
    var send: (Int, Int?) -> Void = { _, _ in }
    var schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, fn in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { fn() } }
    }
    var now: () -> Date = Date.init
    /// The intro's wait (a cancelled wait throws: the intro is not ended then).
    var sleep: @MainActor (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }

    private var current: CutState?
    private var reminded: Int?
    private var attached = false

    init() {}

    // MARK: - Questions

    /// The reveal's cards are still turning: the verdict waits.
    func verdictPending(_ s: CutState?) -> Bool {
        guard let r = s?.lastReveal?.round else { return false }
        return verdictRound != r
    }

    func introPlaying(at date: Date? = nil) -> Bool {
        guard let start = introStart else { return false }
        return !CutIntro(reduceMotion: reduceMotion).isDone((date ?? now()).timeIntervalSince(start))
    }

    /// I may draw now (the round open, mine not drawn or sent, no intro playing).
    func canDraw(_ s: CutState?) -> Bool {
        guard let s, s.canDraw(me: me, spectator: spectator) else { return false }
        return sentRound != s.round && !introPlaying()
    }

    func canSayBack(_ s: CutState?) -> Bool {
        guard let s, s.canSayBack(me: me, spectator: spectator) else { return false }
        return backSentRound != s.round
    }

    /// The status lines, as the view shows them: the verdict waits for the cards.
    func status(_ s: CutState?) -> CutCopy.Status {
        var st = CutCopy.status(s, me: me, spectator: spectator, now: now())
        guard let s else { return st }
        if (s.stage == .reveal || s.stage == .winner) && verdictPending(s) {
            st = CutCopy.Status(main: CutCopy.turning, sub: CutCopy.rules)
        } else if s.stage == .winner, s.winner != nil, winnerShown != s.winner {
            st.main = CutCopy.verdictLines(s.lastReveal, me: me).first ?? st.main
        }
        return st
    }

    // MARK: - Changes

    /// The screen came up with the cut as it stands: no animation for what happened before, the
    /// intro if the gather has more than `CutIntro.minGatherLeft` to go.
    func attach(_ s: CutState?) {
        attached = true
        current = s
        verdictRound = s?.lastReveal?.round
        winnerShown = s?.stage == .winner && !verdictPending(s) ? s?.winner : nil
        if let s, s.stage == .gather, let end = s.endsAt, end.timeIntervalSince(now()) > CutIntro.minGatherLeft {
            introStart = now()
        } else {
            introStart = nil
        }
        armReminder(s)
    }

    /// The cut's state changed (TournamentState.cut, any event).
    func update(old: CutState?, new: CutState?) {
        current = new
        guard let s = new else {
            introStart = nil
            winnerShown = nil
            return
        }
        guard s.seq != old?.seq || old == nil else { return }
        switch s.last {
        case .restore:
            verdictRound = s.lastReveal?.round
            winnerShown = s.stage == .winner ? s.winner : nil
        case .start:
            verdictRound = nil
            sentRound = nil
            backSentRound = nil
            winnerShown = nil
            if attached { introStart = now() }
        case let .round(r, reshuffled):
            if sentRound != r { sentRound = nil }
            myFlightFrom = nil
            if reshuffled {
                announce(CutCopy.reshuffle, false)
                let backs = (old?.table ?? [:]).mapValues(\.count).filter { $0.value > 0 }
                if !backs.isEmpty && !reduceMotion {
                    ghosts = backs
                    ghostSeq += 1
                    let seq = ghostSeq
                    schedule(Timing.reshuffle + 0.1) { [weak self] in
                        if self?.ghostSeq == seq { self?.ghosts = [:] }
                    }
                }
            }
            armReminder(s)
        case let .drew(u, _, _):
            if u != me { play(.draw) }
        case .left:
            break
        case let .reveal(r):
            play(.card)
            let wait = reduceMotion ? Timing.reducedVerdict : Timing.verdict
            schedule(wait) { [weak self] in self?.showVerdict(r) }
        case .winner:
            // the round cap's pick (no reveal pending): at once; else after the last verdict
            if !verdictPending(s) { showWinner(s) }
        }
    }

    private func showVerdict(_ round: Int) {
        guard let s = current, let reveal = s.lastReveal, reveal.round == round, verdictRound != round else { return }
        verdictRound = round
        if reveal.eliminated.contains(where: { $0 == me }) {
            play(.gameLost)
            haptic(.warning)
        } else if !reveal.eliminated.isEmpty {
            play(.set)
        }
        announce(CutCopy.revealAnnouncement(reveal, me: me), false)
        if s.stage == .winner, s.winner != nil { showWinner(s) }
    }

    private func showWinner(_ s: CutState) {
        guard let w = s.winner, winnerShown != w else { return }
        winnerShown = w
        play(w == me ? .gameWon : .gameEnd)
        if w == me { haptic(.success) }
        announce(CutCopy.winnerLine(w, me: me), true)
    }

    /// The reminder 5 s before my auto-draw (the table's turn chime), once a round.
    private func armReminder(_ s: CutState?) {
        guard let s, s.stage == .drawing, let end = s.endsAt, reminded != s.round else { return }
        let round = s.round
        schedule(max(0, end.timeIntervalSince(now()) - Timing.reminder)) { [weak self] in
            guard let self, let c = self.current, c.round == round, self.reminded != round, self.canDraw(c) else { return }
            self.reminded = round
            self.play(.turn)
        }
    }

    // MARK: - My draw

    /// A tap on the deck (slot: the touched card's, nil a random one), or the list's / VoiceOver's
    /// Draw a card. Returns the slot sent as my local draw (nil: nothing sent as a draw). After the
    /// server drew for me, the tap still says I am back (`canSayBack`).
    @discardableResult
    func draw(_ s: CutState?, slot: Int?) -> Bool {
        guard let s else { return false }
        if canDraw(s) {
            sentRound = s.round
            send(s.round, slot)
            play(.draw)
            haptic(.light)
            return true
        }
        if canSayBack(s) {
            backSentRound = s.round
            send(s.round, nil)
            haptic(.light)
        }
        return false
    }

    /// Plays the intro that started at `introStart` to its end (CutStageView's task, keyed by
    /// `introStart`), then ends it. A cancelled wait ends nothing: SwiftUI cancels the task
    /// whenever the stage view is rebuilt or leaves (it is rebuilt as the lobby screen comes up),
    /// and the stage view that replaces it plays on from the same start. Before this, `try?`
    /// swallowed the cancellation and ended the intro in its first frames, so it never showed.
    func playIntro() async {
        guard let start = introStart else { return }
        let left = CutIntro(reduceMotion: reduceMotion).finish - now().timeIntervalSince(start)
        if left > 0 {
            do { try await sleep(left) } catch { return }
            if Task.isCancelled { return }
        }
        guard introStart == start else { return }
        endIntro()
    }

    /// The intro has ended (or never started).
    func endIntro() {
        if let start = introStart { lastIntroLength = now().timeIntervalSince(start) }
        introStart = nil
    }
}
