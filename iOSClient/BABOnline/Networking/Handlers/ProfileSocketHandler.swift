import Foundation

/// `profileResponse`, `profilePicUpdateResponse`, `profilePicUploadResponse` and
/// `playerProfileResponse` -> ProfileState (decoding and failures: ProfileState's apply functions);
/// `badgesAwarded` (private, the clientHello cap `badges`) -> the badge toast's queue (BadgeAwards).
final class ProfileSocketHandler {
    private let socket: SocketService
    private let profileState: ProfileState
    private let badgeAwards: BadgeAwards

    init(socket: SocketService, profileState: ProfileState, badgeAwards: BadgeAwards = .shared) {
        self.socket = socket
        self.profileState = profileState
        self.badgeAwards = badgeAwards
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
        // a rate-limited profile request is answered with serverError: the waiting request fails with it
        socket.claimProfileServerError = { [weak self] dict in self?.profileState.applyServerError(dict) ?? false }
    }

    private func on(_ event: String, _ apply: @escaping (ProfileState, [String: Any]) -> Void) {
        socket.on(event) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { apply(self.profileState, dict) }
        }
    }
}
