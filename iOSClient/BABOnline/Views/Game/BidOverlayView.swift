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

    var body: some View {
        VStack(spacing: 6) {
            // Fixed-width bid grid: 36 pt buttons, at most 7 a row (fits the 340 pt bid band)
            let columns = Array(repeating: GridItem(.fixed(36), spacing: 4), count: min(maxBid + 1, 7))

            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(0...maxBid, id: \.self) { bid in
                    let bidStr = String(bid)
                    Button(action: { selectedBid = bidStr }) {
                        Text("\(bid)")
                            .font(.callout.bold())
                            .frame(minWidth: 36, minHeight: 36)
                            .background(selectedBid == bidStr ? Color.Theme.primary : Color.Theme.surfaceLight)
                            .foregroundColor(selectedBid == bidStr ? .black : Color.Theme.textPrimary)
                            .cornerRadius(6)
                    }
                }
            }
            .padding(.horizontal, 8)

            HStack(spacing: 8) {
                // Bore buttons inline with submit
                if !availableBoreLevels.isEmpty {
                    ForEach(availableBoreLevels, id: \.self) { level in
                        Button(action: { selectedBid = level }) {
                            Text(level)
                                .font(.caption.bold())
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(selectedBid == level ? Color.Theme.oppColor : Color.Theme.surfaceLight)
                                .foregroundColor(selectedBid == level ? .white : Color.Theme.textPrimary)
                                .cornerRadius(6)
                        }
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
                    .padding(.vertical, 8)
                    .background(selectedBid != nil && !isSubmitted ? Color.Theme.buttonBackground : Color.Theme.buttonDisabled)
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }
                .disabled(selectedBid == nil || isSubmitted)
            }
            .padding(.horizontal, 8)
        }
        .padding(.vertical, 8)
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
        .accessibilityValue(selectedBid ?? "-")
    }

    private func submitBid() {
        guard let bid = selectedBid else { return }
        if actions.bid(bid) {
            HapticManager.mediumImpact()
            selectedBid = nil
        }
    }
}
