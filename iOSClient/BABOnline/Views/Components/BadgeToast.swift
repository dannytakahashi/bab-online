import SwiftUI

/// The "badge earned" toast (BadgeAwards; the web's toast with `art`): the badges' pictures in
/// place of an icon and the web's words in bold, on the info toast's pill (ServerErrorToast),
/// at the top centre over whatever screen is up (the score screen, or the lobby or main room
/// if the player has left it). A tap dismisses it and the next award shows. One VoiceOver
/// element whose label is the words (the pictures are decorative), announced once when it
/// shows (BadgeAwards). It wraps at any width; at the accessibility text sizes the pictures
/// go above the words, and its type stops growing at accessibility3. In the Duo's book pose
/// it stays on the left page (`FoldReader.bookHinge`), never across the hinge.
struct BadgeToast: View {
    @ObservedObject var awards: BadgeAwards = .shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    #if os(iOS)
    @State private var hingeTick = 0
    #endif

    /// The pill's widest (the voice tip's; readable on the iPad and the open Duo).
    static let maxWidth: CGFloat = 520

    var body: some View {
        GeometryReader { g in
            let _ = hingeRead
            let hinge = FoldReader.bookHinge(g)
            VStack(spacing: 0) {
                if let toast = awards.shown {
                    pill(toast)
                        .frame(maxWidth: min(Self.maxWidth, hinge.map { max(0, $0.lowerBound - 2 * Theme.Space.s4) } ?? .infinity))
                        .padding(.top, Theme.Space.s2)
                        .padding(.horizontal, Theme.Space.s4)
                        .transition(.motion(.move(edge: .top).combined(with: .opacity), reduceMotion: reduceMotion))
                        .id(toast.id)
                }
                Spacer(minLength: 0)
            }
            .frame(width: hinge.map { $0.lowerBound } ?? g.size.width, alignment: .top)
            .frame(maxWidth: .infinity, alignment: hinge == nil ? .center : .leading)
        }
        #if os(iOS)
        .modifier(HingeTick(tick: $hingeTick))
        #endif
        .animation(.easeInOut(duration: 0.3), value: awards.shown?.id)
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }

    /// Read so a hinge change re-evaluates the reader (HingeTick).
    private var hingeRead: Int {
        #if os(iOS)
        hingeTick
        #else
        0
        #endif
    }

    private func pill(_ toast: BadgeAwards.Toast) -> some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Theme.Space.s2))
            : AnyLayout(HStackLayout(spacing: Theme.Space.s3))
        return layout {
            HStack(spacing: Theme.Space.s1) {
                ForEach(toast.art) { badge in
                    BadgeArtView(id: badge.id)
                        .frame(width: 40, height: 40)
                }
            }
            .accessibilityHidden(true)
            Text(toast.text)
                .font(.callout.bold())
                .foregroundColor(Theme.textPrimary)
                .multilineTextAlignment(.leading)
                // wraps at the pill's width, never per glyph
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Theme.Space.s4)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.gold.opacity(0.6), lineWidth: 1))
        .elevation(Theme.Elevation.e2)
        .contentShape(Rectangle())
        .onTapGesture { awards.dismiss() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(toast.text)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Dismisses this notice")
        .accessibilityAction { awards.dismiss() }
        .accessibilityIdentifier("badgeToast")
    }
}
