import SwiftUI

/// Bidding UI — bottom sheet with bid grid and bore buttons.
///
/// My HSI shows in the bottom row, centred in the gap between the bore button and
/// Submit (owner, 2026-11-12: my seat's row, where HSI usually is, hides under the
/// panel on my bid turn). It is an overlay of that gap, so it never moves or shrinks
/// a button; where the gap is too narrow for it (none of today's sizes) it moves to
/// a header line above the grid instead.
///
/// The bid clock (owner 2026-11-18): once my seat's clock runs, a small countdown
/// (`BidClockPill`) sits on the panel's top edge at its trailing corner, over the felt, so no
/// button, cell or chip moves; at 0 the buttons dim and refuse until the server's bid 0 lands
/// (BidCountdownModel).
struct BidOverlayView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var actions: ActionCoordinator
    /// The table's zoom (TableLayout.zoom; 1 on a phone): the cells and the bottom row grow
    /// with the table's bid band; the type stays Dynamic Type.
    var zoom: CGFloat = 1
    /// The countdown pill's frame in the pane (`BidClockPill.paneSpace`), each time it is laid
    /// out: the /help card keeps its bottom above it while my clock runs (GameContainerView.assistCard).
    var onClockFrame: (CGRect) -> Void = { _ in }
    /// The lightbulb's frame in the pane (`BidClockPill.paneSpace`) while it shows: the
    /// tutorial's tips and chip keep above it (GameContainerView.assistColumn).
    var onAskFrame: (CGRect) -> Void = { _ in }
    /// The lightbulb is the vertical bar's item (the iPhone Duo: GameContainerView.askBarButton),
    /// not on the panel's corner.
    var askInBar = false
    /// The over-the-shoulder view (owner 2026-11-21): the watched seat's bid turn, mirrored
    /// read-only where my own panel goes. The same choices (its hand size, the bores open),
    /// the mirrored advice's ring, its clock; no selection, no Submit, nothing tappable, nothing
    /// sent (the player's own selection is never on the wire). VoiceOver: one element, "Alice is
    /// bidding", the choices as its value.
    var readOnly = false

    @State private var selectedBid: String?
    /// The bottom row's gap between the bore button and Submit, and HSI's width (measured).
    @State private var gapWidth: CGFloat = .infinity
    @State private var hsiWidth: CGFloat = 0

    /// Sent, waiting for bidReceived (or a reject): no second submit.
    private var isSubmitted: Bool { !readOnly && gameState.myTurn.isSubmitted }

    /// My /help answer's bid ("4", "B"): ringed in gold (the web's .bid-button.is-suggested); a
    /// watched seat's mirrored advice when read-only.
    private var suggested: String? {
        guard readOnly else { return gameState.suggestedBid }
        guard let h = gameState.watchedAdvice, h.kind == .bid else { return nil }
        return h.bid
    }

    private var maxBid: Int {
        // the watched seat bids up to its hand size (the deal says it, whatever is shown)
        readOnly ? max(gameState.currentHand, gameState.myCards.count) : gameState.myCards.count
    }

    /// The selection shown (never one while read-only).
    private var shownSelection: String? { readOnly ? nil : selectedBid }

    /// "Alice is bidding" (the read-only sheet's own line and its VoiceOver label).
    private var watchedTitle: String { "\(gameState.watchedName ?? "") is bidding" }

    /// The read-only sheet's VoiceOver value: its choices as words, the suggestion and the clock.
    private func readOnlyValue(_ clock: BidCountdownModel.Display) -> String {
        var parts = ["Choices: " + ((0...maxBid).map(String.init) + availableBoreLevels).joined(separator: ", ")]
        if let s = suggested { parts.append("Suggested: \(s)") }
        if case .seconds(let n, _) = clock { parts.append("\(n) \(n == 1 ? "second" : "seconds") left") }
        return parts.joined(separator: ". ")
    }

    /// Available bore levels based on what's already been bid (BidRules.availableBores)
    private var availableBoreLevels: [String] {
        guard maxBid > 0 else { return [] }
        return BidRules.availableBores(bids: gameState.tempBids)
    }

    /// Every control gets a 44 x 44 pt hit area (HIG): the grid cells are 44 pt
    /// squares with a 40 pt face, so neighbouring faces keep a 4 pt gap; the bore
    /// and Submit row is 40 pt tall with its hit area reaching 2 pt beyond it.
    static let cell: CGFloat = 44
    static let face: CGFloat = 40
    static let rowHeight: CGFloat = 40

    /// Room HSI keeps on each side in the gap.
    static let hsiMargin: CGFloat = Theme.Space.s2

    /// HSI goes in the bottom row's gap when it fits there with `hsiMargin` each side, else in the header.
    static func hsiFitsRow(gap: CGFloat, hsi: CGFloat) -> Bool { hsi + 2 * hsiMargin <= gap + 0.5 }

    private var cellSize: CGFloat { Self.cell * zoom }
    private var faceSize: CGFloat { Self.face * zoom }
    private var rowSize: CGFloat { Self.rowHeight * zoom }

    /// The chip row's model: the bids on the table against this deal's hand size.
    private var bidChips: BidChips {
        BidChips(bids: gameState.bidBook ?? BidBook(), handSize: gameState.currentHand > 0 ? gameState.currentHand : maxBid,
                 viewPosition: gameState.viewPosition,
                 names: ScoreBarView.viewerTeams(position: gameState.watchedSeat ?? gameState.position, spectator: gameState.isPlainSpectator,
                                                 usernames: gameState.players.seats.compactMapValues(\.username)))
    }

    private var hsiInHeader: Bool { gameState.myHSIReading != nil && !Self.hsiFitsRow(gap: gapWidth, hsi: hsiWidth) }

    /// My seat's running bid clock (a seat holder's, never a spectator's or a lazy watcher's);
    /// read-only, the watched seat's (GameState.watchedBidCountdown).
    private var myClock: BidCountdown? {
        if readOnly { return gameState.watchedBidCountdown }
        guard let c = gameState.bidCountdown, c.position == gameState.position, gameState.table.viewer.role == .seat else { return nil }
        return c
    }

    var body: some View {
        // One structure with or without a clock: redrawn 4 times a second while my clock runs
        // (a number is at most 0.25 s late), paused otherwise. Never an if / else on the
        // clock: its two branches would be two identities, so the clock appearing (or a
        // connection drop taking it away) would rebuild the grid and the buttons, losing a
        // touch in progress and VoiceOver's focus.
        let clock = myClock
        TimelineView(.animation(minimumInterval: BidCountdownModel.tick, paused: clock == nil)) { _ in
            let display = clock.map {
                BidCountdownModel.display($0, mine: readOnly || gameState.myTurn == .choosing(.bid), now: gameState.clockNow())
            } ?? .hidden
            // read-only: nothing in it takes a touch; for VoiceOver it is one static element (panel)
            panel(display)
                .allowsHitTesting(!readOnly)
        }
    }

    private func panel(_ clock: BidCountdownModel.Display) -> some View {
        let expired = clock == .expired
        return VStack(spacing: 2) {
            // the web bid sheet's chip row: one chip per trick, the bids so far by team,
            // outlined chips past the hand size for an overbid
            BidChipRow(chips: bidChips, zoom: zoom)
                .padding(.horizontal, Theme.Space.s3)
            if hsiInHeader, let hsi = gameState.myHSIReading {
                HSIBadge(reading: hsi, style: .panel)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, Theme.Space.s2)
            }
            // Fixed-width bid grid: at most 7 cells a row (7 x 44 + padding fits the 340 x 140 bid band)
            let columns = Array(repeating: GridItem(.fixed(cellSize), spacing: 0), count: min(maxBid + 1, 7))

            Group {
            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(0...maxBid, id: \.self) { bid in
                    let bidStr = String(bid)
                    Button(action: { if !readOnly { selectedBid = bidStr } }) {
                        Text("\(bid)")
                            .font(.callout.bold())
                            .frame(width: faceSize, height: faceSize)
                            .background(shownSelection == bidStr ? Theme.primary : Theme.surfaceLight)
                            .foregroundColor(shownSelection == bidStr ? Theme.buttonForeground : Theme.textPrimary)
                            .cornerRadius(Theme.Radius.sm)
                            .modifier(SuggestedBidRing(on: suggested == bidStr, radius: Theme.Radius.sm))
                            .frame(width: cellSize, height: cellSize)
                            .contentShape(Rectangle())
                    }
                    .accessibilityShowsLargeContentViewer()
                    .accessibilityValue(suggested == bidStr ? "Suggested" : "")
                    .accessibilityHidden(readOnly)  // the mirror is one static element (BidPanelAccessibility)
                    .disabled(readOnly)
                }
            }
            .padding(.horizontal, 6)

            HStack(spacing: Theme.Space.s2) {
                // Bore buttons inline with submit
                if !availableBoreLevels.isEmpty {
                    ForEach(availableBoreLevels, id: \.self) { level in
                        Button(action: { if !readOnly { selectedBid = level } }) {
                            Text(level)
                                .font(.caption.bold())
                                .frame(minWidth: cellSize - 4)
                                .padding(.horizontal, Theme.Space.s2)
                                .frame(height: rowSize)
                                .background(shownSelection == level ? Theme.danger : Theme.surfaceLight)
                                .foregroundColor(shownSelection == level ? Theme.dangerForeground : Theme.textPrimary)
                                .cornerRadius(Theme.Radius.sm)
                                .modifier(SuggestedBidRing(on: suggested == level, radius: Theme.Radius.sm))
                                .contentShape(Rectangle().inset(by: -2))
                        }
                        .accessibilityShowsLargeContentViewer()
                        .accessibilityValue(suggested == level ? "Suggested" : "")
                        .accessibilityHidden(readOnly)
                        .disabled(readOnly)
                    }
                }

                // the gap (a Spacer's 8 pt minimum); HSI is an overlay of it, so the buttons never move
                Color.clear
                    .frame(minWidth: 8, maxWidth: .infinity, maxHeight: rowSize)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { gapWidth = $0 }
                    .overlay {
                        if let hsi = gameState.myHSIReading {
                            HSIBadge(reading: hsi, style: .panel)
                                .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { hsiWidth = $0 }
                                .opacity(hsiInHeader ? 0 : 1)
                                .accessibilityHidden(hsiInHeader)
                        }
                    }

                if readOnly {
                    // no Submit: whose turn it is, where Submit would be
                    Text(watchedTitle)
                        .font(.callout.bold())
                        .foregroundColor(Theme.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, Theme.Space.s2)
                        .frame(height: rowSize)
                } else {
                // Submit button
                Button(action: submitBid) {
                    Group {
                        if isSubmitted {
                            ProgressView().tint(Theme.buttonDisabledForeground)
                        } else {
                            Text("Submit")
                        }
                    }
                    .font(.callout.bold())
                    .padding(.horizontal, Theme.Space.s6)
                    .frame(height: rowSize)
                    .background(selectedBid != nil && !isSubmitted ? Theme.buttonBackground : Theme.buttonDisabled)
                    .foregroundColor(selectedBid != nil && !isSubmitted ? Theme.buttonForeground : Theme.buttonDisabledForeground)
                    .cornerRadius(Theme.Radius.md)
                    .contentShape(Rectangle().inset(by: -2))
                }
                .disabled(selectedBid == nil || isSubmitted)
                .accessibilityShowsLargeContentViewer()
                }
            }
            .padding(.horizontal, Theme.Space.s2)
            }
            // the clock ran out: the server's bid 0 is on its way (dimmed, frames unchanged)
            .opacity(expired ? 0.45 : 1)
            .disabled(expired)
        }
        // 2 + 1 with the chip row's 5 + 2: the 8 pt the panel's padding had (the 340 x 140 bid band)
        .padding(.top, 2)
        .padding(.bottom, 1)
        .disabled(isSubmitted)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .fill(Theme.surface.opacity(0.95))
                .elevation(Theme.Elevation.e2)
        )
        // on the panel's top edge (1 pt into its 2 pt top margin, clear of the chip row), over
        // the felt: a zero-height strip at the panel's top holds it by its bottom
        .overlay(alignment: .top) {
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: 0)
                .overlay(alignment: .bottomTrailing) {
                    if case .seconds(let n, let low) = clock {
                        BidClockPill(seconds: n, low: low, zoom: zoom, onFrame: onClockFrame)
                            .padding(.trailing, Theme.Space.s3)
                            .offset(y: 1)
                    }
                }

        }
        .onChange(of: readOnly ? nil : Self.announcement(clock, of: myClock), initial: true) { _, said in
            if let said { AccessibilityNotification.Announcement(said.text).post() }
        }
        .padding(.horizontal, Theme.Space.s2)
        // capped so the panel fits the layout's 340 x 140 bid band
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .modifier(BidPanelAccessibility(readOnly: readOnly, title: watchedTitle, value: readOnlyValue(clock), selected: selectedBid))
        // /help's lightbulb on my bid turn: just above the panel's leading corner, over the felt
        // (the countdown keeps the trailing one); hidden while an answer is up or on its way.
        // Outside the panel's accessibility container, so "bidOverlay" keeps the panel's frame
        .overlay(alignment: .topLeading) {
            if gameState.showsAssistAsk && !askInBar {
                // its frame as drawn (measured on the button itself: read past the padding and the
                // offset, the frame came out 42 pt low, under the lift; TutorialUITests checks it)
                AssistAskButton(size: AssistLayout.askSize, action: askHelp)
                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(BidClockPill.paneSpace)) }) { onAskFrame($0) }
                    .padding(.leading, Theme.Space.s2 + Theme.Space.s1)
                    .offset(y: Self.askLift)
                    .transition(.opacity)
            }
        }
    }

    /// The lightbulb's lift above the panel's top edge (over the felt).
    static let askLift: CGFloat = -Theme.hitTarget + (Theme.hitTarget - AssistLayout.askSize) / 2 - 2

    /// VoiceOver hears the countdown twice per clock: when it appears and when it reaches
    /// `lowAt` (the number itself is not live). Equal by (clock, low) only, so the text of
    /// each new second does not announce again. The same clock is the same seat with the
    /// deadline within `BidCountdownModel.sameClock`: every snapshot carrying the clock (a
    /// rejoin, a gap resync, actionRejected) rebuilds the deadline from its own receipt, which
    /// is a restatement, not a new clock (a resume's top-up moves it by more).
    struct Announcement: Equatable {
        let position: Int
        let deadline: TimeInterval
        let low: Bool
        let text: String
        static func == (a: Self, b: Self) -> Bool {
            a.position == b.position && a.low == b.low && abs(a.deadline - b.deadline) <= BidCountdownModel.sameClock
        }
    }

    static func announcement(_ clock: BidCountdownModel.Display, of countdown: BidCountdown?) -> Announcement? {
        guard let countdown, case .seconds(let n, let low) = clock else { return nil }
        return Announcement(position: countdown.position, deadline: countdown.deadline, low: low, text: BidCountdownModel.announcement(n))
    }

    private func askHelp() {
        #if DEBUG
        let connected = SocketService.shared.isConnected || UIFixture.isActive
        #else
        let connected = SocketService.shared.isConnected
        #endif
        if actions.askHelp(connected: connected) { HapticManager.selection() }
    }

    private func submitBid() {
        // never from the watched seat's mirror (ActionCoordinator.bid refuses a spectator too)
        guard !readOnly, let bid = selectedBid else { return }
        // the countdown reached 0: the server is bidding 0 for me (C2's margin)
        if let c = myClock, BidCountdownModel.display(c, mine: true, now: gameState.clockNow()) == .expired { return }
        if actions.bid(bid) {
            HapticManager.mediumImpact()
            selectedBid = nil
        }
    }
}

