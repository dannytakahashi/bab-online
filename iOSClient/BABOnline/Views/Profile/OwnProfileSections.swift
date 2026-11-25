import SwiftUI
import PhotosUI

/// My own profile at the top of the Account sheet (the web's showProfilePage): the picture
/// other players see, with Upload Photo and Choose Avatar, then my statistics for the games
/// the Stats sheet counts. Two List sections. The rows only set `pickedPhoto` and
/// `showsAvatarPicker` (the Account sheet's state); what acts on them is OwnProfileHost on the
/// List, because a List row that scrolls off screen is torn down with its modifiers.
struct OwnProfileSections: View {
    @Binding var pickedPhoto: PhotosPickerItem?
    @Binding var showsAvatarPicker: Bool
    let signOut: () -> Void

    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var profileState: ProfileState
    @EnvironmentObject var leaderboardState: LeaderboardState
    @EnvironmentObject var recordsState: RecordsState
    @EnvironmentObject var socketService: SocketService

    /// One choice for the Stats sheet and both profiles, saved on disk (StatsScope).
    private var scope: Binding<StatsScope> {
        Binding(get: { leaderboardState.scope }, set: { s in
            leaderboardState.select(s)
            recordsState.select(s)
            request(s)
        })
    }

    /// Mine only: another account's numbers (before this sheet's first request) never show.
    private var isMine: Bool { profileState.ownUsername == authState.username }
    private var load: ProfileStatsLoad {
        (isMine ? profileState.ownLoads[leaderboardState.scope] : nil) ?? ProfileStatsLoad(isLoading: true)
    }

    private func request(_ scope: StatsScope) {
        guard !authState.username.isEmpty else { return }
        profileState.requestOwn(username: authState.username, scope: scope)
    }

    var body: some View {
        Section {
            hero
            uploadRow
            Button { showsAvatarPicker = true } label: {
                Label("Choose Avatar", systemImage: "person.crop.circle")
                    .foregroundColor(Theme.primary)
            }
            .disabled(!canChangePicture)
            .accessibilityIdentifier("profile.chooseAvatar")

            if profileState.pictureBusy {
                HStack(spacing: Theme.Space.s2) {
                    ProgressView().scaleEffect(0.8)
                    Text("Saving your picture…")
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                }
                .accessibilityElement(children: .combine)
            } else if let notice = profileState.pictureNotice {
                Text(notice.message)
                    .font(.caption)
                    .foregroundColor(notice.success ? Theme.success : Theme.error)
                    .accessibilityIdentifier("profile.pictureNotice")
            }

            Button(action: signOut) {
                Text("Sign Out")
                    .foregroundColor(Theme.primary)
            }
        }
        .listRowBackground(Theme.surface)

        Section {
            ProfileStatsSection(load: load, scope: scope) { request(leaderboardState.scope) }
                .padding(.vertical, Theme.Space.s1)
        }
        .listRowBackground(Theme.surface)
    }

