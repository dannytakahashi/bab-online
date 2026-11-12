import SwiftUI

/// Bidding UI — bottom sheet with bid grid and bore buttons.
struct BidOverlayView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var actions: ActionCoordinator

    @State private var selectedBid: String?

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

    var body: some View {
        VStack(spacing: 2) {
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

                Spacer()

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
