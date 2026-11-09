#if DEBUG
import SwiftUI

/// #Preview data (item 26): the fixture-mode seeding (UIFixture) over the
/// Debug bundle's v2 snapshots, plus a modifier that injects every store the
/// game views read.
enum PreviewFixtures {
    @MainActor
    static func make(_ name: String) -> (GameState, ActionCoordinator, AppState) {
        let store = GameState()
        let app = AppState()
        UIFixture.seed(fixture: name, store, app, mainRoom: MainRoomState(), lobby: LobbyState(), tournament: TournamentState(), auth: AuthState())
        return (store, ActionCoordinator(store: store), app)
    }
}

extension View {
    /// The environment objects of the game screens, seeded from fixture `name`.
    @MainActor
    func previewFixture(_ name: String) -> some View {
        let (game, actions, app) = PreviewFixtures.make(name)
        return self
            .environmentObject(game)
            .environmentObject(actions)
            .environmentObject(app)
            .environmentObject(SafetyState())
            .preferredColorScheme(.dark)
    }
}

// MARK: - Duo sizes: closed 466x678, open 669x951 and 951x669

#Preview("Table, trick (Duo closed)", traits: .fixedLayout(width: 466, height: 678)) {
    GameContainerView().previewFixture("trick-mid-lead3")
}
#Preview("Table, trick (Duo open)", traits: .fixedLayout(width: 669, height: 951)) {
    GameContainerView().previewFixture("trick-mid-lead3")
}
#Preview("Table, trick (Duo open landscape)", traits: .fixedLayout(width: 951, height: 669)) {
    GameContainerView().previewFixture("trick-mid-lead3")
}
#Preview("Table, bidding (Duo closed)", traits: .fixedLayout(width: 466, height: 678)) {
    GameContainerView().previewFixture("bidding-mid")
}
#Preview("Table, bidding (Duo open)", traits: .fixedLayout(width: 669, height: 951)) {
    GameContainerView().previewFixture("bidding-mid")
}
#Preview("Table, bidding (Duo open landscape)", traits: .fixedLayout(width: 951, height: 669)) {
    GameContainerView().previewFixture("bidding-mid")
}
#Preview("Bid panel (Duo closed)", traits: .fixedLayout(width: 466, height: 678)) {
    VStack { Spacer(); BidOverlayView().frame(maxWidth: 340) }.previewFixture("bidding-mid")
}
#Preview("Bid panel (Duo open)", traits: .fixedLayout(width: 669, height: 951)) {
    VStack { Spacer(); BidOverlayView().frame(maxWidth: 340) }.previewFixture("bidding-mid")
}
#Preview("Bid panel (Duo open landscape)", traits: .fixedLayout(width: 951, height: 669)) {
    VStack { Spacer(); BidOverlayView().frame(maxWidth: 340) }.previewFixture("bidding-mid")
}
#Preview("Game end (Duo closed)", traits: .fixedLayout(width: 466, height: 678)) {
    GameEndView().previewFixture("game-end")
}
#Preview("Game end (Duo open)", traits: .fixedLayout(width: 669, height: 951)) {
    GameEndView().previewFixture("game-end")
}
#Preview("Game end (Duo open landscape)", traits: .fixedLayout(width: 951, height: 669)) {
    GameEndView().previewFixture("game-end")
}
#endif
