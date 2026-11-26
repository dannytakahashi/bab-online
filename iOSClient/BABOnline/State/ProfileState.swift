import Foundation
import Combine

/// One scope's stats on a profile: the last good numbers stay while a refresh runs or after
/// one fails.
struct ProfileStatsLoad: Equatable {
    var stats: ProfileStats?
    var isLoading = false
    var failure: StatsFailure?
}

/// The outcome of a picture change (the web's toasts: "Profile picture updated!", ...).
struct PictureNotice: Equatable {
    let id = UUID()
    let success: Bool
    let message: String

    static func == (a: PictureNotice, b: PictureNotice) -> Bool { a.id == b.id }
}

/// Profiles (iOS 1.2.2): my own in the Account sheet (`getProfile` -> `profileResponse`, the
/// picture changes `updateProfilePic` -> `profilePicUpdateResponse` and `uploadProfilePic` ->
/// `profilePicUploadResponse`) and the one other player being looked at (`getPlayerProfile` ->
/// `playerProfileResponse`). Stats are kept per scope (Humans / Bots / All, the Stats sheet's
/// choice); every request names its scope, so a success says which page it fills. Main thread
/// only (the socket handler hops to it).
final class ProfileState: ObservableObject {
    // MARK: Mine

    /// The account the own profile below belongs to ("" before the first request).
    @Published private(set) var ownUsername = ""
    /// My stock picture and my custom picture's path, once a reply or a change said them.
    @Published private(set) var ownStockPic: Int?
    @Published private(set) var ownAvatarPath: String?
    /// The picture just uploaded, shown at once (the server's copy loads from `ownAvatarPath` later).
    @Published private(set) var ownUploaded: PlatformImage?
    @Published private(set) var ownLoads: [StatsScope: ProfileStatsLoad] = [:]
    /// My earned badges, from the latest successful profileResponse (nil before one).
    @Published private(set) var ownBadges: [EarnedBadge]?
    /// My tournament history from the latest successful profileResponse (nil before one, or from
    /// a server without it; TournamentHistory).
    @Published private(set) var ownTournaments: TournamentHistory?
    /// A picture change is waiting for its answer.
    @Published private(set) var pictureBusy = false
    @Published var pictureNotice: PictureNotice?

    /// What the avatar caches load for my picture; nil before the first reply.
    var ownPictureKey: String? { ownAvatarPath ?? ownStockPic.map(String.init) }

    // MARK: Another player

    struct Viewed: Equatable {
        /// The name asked for (a chat line's, a seat's).
        let requested: String
        /// The reply's player (a merged account's old name answers with the account it joined).
        var username: String?
        var pictureKey: String?
        var loads: [StatsScope: ProfileStatsLoad] = [:]
        /// Their earned badges, from the latest successful reply (nil before one).
        var badges: [EarnedBadge]?
        /// Their tournament history from the latest successful reply (nil before one).
        var tournaments: TournamentHistory?
        fileprivate let token: Int

        var displayName: String { username ?? requested }
    }

    @Published private(set) var viewed: Viewed?

    // MARK: Requests (the emitters; tests and fixture mode replace them)

    var sendOwn: (StatsScope) -> Void = { ProfileEmitter.getProfile(scope: $0) }
    var sendPlayer: (String, StatsScope) -> Void = { ProfileEmitter.getPlayerProfile(username: $0, scope: $1) }
    var sendStockPic: (Int) -> Void = { ProfileEmitter.updateProfilePic($0) }
    var sendUpload: (String) -> Void = { ProfileEmitter.uploadProfilePic(imageData: $0) }
    /// How long a request may wait for its reply.
    var timeout: TimeInterval = 10

    static let noAnswer = "No answer from the server. Try again."
    /// playerProfileResponse's failure for a name with no account (server profileHandlers.js;
    /// server/socket/__tests__/iosCopies.test.js holds this copy to the server's).
    static let playerNotFound = "Player not found"

    private var serial = 0
    private func nextId() -> Int { serial += 1; return serial }

    /// Own stats requests in the order sent (a failure names no scope: it answers the oldest).
    private var ownWaiting: [(id: Int, scope: StatsScope)] = []
    private struct PlayerRequest { let id: Int; let token: Int; let username: String; let scope: StatsScope }
    /// getPlayerProfile requests in the order sent, earlier sheets' included, so a late answer
    /// to an earlier sheet is not shown under the open one.
    private var playerWaiting: [PlayerRequest] = []
    private var pictureRequest = 0
    private var lastOwnScope: StatsScope = .human
    private var pendingUpload: PlatformImage?

    // MARK: - Mine