    private var hero: some View {
        HStack(spacing: Theme.Space.s4) {
            ProfileAvatarView(pictureKey: isMine ? profileState.ownPictureKey : nil,
                              uploaded: isMine ? profileState.ownUploaded : nil,
                              placeholder: String(authState.username.prefix(1)).uppercased())
                .frame(width: 72, height: 72)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                Text("Signed in as")
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
                Text(authState.username)
                    .font(.title3.bold())
                    .foregroundColor(Theme.textPrimary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Space.s1)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Your profile picture is what other players see")
        .accessibilityIdentifier("profile.hero")
    }

    /// A picture change needs the connection (fixture mode has none and answers by itself).
    private var canChangePicture: Bool {
        #if DEBUG
        if UIFixture.isActive { return !profileState.pictureBusy }
        #endif
        return !profileState.pictureBusy && socketService.isConnected
    }

    /// Upload Photo: the system photo picker (it runs out of process, so no photo-library
    /// permission or usage string is needed).
    @ViewBuilder
    private var uploadRow: some View {
        let label = Label("Upload Photo", systemImage: "photo")
            .foregroundColor(Theme.primary)
        let disabled = !canChangePicture
        #if DEBUG
        if UIFixture.picksSamplePhoto {
            // fixture mode: no system picker in a UI test; the sample goes through the same crop and send
            Button { profileState.upload(imageData: UIFixture.samplePhotoData()) } label: { label }
                .disabled(disabled)
                .accessibilityIdentifier("profile.uploadPhoto")
        } else {
            PhotosPicker(selection: $pickedPhoto, matching: .images) { label }
                .disabled(disabled)
                .accessibilityIdentifier("profile.uploadPhoto")
        }
        #else
        PhotosPicker(selection: $pickedPhoto, matching: .images) { label }
            .disabled(disabled)
            .accessibilityIdentifier("profile.uploadPhoto")
        #endif
    }
}

/// What the own-profile rows start, attached to the Account sheet's List (alive whichever rows
/// are on screen): the first `getProfile`, the picked photo's upload, the avatar picker sheet
/// and the VoiceOver announcement of a picture change's outcome.
struct OwnProfileHost: ViewModifier {
    @Binding var pickedPhoto: PhotosPickerItem?
    @Binding var showsAvatarPicker: Bool

    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var profileState: ProfileState
    @EnvironmentObject var leaderboardState: LeaderboardState

    private var isMine: Bool { profileState.ownUsername == authState.username }

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard !authState.username.isEmpty else { return }
                profileState.requestOwn(username: authState.username, scope: leaderboardState.scope)
            }
            .onChange(of: profileState.pictureNotice) { _, notice in
                if let notice { A11y.announce(notice.message) }
            }
            .onChange(of: pickedPhoto) { _, item in
                guard let item else { return }
                pickedPhoto = nil
                Task { @MainActor in
                    guard let data = try? await item.loadTransferable(type: Data.self) else {
                        profileState.uploadFailed()
                        return
                    }
                    // decode, crop and encode off the main thread (a large photo takes a moment)
                    let made = await Task.detached(priority: .userInitiated) { ProfilePicture.upload(from: data) }.value
                    profileState.upload(prepared: made)
                }
            }
            .sheet(isPresented: $showsAvatarPicker) {
                AvatarPickerView(current: isMine && profileState.ownAvatarPath == nil && profileState.ownUploaded == nil ? profileState.ownStockPic : nil)
            }
    }
}

/// Choose Avatar: the stock pictures 1...82 in a grid, the current one marked (the web's
/// openPictureSelector). A tap sends it and closes the sheet; the Account sheet shows the result.
struct AvatarPickerView: View {
    /// My stock picture when that is what shows (nil with a custom picture).
    let current: Int?

    @EnvironmentObject var profileState: ProfileState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 68, maximum: 96), spacing: Theme.Space.s3)], spacing: Theme.Space.s3) {
                        ForEach(1...ProfilePicture.stockCount, id: \.self) { n in
                            cell(n).id(n)
                        }
                    }
                    .padding(Theme.Space.s4)
                }
                .onAppear {
                    // after the grid's first layout (a lazy grid knows no offscreen cell before it)
                    DispatchQueue.main.async { if let current { proxy.scrollTo(current, anchor: .center) } }
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Select Profile Picture")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetCloseButton(identifier: "avatarPicker.close") { dismiss() } }
            }
        }
        .accessibilityIdentifier("avatarPicker")
    }

    private func cell(_ n: Int) -> some View {
        let isCurrent = n == current
        return Button {
            profileState.chooseStockPic(n)
            dismiss()
        } label: {
            ProfileAvatarView(pictureKey: String(n), placeholder: String(n))
                .overlay(Circle().stroke(isCurrent ? Theme.primary : Color.clear, lineWidth: 3))
                .overlay(alignment: .bottomTrailing) {
                    if isCurrent {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Theme.buttonForeground, Theme.primary)
                            .accessibilityHidden(true)
                    }
                }
                .frame(minWidth: Theme.hitTarget, minHeight: Theme.hitTarget)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Avatar \(n)")
        .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
        .accessibilityIdentifier("avatarPicker.\(n)")
    }
}
