import SwiftUI

/// A profile's statistics (the web's createStatsSection): the heading, the games counted
/// (Humans / Bots / All, the Stats sheet's one choice) and the twelve-cell grid, with the
/// note under an empty Bot games grid. The last numbers of a scope stay up while it refreshes
/// or after a refresh fails; with none yet it shows the wait, or the failure and a retry.
struct ProfileStatsSection: View {
    let load: ProfileStatsLoad
    @Binding var scope: StatsScope
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s3) {
            Text("Statistics")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)

            Picker("Games", selection: $scope) {
                ForEach(StatsScope.allCases) { s in
                    Text(s.title).accessibilityLabel(s.spokenTitle).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("profile.scope")

            if let stats = load.stats {
                if let failure = load.failure, !load.isLoading {
                    StatsRefreshBanner(failure: failure, retry: retry)
                }
                if scope == .bots && stats.gamesPlayed <= 0 {
                    Text(StatsScope.botStatsEmptyNote)
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("profile.botsEmpty")
                }
                ProfileStatsGrid(stats: stats)
                    .opacity(load.isLoading ? 0.6 : 1)
            } else if let failure = load.failure, !load.isLoading {
                failed(failure)
            } else {
                HStack(spacing: Theme.Space.s3) {
                    ProgressView().tint(Theme.textSecondary)
                    Text("Loading statistics…")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                }
                .frame(maxWidth: .infinity, minHeight: 88)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("profile.loading")
            }
        }
        .sensoryFeedback(.selection, trigger: scope)
    }

    private func failed(_ failure: StatsFailure) -> some View {
        VStack(spacing: Theme.Space.s2) {
            Text(failure.isRateLimited ? "Too many requests. Please wait a moment, then try again." : "Couldn't load statistics: \(failure.message)")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try Again", action: retry)
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.primary)
                .frame(minHeight: Theme.hitTarget)
                .buttonStyle(.borderless)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile.statsError")
    }
}

/// The web's 3 x 4 stats grid; two columns at the accessibility text sizes, where three
/// would truncate "Games Played".
struct ProfileStatsGrid: View {
    let stats: ProfileStats
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: Theme.Space.s2), count: typeSize.isAccessibilitySize ? 2 : 3)
        LazyVGrid(columns: columns, spacing: Theme.Space.s2) {
            ForEach(stats.cells) { cell in
                VStack(spacing: Theme.Space.s1) {
                    Text(cell.value)
                        .font(.title3.bold().monospacedDigit())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(cell.label)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, minHeight: 56)
                .padding(.vertical, Theme.Space.s2)
                .padding(.horizontal, Theme.Space.s1)
                .background(Theme.surfaceLight)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(cell.spokenLabel)
                .accessibilityValue(cell.value)
                .accessibilityIdentifier("profile.stat.\(cell.id)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile.stats")
    }
}

/// A profile's round picture: the image just uploaded when there is one, else the picture key
/// from the avatar caches (a stock number or an `/avatar` path), else `placeholder`. Stock art
/// and uploads (the web's and ours: ProfilePicture) are a circle inside a 16% transparent
/// margin, so the image is drawn larger by that margin and the picture fills this circle.
struct ProfileAvatarView: View {
    let pictureKey: String?
    var uploaded: UIImage?
    /// Shown until the picture loads (the name's initial, a stock number).
    let placeholder: String
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { g in
            ZStack {
                Circle().fill(Theme.surfaceRaised)
                if let shown = uploaded ?? image {
                    Image(uiImage: shown).resizable().scaledToFill()
                        .frame(width: g.size.width, height: g.size.height)
                        .scaleEffect(1 / (1 - 2 * ProfilePicture.padding))
                } else {
                    Text(placeholder)
                        .font(.system(size: max(10, g.size.width * 0.36), weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                }
            }
            .frame(width: g.size.width, height: g.size.height)
            .clipShape(Circle())
        }
        .aspectRatio(1, contentMode: .fit)
        .task(id: pictureKey) { image = await AvatarImageCache.image(for: pictureKey) }
    }
}

/// The sheet's close button: the system's (an xmark, which also sits in the Duo's vertical
/// bar) where the SDK has it, else "Done".
struct SheetCloseButton: View {
    let identifier: String
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close, action: action)
                .accessibilityIdentifier(identifier)
        } else {
            Button("Done", action: action)
                .accessibilityIdentifier(identifier)
        }
    }
}
