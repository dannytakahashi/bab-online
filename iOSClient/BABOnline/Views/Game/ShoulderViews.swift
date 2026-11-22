import SwiftUI

// The over-the-shoulder view's own views (State/Table/Shoulder.swift; owner 2026-11-21): the
// watching pill at the bottom (where a spectator's and a lazy watcher's pill go), the watched
// seat's bid clock where its bid bubble will show, and the paused hand area. GameContainerView
// places them; nothing here can bid, play, ask /help or touch the tutorial.

/// The bottom pill while watching: the watched player (their avatar, with the speaking ring, and
/// "Watching Alice's hand", or "... · paused"; a tap opens their profile: there is no avatar of
/// the bottom seat on the felt) and "Table view" (back to the plain spectator view, remembered for
/// this game). VoiceOver: the pill's actions watch another seat ("Watch Bo's hand").
struct WatchingPill: View {
    let player: String
    let pictureKey: String?
    var paused = false
    /// The watched player is talking (voice): the avatar's ring, as a seat's speaking glow.
    var speaking = false
    /// It is the watched seat's turn: the avatar's gold ring (a seat's turn glow; the bottom seat has no avatar).
    var isTurn = false
    /// Seats a VoiceOver action may watch instead (position, name).
    var others: [(position: Int, name: String)] = []
    var onProfile: () -> Void
    var onTableView: () -> Void
    var onWatch: (Int) -> Void = { _ in }

    var text: String { ShoulderRules.pillText(player, paused: paused) }

    var body: some View {
        HStack(spacing: Theme.Space.s2) {
            Button(action: onProfile) {
                HStack(spacing: Theme.Space.s2) {
                    AvatarImageView(pictureKey: pictureKey, name: player)
                        .frame(width: 24, height: 24)
                        .overlay(Circle().stroke(speaking ? Theme.success : isTurn ? Theme.gold : Theme.inputBorder, lineWidth: speaking || isTurn ? 2.5 : 1))
                        .accessibilityHidden(true)
                    // the name shortens first: Table view is never cut
                    Text(text)
                        .font(.caption.bold())
                        .foregroundColor(Theme.teamA)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(text)
            .accessibilityValue([speaking ? "Talking" : nil, isTurn ? "Their turn" : nil].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint("Opens \(ShoulderRules.possessive(player)) profile")
            .accessibilityIdentifier("shoulder.pill")
            .accessibilityActions {
                ForEach(others, id: \.position) { o in
                    Button("Watch \(ShoulderRules.possessive(o.name)) hand") { onWatch(o.position) }
                }
            }
            Button(action: onTableView) {
                Text(ShoulderRules.tableViewLabel)
                    .font(.caption.bold())
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, Theme.Space.s3)
                    .padding(.vertical, Theme.Space.s1)
                    .secondaryButtonStyle()
            }
            .layoutPriority(1)
            .accessibilityLabel(ShoulderRules.tableViewLabel)
            .accessibilityHint(ShoulderRules.tableViewHint)
            .accessibilityIdentifier("shoulder.tableView")
        }
    }
}


/// The watched hand area while the table is paused (no stale cards).
struct ShoulderPausedNote: View {
    let player: String

    var body: some View {
        Label {
            Text(ShoulderRules.pausedText(player))
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "pause.circle.fill").accessibilityHidden(true)
        }
        .font(.footnote.weight(.semibold))
        .foregroundColor(Theme.textPrimary)
        .padding(.horizontal, Theme.Space.s3)
        .padding(.vertical, Theme.Space.s2)
        .background(Capsule().fill(Theme.surface.opacity(0.92)))
        .overlay(Capsule().strokeBorder(Theme.inputBorder, lineWidth: 1))
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("shoulder.paused")
    }
}
