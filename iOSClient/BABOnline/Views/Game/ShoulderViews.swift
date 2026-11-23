import SwiftUI

// The over-the-shoulder view's own views (State/Table/Shoulder.swift; owner 2026-11-21): the
// watching pill at the bottom (where a spectator's and a lazy watcher's pill go), the watched
// seat's bid clock where its bid bubble will show, and the paused hand area. GameContainerView
// places them; nothing here can bid, play, ask /help or touch the tutorial.

/// The bottom pill while watching: the watched player (their avatar, with the speaking ring and
/// their avatar badge (SeatBadgeChip: the lightbulb / graduation cap the felt's avatars carry), and
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
    /// The watched seat's avatar badge (SeatBadge.of: its lightbulb or graduation cap), as a seat
    /// avatar's on the felt: the bottom seat has none there, so the pill's avatar carries it.
    var badge: SeatBadge? = nil
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
                        .frame(width: Self.avatar, height: Self.avatar)
                        .overlay(Circle().stroke(speaking ? Theme.success : isTurn ? Theme.gold : Theme.inputBorder, lineWidth: speaking || isTurn ? 2.5 : 1))
                        .shoulderBadgeProbe("avatar")
                        .overlay {
                            if let badge {
                                SeatBadgeChip(badge: badge)
                                    .shoulderBadgeProbe("chip")  // inside the offset: its drawn frame
                                    .offset(Self.chipOffset)
                            }
                        }
                        // the chip sticks out past the avatar's trailing side: room for it before the name
                        .padding(.trailing, badge == nil ? 0 : Self.chipRoom)
                        .accessibilityHidden(true)
                    // the name shortens first: Table view is never cut
                    Text(text)
                        .font(.caption.bold())
                        .foregroundColor(Theme.teamA)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .shoulderBadgeProbe("text")
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(text)
            .accessibilityValue([speaking ? "Talking" : nil, isTurn ? "Their turn" : nil, badge?.spokenValue].compactMap { $0 }.joined(separator: ", "))
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
        #if DEBUG
        .onChange(of: badge, initial: true) { _, b in
            if UIFixture.isActive { TableDebugProbe.shared.shoulderBadgeKind = b?.rawValue ?? "-" }
        }
        .onDisappear { if UIFixture.isActive { TableDebugProbe.shared.shoulderBadgeKind = nil } }
        #endif
    }

    /// The avatar's side (points).
    static let avatar: CGFloat = 24
    /// The chip's centre from the avatar's: `chipDistance` out, 30 degrees above the trailing
    /// side's horizontal, so the chip (12 across) stays 0.75 pt outside the rings (radius 12 +
    /// 1.25 for the 2.5 pt stroke) and its top inside the pill's 8 pt padding.
    static let chipDistance: CGFloat = 20
    static let chipOffset = CGSize(width: chipDistance * cos(.pi / 6), height: -chipDistance * sin(.pi / 6))
    /// The room added after the avatar while it has a chip: the chip's trailing edge (12 +
    /// 17.3 + 6 = 35.3 from the avatar's leading edge) clears the name by about 2.7 pt.
    static let chipRoom: CGFloat = 6
}

/// A seat's avatar badge drawn in SwiftUI (the watching pill's avatar): SeatBadgeNode's dark disc
/// with the lightbulb in gold or the graduation cap in primary (Theme.Badge, the scene's
/// `Theme.SK.badge*`), smaller for the pill's 24 pt avatar. Drawn only: the pill's value says it.
struct SeatBadgeChip: View {
    let badge: SeatBadge
    var size: CGFloat = 12

    var body: some View {
        Circle()
            .fill(Theme.Badge.fill)
            .overlay(Circle().strokeBorder(Theme.Badge.edge, lineWidth: 1))
            .overlay(
                Image(systemName: badge.symbol)
                    .resizable()
                    .scaledToFit()
                    .fontWeight(.semibold)
                    .foregroundColor(badge == .bulb ? Theme.Badge.bulb : Theme.Badge.cap)
                    .padding(size * 0.2)
            )
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

extension View {
    /// Fixture mode: this view's global frame under `key` in the "table.shoulderBadge" probe.
    @ViewBuilder
    func shoulderBadgeProbe(_ key: String) -> some View {
        #if DEBUG
        if UIFixture.isActive {
            onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { TableDebugProbe.shared.shoulderBadgeFrames[key] = $0 }
        } else {
            self
        }
        #else
        self
        #endif
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
