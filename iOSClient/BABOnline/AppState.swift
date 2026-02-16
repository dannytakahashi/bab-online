import Foundation

/// Drives top-level navigation — matches web client's screen-replacement pattern.
final class AppState: ObservableObject {
    enum Screen {
        case signIn
        case register
        case mainRoom
        case gameLobby
        case game
    }

    @Published var screen: Screen = .signIn
}
