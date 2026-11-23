import Foundation

/// When the reducer's sounds play: the reducer says what happened, this spaces what arrives
/// together. The server sends a hand's handComplete, the next gameStart and its updateTurn in
/// one tick (the last hand's gameEnd with its handComplete), and a turn in the same tick as the
/// card or trick that passed it. Played as they come, the verdict is lost under the shuffle
/// and the chime under the card. As the web client (client/src/audio/tableSounds.js):
/// - made / set plays at once; a deal or the game end in the next `afterHandEnd` waits for it
/// - my turn's chime is a reminder (owner 2026-11-15, "only if the player doesn't play for
///   5s"): it comes `turnIdle` after the turn began (after a deal: counted from when the
///   deal's `afterDeal` is up), and not at all if the choice is no longer mine by then; each
///   new turn (and each deal) restarts the wait, so an old turn's timer never chimes early for
///   the next one
/// - an over-trump's accent lands `overTrumpDelay` after the card's sound
/// - the draw for deal's cards (`draw`) sound at least `drawSpacing` apart: draws that arrive
///   together (the server's 30 s auto-draws, a fast bot draw) are heard one by one, as
///   DrawPhaseView flips a batch (slot i at i * 0.3 + 0.1 s)
/// Anything still waiting is dropped when a snapshot resets the scene or the game changes.
@MainActor
final class TableSoundCues {
    static let turnIdle: TimeInterval = 5.0
    static let afterHandEnd: TimeInterval = 0.5
    static let afterDeal: TimeInterval = 0.5
    static let overTrumpDelay: TimeInterval = 0.09
    static let drawSpacing: TimeInterval = 0.3

    private let clock: AckClock
    private let sounds: SoundPlaying
    private let isMyChoice: @MainActor () -> Bool
    /// Changes when a snapshot resets the scene or the table leaves the game.
    private let epoch: @MainActor () -> String

    private var since = ""
    private var handEndHold: AckCancellable?
    private var dealHold: AckCancellable?
    private var heldDeal = false
    private var heldGameEnd: SoundKind?
    private var turnWaits = false
    private var turnTimer: AckCancellable?
    private var accents: [AckCancellable] = []
    /// The draw spacing: while it runs, later draws wait their turn (a count: the takes rotate).
    private var drawHold: AckCancellable?
    private var drawsWaiting = 0

    init(clock: AckClock, sounds: SoundPlaying, isMyChoice: @escaping @MainActor () -> Bool, epoch: @escaping @MainActor () -> String) {
        self.clock = clock
        self.sounds = sounds
        self.isMyChoice = isMyChoice
        self.epoch = epoch
    }

    func cue(_ kind: SoundKind) {
        if epoch() != since { dropAll(); since = epoch() }
        switch kind {
        case .made, .set, .handEnd:
            sounds.play(kind)
            handEndHold?.cancel()
            handEndHold = after(Self.afterHandEnd) { $0.releaseHandEnd() }
        case .deal:
            cancelTurnTimer()
            if handEndHold != nil { heldDeal = true } else { playDeal() }
        case .gameEnd, .gameLost:
            turnWaits = false
            cancelTurnTimer()
            if handEndHold != nil { heldGameEnd = kind } else { sounds.play(kind) }
        case .turn:
            if handEndHold != nil || dealHold != nil {
                cancelTurnTimer()
                turnWaits = true
            } else {
                startTurnTimer()
            }
        case .overTrump:
            accents.append(after(Self.overTrumpDelay) { $0.sounds.play(.overTrump) })
        case .draw:
            if drawHold != nil { drawsWaiting += 1 } else { playDraw() }
        case .card, .trick, .trickOurs:
            sounds.play(kind)
        }
    }

    /// One draw's card now; the next waiting one `drawSpacing` later.
    private func playDraw() {
        sounds.play(.draw)
        drawHold = after(Self.drawSpacing) { s in
            s.drawHold = nil
            if s.drawsWaiting > 0 { s.drawsWaiting -= 1; s.playDraw() }
        }
    }

    private func releaseHandEnd() {
        handEndHold = nil
        if let end = heldGameEnd { heldGameEnd = nil; sounds.play(end) }
        if heldDeal { heldDeal = false; playDeal(); return }
        if turnWaits { turnWaits = false; startTurnTimer() }
    }

    /// The reminder's wait starts (again) now: one timer, for the turn that just began.
    private func startTurnTimer() {
        cancelTurnTimer()
        turnTimer = after(Self.turnIdle) { $0.turnTimer = nil; $0.playTurn() }
    }

    private func cancelTurnTimer() {
        turnTimer?.cancel()
        turnTimer = nil
    }

    private func playDeal() {
        sounds.play(.deal)
        dealHold?.cancel()
        dealHold = after(Self.afterDeal) { s in
            s.dealHold = nil
            if s.turnWaits { s.turnWaits = false; s.startTurnTimer() }
        }
    }

    /// The choice may be gone (a bid or play within `turnIdle`, a snapshot): then no reminder.
    private func playTurn() {
        if isMyChoice() { sounds.play(.turn) }
    }

    /// A timer that does nothing once the epoch moved on (its sound belongs to another scene).
    private func after(_ s: TimeInterval, _ f: @escaping @MainActor (TableSoundCues) -> Void) -> AckCancellable {
        let at = since
        return clock.after(s) { [weak self] in
            guard let self else { return }
            guard self.epoch() == at else { self.dropAll(); return }
            f(self)
        }
    }

    private func dropAll() {
        for t in [handEndHold, dealHold, turnTimer, drawHold].compactMap({ $0 }) + accents { t.cancel() }
        handEndHold = nil
        dealHold = nil
        drawHold = nil
        drawsWaiting = 0
        turnTimer = nil
        accents = []
        heldDeal = false
        heldGameEnd = nil
        turnWaits = false
    }
}
