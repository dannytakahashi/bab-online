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

    private var hsiInHeader: Bool { gameState.myHSI != nil && !Self.hsiFitsRow(gap: gapWidth, hsi: hsiWidth) }

    var body: some View {
        VStack(spacing: 2) {
            if hsiInHeader, let hsi = gameState.myHSI {
                HSIBadge(value: hsi, style: .panel)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, Theme.Space.s2)
            }
            // Fixed-width bid grid: at most 7 cells a row (7 x 44 + padding fits the 340 x 140 bid band)
            let columns = Array(repeating: GridItem(.fixed(Self.cell), spacing: 0), count: min(maxBid + 1, 7))

            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(0...maxBid, id: \.self) { bid in
                    let bidStr = String(bid)
                    Button(action: { selectedBid = bidStr }) {
                        Text("\(bid)")
                            .font(.callout.bold())
                            .frame(width: Self.face, height: Self.face)
                            .background(selectedBid == bidStr ? Theme.primary : Theme.surfaceLight)
                            .foregroundColor(selectedBid == bidStr ? Theme.buttonForeground : Theme.textPrimary)
                            .cornerRadius(Theme.Radius.sm)
                            .frame(width: Self.cell, height: Self.cell)
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
                                .frame(minWidth: Self.cell - 4)
                                .padding(.horizontal, Theme.Space.s2)
                                .frame(height: Self.rowHeight)
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
                    .frame(minWidth: 8, maxWidth: .infinity, maxHeight: Self.rowHeight)
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
                    .frame(height: Self.rowHeight)
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
        .padding(.vertical, Theme.Space.s1)
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