    /// Asks for my stats in `scope` unless that request is already waiting. Another account
    /// than the last one (a sign-out, a deletion) starts from nothing.
    func requestOwn(username: String, scope: StatsScope) {
        if username != ownUsername { resetOwn(username: username) }
        lastOwnScope = scope
        var load = ownLoads[scope] ?? ProfileStatsLoad()
        if load.isLoading { return }
        load.isLoading = true
        load.failure = nil
        ownLoads[scope] = load
        let id = nextId()
        ownWaiting.append((id, scope))
        sendOwn(scope)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, let i = self.ownWaiting.firstIndex(where: { $0.id == id }) else { return }
            self.ownWaiting.remove(at: i)
            self.finishOwn(scope, failure: .noReply)
        }
    }

    /// profileResponse.
    func applyOwn(response dict: [String: Any]) {
        if let profile = PlayerProfile.from(response: dict) {
            // every request named its scope, so a success without an echo is human games
            // (an echo this build does not know: dropped)
            guard let scope = StatsScope.echo(of: dict) ?? .some(.human), profile.username == ownUsername else { return }
            if let i = ownWaiting.firstIndex(where: { $0.scope == scope }) { ownWaiting.remove(at: i) }
            ownStockPic = profile.profilePic
            if profile.avatarPath != ownAvatarPath {
                ownAvatarPath = profile.avatarPath
                ownUploaded = nil
            }
            ownLoads[scope, default: ProfileStatsLoad()].stats = profile.stats
            // the same badges whatever the scope: every success says them
            if ownBadges != profile.badges { ownBadges = profile.badges }
            // the same history whatever the scope (a tournament is not a game)
            if ownTournaments != profile.tournaments { ownTournaments = profile.tournaments }
            finishOwn(scope, failure: nil)
        } else if !ownWaiting.isEmpty {
            let head = ownWaiting.removeFirst()
            finishOwn(head.scope, failure: StatsFailure(message: Self.message(dict, "Failed to load profile")))
        }
    }

    private func finishOwn(_ scope: StatsScope, failure: StatsFailure?) {
        ownLoads[scope, default: ProfileStatsLoad()].isLoading = false
        ownLoads[scope, default: ProfileStatsLoad()].failure = failure
    }

    private func resetOwn(username: String) {
        ownUsername = username
        ownStockPic = nil
        ownAvatarPath = nil
        ownUploaded = nil
        ownLoads = [:]
        ownBadges = nil
        ownTournaments = nil
        ownWaiting = []
        pictureBusy = false
        pictureNotice = nil
        pictureRequest += 1
        pendingUpload = nil
    }

    // MARK: - My picture

    /// Choose Avatar: a stock picture (1...82).
    func chooseStockPic(_ number: Int) {
        guard !pictureBusy, (1...ProfilePicture.stockCount).contains(number) else { return }
        beginPictureChange()
        sendStockPic(number)
    }

    /// Upload Photo: a picked file, cropped and encoded as the web does it (ProfilePicture).
    func upload(imageData data: Data) {
        guard !pictureBusy else { return }
        upload(prepared: ProfilePicture.upload(from: data))
    }

    /// The same with the image already made (the Account sheet makes it off the main thread).
    func upload(prepared: Result<(url: String, image: PlatformImage), ProfilePicture.Failure>) {
        guard !pictureBusy else { return }
        switch prepared {
        case .failure(let failure):
            pictureNotice = PictureNotice(success: false, message: failure.message)
        case .success(let made):
            beginPictureChange()
            pendingUpload = made.image
            sendUpload(made.url)
        }
    }

    /// The picked photo could not be read at all.
    func uploadFailed(_ failure: ProfilePicture.Failure = .unreadable) {
        pictureNotice = PictureNotice(success: false, message: failure.message)
    }

    private func beginPictureChange() {
        pictureBusy = true
        pictureNotice = nil
        pendingUpload = nil
        pictureRequest += 1
        let request = pictureRequest
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, self.pictureBusy, self.pictureRequest == request else { return }
            self.pictureBusy = false
            self.pendingUpload = nil
            self.pictureNotice = PictureNotice(success: false, message: Self.noAnswer)
        }
    }

    /// profilePicUpdateResponse: the stock picture is mine now (the web shows it in place of a
    /// custom one too).
    func applyStockPic(response dict: [String: Any]) {
        pictureBusy = false
        if dict["success"] as? Bool == true, let n = StatsWire.int(dict["profilePic"]), (1...ProfilePicture.stockCount).contains(n) {
            let hadCustom = ownAvatarPath != nil || ownUploaded != nil
            ownStockPic = n
            ownAvatarPath = nil
            ownUploaded = nil
            pictureNotice = PictureNotice(success: true, message: "Profile picture updated!")
            // with a custom picture before, the server says which one others see now (a server
            // that keeps the custom picture answers with its avatarUrl again): the hero follows it
            if hadCustom, !ownUsername.isEmpty { requestOwn(username: ownUsername, scope: lastOwnScope) }
        } else {
            pictureNotice = PictureNotice(success: false, message: Self.message(dict, "Failed to update profile picture"))
        }
    }

    /// profilePicUploadResponse: the picture sent is shown at once; `avatarUrl` (the new
    /// version's path) is what every cache loads from now on.
    func applyUpload(response dict: [String: Any]) {
        pictureBusy = false
        let sent = pendingUpload
        pendingUpload = nil
        if dict["success"] as? Bool == true {
            ownAvatarPath = StatsWire.string(dict["avatarUrl"]).flatMap { HTTPAvatarLoader.isAvatarPath($0) ? $0 : nil }
            ownUploaded = sent ?? StatsWire.string(dict["customProfilePic"]).flatMap(ProfilePicture.image(fromDataURL:))
            pictureNotice = PictureNotice(success: true, message: "Profile picture uploaded!")
        } else {
            pictureNotice = PictureNotice(success: false, message: Self.message(dict, "Failed to upload profile picture"))
        }
    }

    // MARK: - Another player

    /// Opens `username`'s profile (its sheet shows `viewed`) and asks for `scope`.
    func view(_ username: String, scope: StatsScope) {
        viewed = Viewed(requested: username, token: nextId())
        requestViewed(scope: scope)
    }

    /// Asks for the open profile's stats in `scope` unless that request is already waiting.
    func requestViewed(scope: StatsScope) {
        guard var v = viewed else { return }
        var load = v.loads[scope] ?? ProfileStatsLoad()
        if load.isLoading { return }
        load.isLoading = true
        load.failure = nil
        v.loads[scope] = load
        viewed = v
        let id = nextId(), token = v.token
        playerWaiting.append(PlayerRequest(id: id, token: token, username: v.requested, scope: scope))
        sendPlayer(v.requested, scope)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, let i = self.playerWaiting.firstIndex(where: { $0.id == id }) else { return }
            self.playerWaiting.remove(at: i)
            self.finishViewed(token, scope, failure: .noReply)
        }
    }

    /// `requested`'s sheet closed (a newer sheet's profile stays).
    func closeViewed(_ requested: String) {
        if viewed?.requested == requested { viewed = nil }
    }

    /// playerProfileResponse. A success names its player and scope: it answers the oldest
    /// request for that name and scope, else (a merged account's old name) the oldest of that
    /// scope. A failure names nothing: it answers the oldest request.
    func applyPlayer(response dict: [String: Any]) {
        if let profile = PlayerProfile.from(response: dict) {
            guard let scope = StatsScope.echo(of: dict) ?? .some(.human) else { return }
            let token: Int
            if let i = playerWaiting.firstIndex(where: { $0.scope == scope && $0.username == profile.username })
                ?? playerWaiting.firstIndex(where: { $0.scope == scope }) {
                token = playerWaiting.remove(at: i).token
            } else if let v = viewed, v.requested == profile.username || v.username == profile.username {
                // no request waits (it timed out, or an earlier request's late failure took its
                // place in the queue), but the answer names the open sheet's player: shown
                token = v.token
            } else {
                return
            }
            guard var v = viewed, v.token == token else { return }
            v.username = profile.username
            v.pictureKey = profile.pictureKey
            v.loads[scope, default: ProfileStatsLoad()].stats = profile.stats
            v.badges = profile.badges
            v.tournaments = profile.tournaments
            viewed = v
            finishViewed(token, scope, failure: nil)
        } else if !playerWaiting.isEmpty {
            let request = playerWaiting.removeFirst()
            finishViewed(request.token, request.scope, failure: StatsFailure(message: Self.message(dict, "Failed to load profile")))
        }
    }

    /// `serverError {code: "rateLimit", handler}` (the `error` event's `type` likewise) for one
    /// of the two profile requests: the server's per-socket limits answer on that channel, not
    /// with a failed reply. The oldest waiting request of that kind fails now with the server's
    /// words instead of waiting out its timeout. True when a request took it (no toast then).
    @discardableResult
    func applyServerError(_ dict: [String: Any]) -> Bool {
        guard (dict["code"] as? String ?? dict["type"] as? String) == "rateLimit" else { return false }
        let failure = StatsFailure(message: Self.message(dict, "Too many requests, please slow down"))
        switch dict["handler"] as? String {
        case SocketEvents.Client.getProfile:
            guard !ownWaiting.isEmpty else { return false }
            finishOwn(ownWaiting.removeFirst().scope, failure: failure)
            return true
        case SocketEvents.Client.getPlayerProfile:
            guard !playerWaiting.isEmpty else { return false }
            let request = playerWaiting.removeFirst()
            finishViewed(request.token, request.scope, failure: failure)
            return true
        default:
            return false
        }
    }

    private func finishViewed(_ token: Int, _ scope: StatsScope, failure: StatsFailure?) {
        guard var v = viewed, v.token == token else { return }
        v.loads[scope, default: ProfileStatsLoad()].isLoading = false
        v.loads[scope, default: ProfileStatsLoad()].failure = failure
        viewed = v
    }

    private static func message(_ dict: [String: Any], _ fallback: String) -> String {
        (dict["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    }
}
