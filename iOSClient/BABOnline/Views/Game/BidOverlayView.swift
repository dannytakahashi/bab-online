import SwiftUI

/// Bidding UI — bottom sheet with bid grid and bore buttons.
///
/// My HSI shows in the bottom row, centred in the gap between the bore button and
/// Submit (owner, 2026-11-12: my seat's row, where HSI usually is, hides under the
/// panel on my bid turn). It is an overlay of that gap, so it never moves or shrinks
/// a button; where the gap is too narrow for it (none of today's sizes) it moves to
/// a header line above the grid instead.
struct BidOverlayView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var actions: ActionCoordinator
    /// The table's zoom (TableLayout.zoom; 1 on a phone): the cells and the bottom row grow
    /// with the table's bid band; the type stays Dynamic Type.
    var zoom: CGFloat = 1

    @State private var selectedBid: String?
    /// The bottom row's gap between the bore button and Submit, and HSI's width (measured).
    @State private var gapWidth: CGFloat = .infinity
    @State private var hsiWidth: CGFloat = 0

    /// Sent, waiting for bidReceived (or a reject): no second submit.
    private var isSubmitted: Bool { gameState.myTurn.isSubmitted }

    private var maxBid: Int {
        gameState.myCards.count
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
                 viewPosition: gameState.viewPosition)
    }

    private var hsiInHeader: Bool { gameState.myHSI != nil && !Self.hsiFitsRow(gap: gapWidth, hsi: hsiWidth) }

    var body: some View {
        VStack(spacing: 2) {
            // the web bid sheet's chip row: one chip per trick, the bids so far by team,
            // outlined chips past the hand size for an overbid
            BidChipRow(chips: bidChips, zoom: zoom)
                .padding(.horizontal, Theme.Space.s3)
            if hsiInHeader, let hsi = gameState.myHSI {
                HSIBadge(value: hsi, style: .panel)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, Theme.Space.s2)
            }
            // Fixed-width bid grid: at most 7 cells a row (7 x 44 + padding fits the 340 x 140 bid band)
            let columns = Array(repeating: GridItem(.fixed(cellSize), spacing: 0), count: min(maxBid + 1, 7))

            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(0...maxBid, id: \.self) { bid in
                    let bidStr = String(bid)
                    Button(action: { selectedBid = bidStr }) {
                        Text("\(bid)")
                            .font(.callout.bold())
                            .frame(width: faceSize, height: faceSize)
                            .background(selectedBid == bidStr ? Theme.primary : Theme.surfaceLight)
                            .foregroundColor(selectedBid == bidStr ? Theme.buttonForeground : Theme.textPrimary)
                            .cornerRadius(Theme.Radius.sm)
                            .frame(width: cellSize, height: cellSize)
                            .contentShape(Rectangle())
                    }
                    .accessibilityShowsLargeContentViewer()
                }
            }
            .padding(.horizontal, 6)

            HStack(spacing: Theme.Space.s2) {
                // Bore buttons inline with submit
                if !availableBoreLevels.isEmpty {
                    ForEach(availableBoreLevels, id: \.self) { level in
                        Button(action: { selectedBid = level }) {
                            Text(level)
                                .font(.caption.bold())
                                .frame(minWidth: cellSize - 4)
                                .padding(.horizontal, Theme.Space.s2)
                                .frame(height: rowSize)
                                .background(selectedBid == level ? Theme.danger : Theme.surfaceLight)
                                .foregroundColor(selectedBid == level ? Theme.dangerForeground : Theme.textPrimary)
                                .cornerRadius(Theme.Radius.sm)
                                .contentShape(Rectangle().inset(by: -2))
                        }
                        .accessibilityShowsLargeContentViewer()
                    }
                }

                // the gap (a Spacer's 8 pt minimum); HSI is an overlay of it, so the buttons never move
                Color.clear
                    .frame(minWidth: 8, maxWidth: .infinity, maxHeight: rowSize)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { gapWidth = $0 }
                    .overlay {
                        if let hsi = gameState.myHSI {
                            HSIBadge(value: hsi, style: .panel)
                                .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { hsiWidth = $0 }
                                .opacity(hsiInHeader ? 0 : 1)
                                .accessibilityHidden(hsiInHeader)
                        }
                    }

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
            .padding(.horizontal, Theme.Space.s2)
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
        .padding(.horizontal, Theme.Space.s2)
        // capped so the panel fits the layout's 340 x 140 bid band
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bidOverlay")
        #if DEBUG
        .accessibilityValue(selectedBid ?? "-")  // the fixture UI tests read the selection
        #endif
    }

    private func submitBid() {
        guard let bid = selectedBid else { return }
        if actions.bid(bid) {
            HapticManager.mediumImpact()
            selectedBid = nil
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

    init(bids: BidBook, handSize: Int, viewPosition: Int) {
        let totals = BidTotals.totals(bids, handSize: handSize)
        let rel = totals.relative(to: viewPosition)
        self.handSize = BidTotals.hand(handSize)
        mine = rel.mine
        theirs = rel.theirs
        myTeam = Positions.getTeamNumber(viewPosition)
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

    /// "Bids: your team 3, opponents 2, of 7 tricks. Over by 1."
    var spoken: String {
        var text = "Bids: your team \(mine), opponents \(theirs), of \(handSize) \(handSize == 1 ? "trick" : "tricks")"
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
