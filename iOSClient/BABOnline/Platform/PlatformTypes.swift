import SwiftUI
import SpriteKit
#if os(iOS)
import UIKit
#endif

// The platform's image, colour and font types and the few calls that differ between UIKit
// and AppKit (iOSClient/CLAUDE.md, "iOS project": the platform rules). Shared code names
// these, never UIImage / UIColor / UIFont / UIDevice / UIScreen. On iOS each alias IS the
// UIKit type and each helper is the UIKit call the code made before, so the iOS program is
// unchanged; the macOS halves land with the macOS platform.

/// The kind of device the app runs on: what `UIDevice.userInterfaceIdiom` answered.
enum DeviceClass: Equatable {
    case phone, pad, mac
}

#if os(iOS)
typealias PlatformImage = UIImage
/// SpriteKit's SKColor.
typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
typealias PlatformBezierPath = UIBezierPath
/// An SF Symbol's weight (PlatformImage.tintedSymbol).
typealias PlatformSymbolWeight = UIImage.SymbolWeight

extension DeviceClass {
    /// `.phone` on an iPhone (the Duo open or closed), else `.pad` (read each time, as
    /// `UIDevice.current.userInterfaceIdiom` was).
    static var current: DeviceClass { UIDevice.current.userInterfaceIdiom == .phone ? .phone : .pad }
}

enum Platform {
    /// The screen scale bitmaps are rendered for.
    static var displayScale: CGFloat { UIGraphicsImageRendererFormat.preferred().scale }

    /// The key window's width inside its safe area (the first window without a key one);
    /// nil without a window or before it has a size.
    @MainActor
    static func keyWindowSafeWidth() -> CGFloat? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first, window.bounds.width > 0 else { return nil }
        return window.bounds.inset(by: window.safeAreaInsets).width
    }
}

extension PlatformColor {
    /// A token's sRGB components (Generated/Theme.swift `uiColor`).
    static func token(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) -> PlatformColor {
        UIColor(red: red, green: green, blue: blue, alpha: alpha)
    }
}

extension PlatformImage {
    /// The bitmap (UIImage.cgImage).
    var cgImageValue: CGImage? { cgImage }

    /// `cgImage`'s pixels as an image of `scale` pixels per point, upright.
    convenience init(cgImage: CGImage, scale: CGFloat) {
        self.init(cgImage: cgImage, scale: scale, orientation: .up)
    }

    /// The SF Symbol `name` at `pointSize` / `weight`, drawn in `colour` (nil when the system
    /// has no such symbol).
    static func tintedSymbol(_ name: String, pointSize: CGFloat, weight: PlatformSymbolWeight,
                             colour: PlatformColor) -> PlatformImage? {
        let config = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
        return UIImage(systemName: name, withConfiguration: config)?
            .withTintColor(colour, renderingMode: .alwaysOriginal)
    }
}

extension Image {
    init(platformImage: PlatformImage) {
        self.init(uiImage: platformImage)
    }
}

extension SKTexture {
    /// A texture of `image` (its point size).
    static func make(_ image: PlatformImage) -> SKTexture {
        SKTexture(image: image)
    }
}

extension PlatformFont {
    /// The text style's font at `typeSize` (Dynamic Type).
    static func preferred(_ style: Font.TextStyle, typeSize: DynamicTypeSize) -> PlatformFont {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
        return UIFont.preferredFont(forTextStyle: style.uiKit, compatibleWith: traits)
    }
}

extension Theme {
    /// `size` scaled for the user's Dynamic Type relative to `style` (UIFontMetrics).
    static func scaled(_ size: CGFloat, relativeTo style: Font.TextStyle) -> CGFloat {
        UIFontMetrics(forTextStyle: style.uiKit).scaledValue(for: size)
    }
}

private extension Font.TextStyle {
    var uiKit: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        default: return .body
        }
    }
}
#endif
