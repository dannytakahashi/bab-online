import Foundation

/// `profileResponse`, `profilePicUpdateResponse`, `profilePicUploadResponse` and
/// `playerProfileResponse` -> ProfileState (decoding and failures: ProfileState's apply functions);
/// `badgesAwarded` (private, the clientHello cap `badges`) -> the badge toast's queue (BadgeAwards);
/// `searchPlayersResponse` -> the Players sheet's search (PlayerSearchState, owner 2026-11-27).
final class ProfileSocketHandler {
    private let socket: SocketService
    private let profileState: ProfileState
    private let badgeAwards: BadgeAwards
    private let playerSearch: PlayerSearchState

    init(socket: SocketService, profileState: ProfileState, badgeAwards: BadgeAwards = .shared,
         playerSearch: PlayerSearchState = .shared) {
        self.socket = socket
        self.profileState = profileState
        self.badgeAwards = badgeAwards
        self.playerSearch = playerSearch
    }

    func register() {
        on(SocketEvents.Server.profileResponse) { $0.applyOwn(response: $1) }
        on(SocketEvents.Server.profilePicUpdateResponse) { $0.applyStockPic(response: $1) }
        on(SocketEvents.Server.profilePicUploadResponse) { $0.applyUpload(response: $1) }
        on(SocketEvents.Server.playerProfileResponse) { $0.applyPlayer(response: $1) }
        socket.on(SocketEvents.Server.badgesAwarded) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.badgeAwards.receive(dict) }
        }
        socket.on(SocketEvents.Server.searchPlayersResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.playerSearch.apply(response: dict) }
        }
        // a rate-limited profile request or search is answered with serverError: the waiting
        // request fails with it (no toast)
        socket.claimProfileServerError = { [weak self] dict in
            guard let self else { return false }
            return self.profileState.applyServerError(dict) || self.playerSearch.applyServerError(dict)
        }
    }

    private func on(_ event: String, _ apply: @escaping (ProfileState, [String: Any]) -> Void) {
        socket.on(event) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { apply(self.profileState, dict) }
        }
    }
}
