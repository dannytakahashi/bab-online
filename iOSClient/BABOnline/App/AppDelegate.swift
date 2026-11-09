import UIKit

/// Orientation policy (item 27-1). Info.plist allows Portrait and both
/// landscapes on iPhone; the mask narrows it per window scene: an iPad turns
/// freely, a phone window that is regular in both size classes (the open
/// iPhone Duo's inner display) turns except upside down, every other phone
/// window (a compact phone, the Duo's outer display) stays portrait.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        let traits = window?.windowScene?.traitCollection ?? window?.traitCollection
        return Self.mask(idiom: traits?.userInterfaceIdiom ?? UIDevice.current.userInterfaceIdiom,
                         h: traits?.horizontalSizeClass ?? .unspecified,
                         v: traits?.verticalSizeClass ?? .unspecified)
    }

    static func mask(idiom: UIUserInterfaceIdiom, h: UIUserInterfaceSizeClass, v: UIUserInterfaceSizeClass) -> UIInterfaceOrientationMask {
        switch idiom {
        case .pad: return .all
        case .phone where h == .regular && v == .regular: return .allButUpsideDown
        default: return .portrait
        }
    }
}

/// Asks UIKit to re-read the mask after the size classes change.
enum OrientationLock {
    @MainActor
    static func refresh() {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            let root = scene.keyWindow?.rootViewController ?? scene.windows.first?.rootViewController
            root?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
    }
}
