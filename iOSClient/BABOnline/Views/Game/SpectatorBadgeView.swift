import SwiftUI
import UIKit

/// Who is watching (V1_REMOVALS "iOS spectator badge"): an eye and the count at
/// the layout's `spectatorBadge` rect, hidden at 0. A tap opens the names with
/// their avatars ("(you)" on mine; scrolls past ~8; "and N more" past the
/// server's 50). VoiceOver: "2 people watching", a button.
struct SpectatorBadgeView: View {
    let watching: WatchingList
    let myUsername: String?
    @State private var showsList = false

    var body: some View {
        Button { showsList = true } label: {
            HStack(spacing: Theme.Space.s1) {
                Image(systemName: "eye.fill")
                    .imageScale(.small)
                Text("\(watching.count)")
                    .font(.caption.bold().monospacedDigit())
            }
            .foregroundColor(Theme.textPrimary)
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, Theme.Space.s2)
            .background(Capsule().fill(Theme.Palette.Surface.s2.opacity(0.86).color))
            .overlay(Capsule().stroke(Theme.inputBorder, lineWidth: 1))
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .frame(minWidth: 44, minHeight: 44)  // the 44 pt target (HIG)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(watching.accessibilityLabel)
        .accessibilityHint("Shows who is watching")
        .accessibilityIdentifier("table.spectators")
        .popover(isPresented: $showsList, arrowEdge: .bottom) {
            SpectatorListView(watching: watching, myUsername: myUsername)
                .presentationCompactAdaptation(.popover)
        }
    }
}

/// The popover's list of watchers.
struct SpectatorListView: View {
    let watching: WatchingList
    let myUsername: String?

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
                            Text(w.username == myUsername ? "\(w.username) (you)" : w.username)
                                .font(.body)
                                .lineLimit(1)
                        }
                        .frame(minHeight: Self.rowHeight)
                        .padding(.horizontal, 14)
                        .accessibilityElement(children: .combine)
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
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Circle().fill(Theme.surfaceRaised)
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
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
    private static let cache = NSCache<NSString, UIImage>()

    static func image(for key: String?) async -> UIImage? {
        guard let key else { return nil }
        if let hit = cache.object(forKey: key as NSString) { return hit }
        let loader = OpponentHandNode.avatarLoader
        let image: UIImage? = await withCheckedContinuation { cont in
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
