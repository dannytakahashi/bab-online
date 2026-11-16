import Foundation

/// The profile requests (iOS 1.2.2). The stats requests always name their scope, human games
/// included, so the server echoes it in every success (ProfileState).
enum ProfileEmitter {
    private static var socket: SocketService { .shared }

    /// My own profile; answered by profileResponse.
    static func getProfile(scope: StatsScope) {
        socket.emit(SocketEvents.Client.getProfile, scope.profilePayload)
    }

    /// Another player's profile (a bot's name answers "Player not found"); playerProfileResponse.
    static func getPlayerProfile(username: String, scope: StatsScope) {
        var payload = scope.profilePayload
        payload["username"] = username
        socket.emit(SocketEvents.Client.getPlayerProfile, payload)
    }

    /// A stock picture, 1...82; profilePicUpdateResponse.
    static func updateProfilePic(_ number: Int) {
        socket.emit(SocketEvents.Client.updateProfilePic, ["profilePic": number])
    }

    /// A custom picture as a PNG data URL (ProfilePicture); profilePicUploadResponse.
    static func uploadProfilePic(imageData: String) {
        socket.emit(SocketEvents.Client.uploadProfilePic, ["imageData": imageData])
    }
}
