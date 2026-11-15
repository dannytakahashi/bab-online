import Foundation

/// When the reducer's sounds play: the reducer says what happened, this spaces what arrives
/// together. The server sends a hand's handComplete, the next gameStart and its updateTurn in
/// one tick (the last hand's gameEnd with its handComplete), and a turn in the same tick as the
/// card or trick that passed it. Played as they come, the verdict is lost under the shuffle
/// and the chime under the card. As the web client (client/src/audio/tableSounds.js):
/// - made / set plays at once; a deal or the game end in the next `afterHandEnd` waits for it
/// - my turn's chime comes `turnDelay` after its event (after a deal: when the deal's
///   `afterDeal` is up), and not at all if the choice is no longer mine by then
/// - an over-trump's accent lands `overTrumpDelay` after the card's sound
/// Anything still waiting is dropped when a snapshot resets the scene or the game changes.
@MainActor
final class TableSoundCues {
    static let turnDelay: TimeInterval = 0.25
    static let afterHandEnd: TimeInterval = 0.5
    static let afterDeal: TimeInterval = 0.5
    static let overTrumpDelay: TimeInterval = 0.09

    private let clock: AckClock
    private let sounds: SoundPlaying
    private let isMyChoice: @MainActor () -> Bool
    /// Changes when a snapshot resets the scene or the table leaves the game.
    private let epoch: @MainActor () -> String

    private var since = ""
    private var handEndHold: AckCancellable?
    private var dealHold: AckCancellable?
    private var heldDeal = false
    private var heldGameEnd = false
    private var turnWaits = false
    private var turnTimer: AckCancellable?
    private var accents: [AckCancellable] = []

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
            if handEndHold != nil { heldDeal = true } else { playDeal() }
        case .gameEnd:
            turnWaits = false
            turnTimer?.cancel()
            turnTimer = nil
            if handEndHold != nil { heldGameEnd = true } else { sounds.play(.gameEnd) }
        case .turn:
            if handEndHold != nil || dealHold != nil {
                turnWaits = true
            } else if turnTimer == nil {
                turnTimer = after(Self.turnDelay) { $0.turnTimer = nil; $0.playTurn() }
            }
        case .overTrump:
            accents.append(after(Self.overTrumpDelay) { $0.sounds.play(.overTrump) })
        case .card, .trick, .trickOurs:
            sounds.play(kind)
        }
    }

    private func releaseHandEnd() {
        handEndHold = nil
        if heldGameEnd { heldGameEnd = false; sounds.play(.gameEnd) }
        if heldDeal { heldDeal = false; playDeal(); return }
        if turnWaits { turnWaits = false; playTurn() }
    }

    private func playDeal() {
        sounds.play(.deal)
        dealHold?.cancel()
        dealHold = after(Self.afterDeal) { s in
            s.dealHold = nil
            if s.turnWaits { s.turnWaits = false; s.playTurn() }
        }
    }

    /// The choice may be gone (a quick bid, a snapshot): then the chime is not news.
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
        for t in [handEndHold, dealHold, turnTimer].compactMap({ $0 }) + accents { t.cancel() }
        handEndHold = nil
        dealHold = nil
        turnTimer = nil
        accents = []
        heldDeal = false
        heldGameEnd = false
        turnWaits = false
    }
}
