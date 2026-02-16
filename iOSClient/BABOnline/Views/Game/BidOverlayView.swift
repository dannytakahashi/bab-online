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
        VStack(spacing: 12) {
            // Header
            Text("Your Bid")
                .font(.headline)
                .foregroundColor(Color.Theme.textPrimary)

            // Bid grid
            let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: min(maxBid + 1, 7))

            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(0...maxBid, id: \.self) { bid in
                    Button(action: { selectedBid = bid }) {
                        Text("\(bid)")
                            .font(.title3.bold())
                            .frame(minWidth: 44, minHeight: 44)
                            .background(selectedBid == bid ? Color.Theme.primary : Color.Theme.surfaceLight)
                            .foregroundColor(selectedBid == bid ? .black : Color.Theme.textPrimary)
                            .cornerRadius(8)
                    }
                }
            }
            .padding(.horizontal)

            // Bore buttons
            if !availableBoreLevels.isEmpty {
                HStack(spacing: 12) {
                    ForEach(availableBoreLevels, id: \.self) { level in
                        Button(action: { submitBore(level) }) {
                            Text(level)
                                .font(.callout.bold())
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(Color.Theme.oppColor)
                                .foregroundColor(.white)
                                .cornerRadius(8)
                        }
                    }
                }
            }

            // Submit button
            Button(action: submitBid) {
                Text("Submit Bid")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(selectedBid != nil ? Color.Theme.buttonBackground : Color.Theme.buttonDisabled)
                    .foregroundColor(.white)
                    .cornerRadius(10)
            }
            .disabled(selectedBid == nil)
            .padding(.horizontal)
        }
        .padding(.vertical, 16)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(Color.Theme.surface)
                .shadow(color: .black.opacity(0.5), radius: 20)
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private func submitBid() {
        guard let bid = selectedBid, let pos = gameState.position else { return }
        HapticManager.mediumImpact()
        gameState.optimisticBid(bid)
        GameEmitter.playerBid(bid: bid, position: pos)
        selectedBid = nil
    }

    private func submitBore(_ level: String) {
        guard let pos = gameState.position else { return }
        HapticManager.mediumImpact()
        GameEmitter.playerBidBore(bid: level, position: pos)
    }
}