/// The panel for VoiceOver: my own a container of its buttons ("bidOverlay"); the watched
/// seat's read-only mirror ONE static element, "Alice is bidding" with its choices as the value
/// ("bidOverlay.watched"): no button inside it can be reached or activated.
private struct BidPanelAccessibility: ViewModifier {
    let readOnly: Bool
    let title: String
    let value: String
    let selected: String?

    func body(content: Content) -> some View {
        if readOnly {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(title)
                .accessibilityValue(value)
                .accessibilityIdentifier("bidOverlay.watched")
        } else {
            content
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("bidOverlay")
                #if DEBUG
                .accessibilityValue(selected ?? "-")  // the fixture UI tests read the selection
                #endif
        }
    }
}

/// The gold ring round the /help answer's bid (the lightbulb's colour), outside the face.
struct SuggestedBidRing: ViewModifier {
    let on: Bool
    let radius: CGFloat

    func body(content: Content) -> some View {
        content.overlay {
            if on {
                RoundedRectangle(cornerRadius: radius + 2)
                    .strokeBorder(Theme.gold, lineWidth: 2)
                    .padding(-2)
                    .shadow(color: Theme.gold.opacity(0.55), radius: 4)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// The bid-total chips (the web BidManager.updateTrickIndicator): one chip per trick of the
/// hand; my team's bids fill from the left in its colour, then the other team's; past the
/// hand size the bids are an overbid and its chips are outlined. A bore counts as the whole
/// hand, each team capped at it (BidTotals). At most `maxChips` chips, as the web.
struct BidChips: Equatable {
    enum Chip: Equatable { case empty, team(Int), over(Int) }
    static let maxChips = 16

    let handSize: Int
    let mine: Int
    let theirs: Int
    let myTeam: Int
    /// The two sides' names as VoiceOver reads them ("ann and cat"; "" while not known): my
    /// team (a spectator's seats 1 and 3) and the other.
    let mineSaid: String
    let theirsSaid: String

    /// `names`: the score bar's sides (`ScoreBarView.viewerTeams`), mine first.
    init(bids: BidBook, handSize: Int, viewPosition: Int,
         names: (team: ScoreBarView.SideNames?, opp: ScoreBarView.SideNames?) = (nil, nil)) {
        let totals = BidTotals.totals(bids, handSize: handSize)
        let rel = totals.relative(to: viewPosition)
        self.handSize = BidTotals.hand(handSize)
        mine = rel.mine
        theirs = rel.theirs
        myTeam = Positions.getTeamNumber(viewPosition)
        mineSaid = ScoreBarView.namesAccessibilityLabel(names.team)
        theirsSaid = ScoreBarView.namesAccessibilityLabel(names.opp)
    }

    var total: Int { mine + theirs }
    /// Tricks bid beyond the hand (0: not an overbid).
    var overbid: Int { max(0, total - handSize) }

    /// Left to right: my team's, the other team's, then empty up to the hand size.
    var chips: [Chip] {
        let count = min(max(total, handSize), Self.maxChips)
        let other = myTeam == 1 ? 2 : 1
        return (0..<count).map { i in
            let team: Int? = i < mine ? myTeam : (i < total ? other : nil)
            guard let team else { return .empty }
            return i >= handSize ? .over(team) : .team(team)
        }
    }

    /// "Bids: ann and cat 3, bob and dan 2, of 7 tricks. Over by 1": the sides by their
    /// players' names, mine first, never "your team" / "opponents" (owner 2026-11-17, as the
    /// web's announcer); while the names are not known only the total, "Bids: 5 of 7 tricks".
    var spoken: String {
        let of = "of \(handSize) \(handSize == 1 ? "trick" : "tricks")"
        var text = mineSaid.isEmpty || theirsSaid.isEmpty
            ? "Bids: \(total) \(of)"
            : "Bids: \(mineSaid) \(mine), \(theirsSaid) \(theirs), \(of)"
        if overbid > 0 { text += ". Over by \(overbid)" }
        return text
    }
}

struct BidChipRow: View {
    let chips: BidChips
    var zoom: CGFloat = 1

    /// The row's height at zoom 1 (BidOverlayView keeps the panel inside the 140 pt bid band).
    static let height: CGFloat = 5
    /// A chip's widest (16 chips of it and their gaps fit the row's 300).
    static let chipWidth: CGFloat = 16

    var body: some View {
        HStack(spacing: 2 * zoom) {
            ForEach(Array(chips.chips.enumerated()), id: \.offset) { _, chip in
                // a chip has a set width (the web's --bid-chip-w): a 1-card hand is one chip, not a bar
                chipView(chip).frame(maxWidth: Self.chipWidth * zoom)
            }
        }
        .frame(height: Self.height * zoom)
        .frame(maxWidth: 300 * zoom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chips.spoken)
        .accessibilityIdentifier("bidChips")
        #if DEBUG
        .accessibilityValue("\(chips.mine)+\(chips.theirs)/\(chips.handSize)")  // the fixture UI tests read the totals
        #endif
    }

    @ViewBuilder
    private func chipView(_ chip: BidChips.Chip) -> some View {
        let shape = Capsule()
        switch chip {
        case .empty:
            shape.fill(Theme.surfaceLight)
        case .team(let team):
            shape.fill(Theme.team(team))
        case .over(let team):
            // an overbid: outlined in the team's colour, not filled
            shape.fill(Theme.surface).overlay(shape.strokeBorder(Theme.team(team), lineWidth: 1.5 * zoom))
        }
    }
}

/// The bidder's countdown on the bid panel's edge (owner 2026-11-18: "a small, unobtrusive
/// countdown"): whole seconds in tabular digits, the warning colour for the last
/// `BidCountdownModel.lowAt`, no blinking or motion. Not a button: touches pass through.
struct BidClockPill: View {
    /// The table pane's coordinate space (GameContainerView's layout overlays): the fixture probe
    /// "table.bidClock" holds the pill's frame in it against the seats and the fold.
    static let paneSpace = "tablePane"

    let seconds: Int
    let low: Bool
    var zoom: CGFloat = 1
    /// Its frame in the pane, each time it is laid out (never cleared: a removal's onDisappear
    /// may come after a new pill's frame): the /help card stays above it.
    var onFrame: (CGRect) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 3 * zoom) {
            Image(systemName: "timer")
                .font(.caption2.weight(.semibold))
                .accessibilityHidden(true)
            Text("\(seconds)")
                .font(.caption.bold())
                .monospacedDigit()
        }
        .foregroundColor(low ? Theme.warning : Theme.textPrimary)
        .padding(.horizontal, Theme.Space.s2)
        .padding(.vertical, 3)
        .background(
            Capsule()
                .fill(Theme.surface.opacity(0.95))
                .overlay(Capsule().strokeBorder(low ? Theme.warning : Theme.divider, lineWidth: 1))
        )
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .fixedSize()
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(BidCountdownModel.label(seconds))
        .accessibilityIdentifier("bidClock")
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(Self.paneSpace)) }) { f in
            onFrame(f)
            #if DEBUG
            if UIFixture.isActive { TableDebugProbe.shared.bidClockFrame = f }
            #endif
        }
        #if DEBUG
        .onDisappear { if UIFixture.isActive { TableDebugProbe.shared.bidClockFrame = nil } }
        #endif
        #if DEBUG
        .accessibilityValue(low ? "\(seconds) low" : "\(seconds)")  // the fixture UI tests read it
        #endif
    }
}
