import SwiftUI

/// Who is watching (V1_REMOVALS "iOS spectator badge"): an eye and the count at
/// the layout's `spectatorBadge` rect, hidden at 0; "99+" past 99. A tap opens
/// the names with their avatars ("(you)" on mine; scrolls past ~8; "and N more"
/// past the server's 50). VoiceOver: "2 people watching", a button. A watcher looking over a
/// seat's shoulder reads "Zach · watching Alice" (`seatNames`: the seats' names now; the
/// spectator entries' `shoulder`, WatchingList+Shoulder.swift).
///
/// The badge sits in a fixed 60 x 44 pt rect between the trick cards, the seats
/// and HSI / voice, so its text stops growing at Dynamic Type .large, where "99+"
/// still fits (SpectatorBadgeFitTests); a long press shows it in the Large
/// Content Viewer at the larger sizes, as a tab bar does.
///
/// Spectator voice: while a spectator other than me talks (`speaking`, SpeakingWatchers: never
/// a seated player, whose seat glows, never me, whose ring is my mic's) the capsule's outline is
/// the speaking green (Theme.success at 2 pt, the mic's ring; no pulse, as no speaking ring
/// pulses), the list marks each talker's row with the voice panel's speaking dot, and the
/// VoiceOver value says who ("Bo is talking"). The badge's size and 44 pt target do not change.
struct SpectatorBadgeView: View {
    let watching: WatchingList
    let myUsername: String?
    var seatNames: [Int: String] = [:]
    var speaking: SpeakingWatchers = .none
    @State private var showsList = false

    var body: some View {
        Button { showsList = true } label: {
            HStack(spacing: Theme.Space.s1) {
                Image(systemName: "eye.fill")
                    .font(.caption)
                    .imageScale(.small)
                Text(watching.badgeText)
                    .font(.caption.bold().monospacedDigit())
                    .lineLimit(1)
                    .fixedSize()  // never squeezed: the layout's rect is sized for "99+" (SpectatorBadgeFitTests)
            }
            .foregroundColor(Theme.textPrimary)
            .padding(.horizontal, Theme.Space.s2)
            .padding(.vertical, Theme.Space.s2)
            .background(Capsule().fill(Theme.Palette.Surface.s2.opacity(0.86).color))
            .overlay(Capsule().stroke(speaking.isLit ? Theme.success : Theme.inputBorder, lineWidth: speaking.isLit ? 2 : 1))
            .dynamicTypeSize(...DynamicTypeSize.large)
            .frame(minWidth: 44, minHeight: 44)  // the 44 pt target (HIG)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityShowsLargeContentViewer {
            Image(systemName: "eye.fill")
            Text(watching.accessibilityLabel)
        }
        .accessibilityLabel(watching.accessibilityLabel)
        .accessibilityValue(speaking.accessibilityValue)
        .accessibilityHint("Shows who is watching")
        .accessibilityIdentifier("table.spectators")
        .popover(isPresented: $showsList, arrowEdge: .bottom) {
            SpectatorListView(watching: watching, myUsername: myUsername, seatNames: seatNames, speaking: speaking)
                .presentationCompactAdaptation(.popover)
        }
        #if DEBUG
        .onChange(of: speaking, initial: true) { _, s in
            guard UIFixture.isActive else { return }
            TableDebugProbe.shared.spectatorsSpeaking =
                "lit=\(s.isLit ? 1 : 0) names=\(s.names.isEmpty ? "-" : s.names.joined(separator: ",")) unnamed=\(s.unnamed)"
        }
        .onDisappear {
            if UIFixture.isActive { TableDebugProbe.shared.spectatorsSpeaking = "-" }
        }
        #endif
    }
}

/// The popover's list of watchers.
struct SpectatorListView: View {
    let watching: WatchingList
    let myUsername: String?
    var seatNames: [Int: String] = [:]
    /// Who of them talks now: the voice panel's speaking dot on their row.
    var speaking: SpeakingWatchers = .none

    static let rowHeight: CGFloat = 44
    static let visibleRows = 8

    var more: Int { max(0, watching.count - watching.spectators.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Watching")
                .font(.subheadline.bold())
                .padding(.horizontal, 14)
                .padding(.top, Theme.Space.s3)
                .padding(.bottom, 6)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(watching.spectators) { w in
                        HStack(spacing: 10) {
                            AvatarImageView(pictureKey: w.pictureKey, name: w.username)
                                .frame(width: 28, height: 28)
                                .accessibilityHidden(true)
                            Text(WatchingList.rowText(w, me: myUsername, seatName: { seatNames[$0] }))
                                .font(.body)
                                .lineLimit(w.shoulder == nil ? 1 : 2)
                            if speaking.isTalking(w.username) {
                                Spacer(minLength: 0)
                                // the voice panel's speaking dot (VoicePanelSheet.speakingDot)
                                Circle()
                                    .fill(Theme.success)
                                    .frame(width: 10, height: 10)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: Self.rowHeight)
                        .padding(.horizontal, 14)
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(speaking.isTalking(w.username) ? "Talking" : "")
                    }
                    if more > 0 {
                        Text("and \(more) more")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                            .frame(minHeight: Self.rowHeight)
                            .padding(.horizontal, 14)
                    }
                }
            }
            .frame(maxHeight: Self.rowHeight * CGFloat(Self.visibleRows))
            .fixedSize(horizontal: false, vertical: watching.spectators.count + (more > 0 ? 1 : 0) <= Self.visibleRows)
        }
        .frame(minWidth: 200, maxWidth: 280)
        .padding(.bottom, Theme.Space.s2)
    }
}

/// A round avatar from the same loader as the table seats (stock number or `/avatar` URL), else the initial.
struct AvatarImageView: View {
    let pictureKey: String?
    let name: String
    @State private var image: PlatformImage?

    var body: some View {
        ZStack {
            Circle().fill(Theme.surfaceRaised)
            if let image {
                Image(platformImage: image).resizable().scaledToFill()
            } else {
                Text(String(name.prefix(1)).uppercased())
                    .font(.caption.bold())
                    .foregroundColor(Theme.textPrimary)
            }
        }
        .clipShape(Circle())
        .task(id: pictureKey) { image = await AvatarImageCache.image(for: pictureKey) }
    }
}

/// UIImages for SwiftUI rows, one load per picture key (the scene keeps its own textures).
@MainActor
enum AvatarImageCache {
    private static let cache = NSCache<NSString, PlatformImage>()

    static func image(for key: String?) async -> PlatformImage? {
        guard let key else { return nil }
        if let hit = cache.object(forKey: key as NSString) { return hit }
        let loader = OpponentHandNode.avatarLoader
        let image: PlatformImage? = await withCheckedContinuation { cont in
            if let n = Int(key) {
                loader.load(n) { cont.resume(returning: $0) }
            } else if key.hasPrefix("/avatar/") {
                loader.load(path: key) { cont.resume(returning: $0) }
            } else {
                cont.resume(returning: nil)
            }
        }
        if let image { cache.setObject(image, forKey: key as NSString) }
        return image
    }
}
