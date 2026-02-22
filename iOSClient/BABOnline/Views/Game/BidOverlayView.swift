import SwiftUI

/// Bidding UI — bottom sheet with bid grid and bore buttons.
struct BidOverlayView: View {
    @EnvironmentObject var gameState: GameState

    @State private var selectedBid: Int?

    private var maxBid: Int {
        gameState.myCards.count
    }

    /// Check if a bore bid is available based on bid history
    private var canBore: Bool {
        // Bore requires all previous bids to be 0
        guard maxBid > 0 else { return false }
        let previousBids = gameState.tempBids
        return !previousBids.isEmpty && previousBids.allSatisfy { $0 == "0" }
    }

    /// Current bore level
    private var currentBoreLevel: String? {
        let bores = gameState.tempBids.filter { $0.contains("B") }
        if bores.isEmpty { return nil }
        return bores.last
    }

    /// Available bore levels
    private var availableBoreLevels: [String] {
        guard canBore || currentBoreLevel != nil else { return [] }
        let levels = ["B", "2B", "3B", "4B"]
        if let current = currentBoreLevel, let idx = levels.firstIndex(of: current) {
            // Can only escalate
            return Array(levels.suffix(from: idx + 1))
        }
        return ["B"]
    }

    var body: some View {
        VStack(spacing: 6) {
            // Compact bid grid
            let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: min(maxBid + 1, 7))

            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(0...maxBid, id: \.self) { bid in
                    Button(action: { selectedBid = bid }) {
                        Text("\(bid)")
                            .font(.callout.bold())
                            .frame(minWidth: 36, minHeight: 36)
                            .background(selectedBid == bid ? Color.Theme.primary : Color.Theme.surfaceLight)
                            .foregroundColor(selectedBid == bid ? .black : Color.Theme.textPrimary)
                            .cornerRadius(6)
                    }
                }
            }
            .padding(.horizontal, 8)

            HStack(spacing: 8) {
                // Bore buttons inline with submit
                if !availableBoreLevels.isEmpty {
                    ForEach(availableBoreLevels, id: \.self) { level in
                        Button(action: { submitBore(level) }) {
                            Text(level)
                                .font(.caption.bold())
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Color.Theme.oppColor)
                                .foregroundColor(.white)
                                .cornerRadius(6)
                        }
                    }
                }

                Spacer()

                // Submit button
                Button(action: submitBid) {
                    Text("Bid")
                        .font(.callout.bold())
                        .padding(.horizontal, 24)
                        .padding(.vertical, 8)
                        .background(selectedBid != nil ? Color.Theme.buttonBackground : Color.Theme.buttonDisabled)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .disabled(selectedBid == nil)
            }
            .padding(.horizontal, 8)
        }
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.Theme.surface.opacity(0.95))
                .shadow(color: .black.opacity(0.4), radius: 10)
        )
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }

    private func submitBid() {
        guard let bid = selectedBid, let pos = gameState.position else { return }
        HapticManager.mediumImpact()
        gameState.optimisticBid(String(bid))
        GameEmitter.playerBid(bid: bid, position: pos)
        selectedBid = nil
    }

    private func submitBore(_ level: String) {
        guard let pos = gameState.position else { return }
        HapticManager.mediumImpact()
        gameState.optimisticBid(level)
        GameEmitter.playerBidBore(bid: level, position: pos)
    }
}
