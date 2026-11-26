import SwiftUI

/// A profile's badges (the web's createBadgesSection, below the statistics): the heading and
/// the badges that player has earned, each its picture, name and description, oldest first;
/// "No badges yet." when there are none. Only badges the server sent are ever drawn (the
/// catalog stays on the server: an unearned badge is a surprise). A grid at the standard text
/// sizes (as many 104 pt columns as fit: three on a phone, more on the iPad and the open Duo),
/// one row per badge with the picture beside the words at the accessibility sizes.
struct ProfileBadgesSection: View {
    let badges: [EarnedBadge]
    @Environment(\.dynamicTypeSize) private var typeSize

    static let emptyNote = "No badges yet."

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s3) {
            Text("Badges")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)

            if badges.isEmpty {
                Text(Self.emptyNote)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("profile.badgesEmpty")
            } else if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Theme.Space.s3) {
                    ForEach(badges) { BadgeRow(badge: $0) }
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: Theme.Space.s2, alignment: .top)],
                          spacing: Theme.Space.s2) {
                    ForEach(badges) { BadgeTile(badge: $0) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile.badges")
    }
}

/// One badge in the grid: the picture over its name and description.
private struct BadgeTile: View {
    let badge: EarnedBadge

    var body: some View {
        VStack(spacing: Theme.Space.s1) {
            BadgeArtView(id: badge.id)
                .frame(width: 64, height: 64)
            Text(badge.name)
                .font(.subheadline.bold())
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if !badge.description.isEmpty {
                Text(badge.description)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .padding(.vertical, Theme.Space.s2)
        .padding(.horizontal, Theme.Space.s1)
        .background(Theme.surfaceLight)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .badgeAccessibility(badge)
    }
}

/// One badge at the accessibility text sizes: the picture beside the words.
private struct BadgeRow: View {
    let badge: EarnedBadge

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s3) {
            BadgeArtView(id: badge.id)
                .frame(width: 48, height: 48)
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                Text(badge.name)
                    .font(.subheadline.bold())
                    .foregroundStyle(Theme.textPrimary)
                if !badge.description.isEmpty {
                    Text(badge.description)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Theme.Space.s2)
        .background(Theme.surfaceLight)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .badgeAccessibility(badge)
    }
}

private extension View {
    /// One VoiceOver element per badge: "Felted, Ended a game with a negative score."
    func badgeAccessibility(_ badge: EarnedBadge) -> some View {
        accessibilityElement(children: .ignore)
            .accessibilityLabel(badge.description.isEmpty ? badge.name : "\(badge.name), \(badge.description)")
            .accessibilityIdentifier("profile.badge.\(badge.id)")
    }
}

/// A badge's picture (the asset `Badges/<id>`, drawn from its vector data at any size);
/// nothing for an id this build has no art for. Decorative: the words name the badge.
struct BadgeArtView: View {
    let id: String

    var body: some View {
        Group {
            if BadgeArt.exists(id) {
                Image(Badges.artName(id))
                    .resizable()
                    .scaledToFit()
            } else {
                Color.clear
            }
        }
        .accessibilityHidden(true)
    }
}

/// Which badge ids this build has art for (looked up once per id).
enum BadgeArt {
    private static var known: [String: Bool] = [:]

    static func exists(_ id: String) -> Bool {
        if let hit = known[id] { return hit }
        let hit = Badges.isId(id) && PlatformImage(named: Badges.artName(id)) != nil
        known[id] = hit
        return hit
    }
}
