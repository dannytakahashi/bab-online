import SwiftUI

/// The draw for deal's pieces, shared with Cut for a buck's ring (spec section 6, iOS extras: moved
/// out of DrawPhaseView once honest-draw merged): the table's card art, a card that turns over, and
/// a player's avatar as the seats draw one.

// MARK: - Card art

/// A card bitmap from CardTextureGenerator at `size` (its pixels sample 1:1 at
/// the hand card's size), with the table's raised-card shadow.
struct CardArtImage: View {
    let image: PlatformImage
    let size: CGSize

    var body: some View {
        Image(platformImage: image)
            .resizable()
            .interpolation(.high)
            .antialiased(true)
            .frame(width: size.width, height: size.height)
            .elevation(Theme.Elevation.e2)
    }
}

/// A card that turns over around its vertical axis: the back up to 90 degrees,
/// then the face (`flat`, Reduce Motion: no turn, the face replaces the back half way).
struct FlipCard: View, Animatable {
    var angle: Double
    let face: PlatformImage?
    let back: PlatformImage
    let size: CGSize
    let flat: Bool

    var animatableData: Double {
        get { angle }
        set { angle = newValue }
    }

    var body: some View {
        let showsFace = angle >= 90
        CardArtImage(image: showsFace ? (face ?? back) : back, size: size)
            .rotation3DEffect(.degrees(flat ? 0 : showsFace ? angle - 180 : angle), axis: (x: 0, y: 1, z: 0), perspective: 0.4)
    }
}

/// A player as the table's seats show one (OpponentHandNode): a circle in
/// surface.s2 with a line.strong ring and the bold initial, or the seat's picture
/// once the players are seated; mine has a primary ring. Its size is geometry, like
/// the seat's (not type).
struct DrawAvatar: View {
    let name: String?
    let pictureKey: String?
    let isLocal: Bool
    /// The draw's seat size; the cut's ring sizes its own (CutRing.avatarD).
    var diameter: CGFloat = Theme.Space.s8
    @State private var image: PlatformImage?

    var body: some View {
        Group {
            if let name {
                ZStack {
                    Circle().fill(Theme.surfaceLight)
                    if let image {
                        Image(platformImage: image).resizable().scaledToFill()
                    } else {
                        Text(String(name.prefix(1)).uppercased())
                            .font(.system(size: diameter * 0.45, weight: .bold))  // the seat's radius * 0.9
                            .foregroundStyle(Theme.textPrimary)
                    }
                }
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(isLocal ? Theme.primary : Theme.inputBorder, lineWidth: isLocal ? 2 : 1.5))
                .task(id: pictureKey) { image = await AvatarImageCache.image(for: pictureKey) }
            } else {
                Circle()
                    .strokeBorder(Theme.inputBorder, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }
}
