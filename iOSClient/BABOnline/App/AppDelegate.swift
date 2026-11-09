import UIKit

/// Orientation policy (item 27-1). Info.plist allows Portrait and both
/// landscapes on iPhone; the mask narrows it per window scene: an iPad turns
/// freely; a phone turns (except upside down) only when its display is at
/// least `landscapeMinSide` on its short side (the open iPhone Duo's 669 x 951
/// inner display); every other phone (a compact phone, the Duo's 466 x 678
/// outer display) stays portrait.
///
/// The test is the display's short side, not the size classes: the short side
/// is the same in portrait and landscape, so the mask cannot change because of
/// the rotation it allowed (a size-class rule could flip back and forth when a
/// landscape window reports compact height).
final class AppDelegate: NSObject, UIApplicationDelegate {
    static let landscapeMinSide: CGFloat = 600

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        let scene = window?.windowScene
        let idiom = scene?.traitCollection.userInterfaceIdiom ?? window?.traitCollection.userInterfaceIdiom ?? UIDevice.current.userInterfaceIdiom
        let screen = scene?.screen.bounds.size ?? window?.bounds.size ?? .zero
        return Self.mask(idiom: idiom, screen: screen)
    }

    static func mask(idiom: UIUserInterfaceIdiom, screen: CGSize) -> UIInterfaceOrientationMask {
        switch idiom {
        case .pad: return .all
        case .phone where min(screen.width, screen.height) >= landscapeMinSide: return .allButUpsideDown
        default: return .portrait
        }
    }
}

/// Asks UIKit to re-read the mask after the display changes (a Duo fold or
/// unfold changes the size classes and the screen together).
enum OrientationLock {
    @MainActor
    static func refresh() {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            let root = scene.keyWindow?.rootViewController ?? scene.windows.first?.rootViewController
            root?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
    }
}
