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

    /// Available bore levels based on what's already been bid
    private var availableBoreLevels: [String] {
        guard maxBid > 0 else { return [] }
        let bids = gameState.tempBids
        var levels: [String] = []
        if !bids.contains("B")                          { levels.append("B") }
        if bids.contains("B") && !bids.contains("2B")   { levels.append("2B") }
        if bids.contains("2B") && !bids.contains("3B")  { levels.append("3B") }
        if bids.contains("3B") && !bids.contains("4B")  { levels.append("4B") }
        return levels
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
                            .background(selectedBid == bidStr ? Color.Theme.primary : Color.Theme.surfaceLight)
                            .foregroundColor(selectedBid == bidStr ? .black : Color.Theme.textPrimary)
                            .cornerRadius(6)
                            .frame(width: Self.cell, height: Self.cell)
                            .contentShape(Rectangle())
                    }
                    .accessibilityShowsLargeContentViewer()
                }
            }
            .padding(.horizontal, 6)

            HStack(spacing: 8) {
                // Bore buttons inline with submit
                if !availableBoreLevels.isEmpty {
                    ForEach(availableBoreLevels, id: \.self) { level in
                        Button(action: { selectedBid = level }) {
                            Text(level)
                                .font(.caption.bold())
                                .frame(minWidth: Self.cell - 4)
                                .padding(.horizontal, 8)
                                .frame(height: Self.rowHeight)
                                .background(selectedBid == level ? Color.Theme.oppColor : Color.Theme.surfaceLight)
                                .foregroundColor(selectedBid == level ? .white : Color.Theme.textPrimary)
                                .cornerRadius(6)
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
                            ProgressView().tint(.white)
                        } else {
                            Text("Submit")
                        }
                    }
                    .font(.callout.bold())
                    .padding(.horizontal, 24)
                    .frame(height: Self.rowHeight)
                    .background(selectedBid != nil && !isSubmitted ? Color.Theme.buttonBackground : Color.Theme.buttonDisabled)
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .contentShape(Rectangle().inset(by: -2))
                }
                .disabled(selectedBid == nil || isSubmitted)
                .accessibilityShowsLargeContentViewer()
            }
            .padding(.horizontal, 8)
        }
        .padding(.vertical, 4)
        .disabled(isSubmitted)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.Theme.surface.opacity(0.95))
                .shadow(color: .black.opacity(0.4), radius: 10)
        )
        .padding(.horizontal, 8)
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
