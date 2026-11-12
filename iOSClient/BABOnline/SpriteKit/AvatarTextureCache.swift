import SpriteKit
import UIKit

/// Seat avatars as ready-to-draw circular textures, shared by every seat and
/// every table for the app's lifetime (main thread only, like the scene).
///
/// - Keyed by the picture string (a stock number, a data URL or an `/avatar`
///   URL path, which carries the picture's version): a seat built
///   again for a new game, or four seats with the same stock picture, reuse one
///   texture and one fetch.
/// - Stock pictures load once: callers that ask while the fetch is in flight
///   wait for it (no second request). A failed load is not cached (the next
///   seat build tries again).
/// - The texture is already cut to the circle (`diameter` points at the screen
///   scale), so a seat draws one sprite and no SKCropNode (a crop node is an
///   extra mask pass every frame).
enum AvatarTextureCache {
    /// The avatar circle's diameter in points (OpponentHandNode's radius 20).
    static let diameter: CGFloat = 40
    private static let cache: NSCache<NSString, SKTexture> = {
        let c = NSCache<NSString, SKTexture>()
        c.countLimit = 64  // ~57 KB each at 3x
        return c
    }()
    private static var waiting: [String: [(SKTexture?) -> Void]] = [:]
    #if DEBUG
    /// Stock-picture loads started (tests: one per picture, not per seat or game).
    private(set) static var fetches = 0
    #endif

    static func cached(_ pic: String) -> SKTexture? { cache.object(forKey: pic as NSString) }

    /// The texture for `pic`: synchronously when cached or a data URL, else after
    /// `loader` answers (on the main queue). nil when it cannot be loaded.
    static func texture(for pic: String, loader: AvatarLoading, completion: @escaping (SKTexture?) -> Void) {
        if let hit = cached(pic) { return completion(hit) }
        if pic.starts(with: "data:image"), let comma = pic.firstIndex(of: ",") {
            let tex = Data(base64Encoded: String(pic[pic.index(after: comma)...]))
                .flatMap { UIImage(data: $0) }
                .map(circular)
            if let tex { cache.setObject(tex, forKey: pic as NSString) }
            return completion(tex)
        }
        let start: (@escaping (UIImage?) -> Void) -> Void
        if let number = Int(pic) {
            start = { loader.load(number, completion: $0) }
        } else if pic.hasPrefix("/avatar/") {
            // a custom picture's versioned URL (clientHello avatarUrl cap): the key is the version
            start = { loader.load(path: pic, completion: $0) }
        } else {
            return completion(nil)
        }
        if waiting[pic] != nil {
            waiting[pic]?.append(completion)
            return
        }
        waiting[pic] = [completion]
        #if DEBUG
        fetches += 1
        #endif
        start { image in
            let tex = image.map(circular)
            if let tex { cache.setObject(tex, forKey: pic as NSString) }
            let callbacks = waiting.removeValue(forKey: pic) ?? []
            callbacks.forEach { $0(tex) }
        }
    }

    /// `image` filled into a `diameter`-point circle (centered, aspect fill) at the screen scale.
    static func circular(_ image: UIImage) -> SKTexture {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        format.preferredRange = .standard
        let side = CGSize(width: diameter, height: diameter)
        let out = UIGraphicsImageRenderer(size: side, format: format).image { _ in
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: side)).addClip()
            let s = image.size
            let k = s.width > 0 && s.height > 0 ? max(diameter / s.width, diameter / s.height) : 1
            let w = s.width * k, h = s.height * k
            image.draw(in: CGRect(x: (diameter - w) / 2, y: (diameter - h) / 2, width: w, height: h))
        }
        let tex = SKTexture(image: out)
        tex.filteringMode = .linear
        return tex
    }

    #if DEBUG
    /// Tests only: forget every texture, waiter and counter.
    static func resetForTesting() {
        cache.removeAllObjects()
        waiting = [:]
        fetches = 0
    }
    #endif
}
