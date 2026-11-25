import Foundation
import CoreGraphics
import ImageIO

/// Profile pictures: the stock range and the upload's image, made the way the web makes it
/// (ProfilePage.js `resizeImage`): the photo's centre square, scaled into a circle that leaves
/// 16% of the side transparent on every edge (the stock art has the same margin, so an upload
/// and a stock picture are the same size at a seat), as a 200 px PNG data URL. The server
/// re-encodes it (WebP, at most 256 px) and adds no mask of its own (docs/avatars.md).
enum ProfilePicture {
    /// Stock pictures are 1...82 (server `STOCK_AVATAR_COUNT`, web `STOCK_MAX`;
    /// server/avatar/__tests__/stockAvatars.test.js holds this copy to them).
    static let stockCount = 82

    /// A stock number in range, else picture 1 (the server's own default).
    static func stock(_ n: Int?) -> Int {
        guard let n, (1...stockCount).contains(n) else { return 1 }
        return n
    }

    /// The upload's side in pixels (the web sends 200).
    static let side = 200
    /// The transparent margin on each edge, as a share of the side.
    static let padding: CGFloat = 0.16
    /// uploadProfilePic's `imageData` limit (contract c2s; the handler's own 500 KB check allows 682,666).
    static let maxDataURLLength = 682_666
    /// A picked photo is decoded at most this large before the crop (a 48 MP photo never is in full).
    static let decodePixels = 800

    enum Failure: Error, Equatable {
        case unreadable, tooLarge

        var message: String {
            switch self {
            case .unreadable: return "Failed to process image. Please try again."
            case .tooLarge: return "Image too large. Maximum size is 500KB."
            }
        }
    }

    /// A picked file's image, downsampled and turned upright (EXIF) while decoding.
    static func decode(_ data: Data) -> PlatformImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: decodePixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { PlatformImage(cgImage: $0) }
    }

    /// `image`'s centre square in the padded circle, `side` pixels square, transparent outside.
    static func render(_ image: PlatformImage) -> PlatformImage {
        let full = CGFloat(side)
        let inset = full * padding
        let inner = CGRect(x: inset, y: inset, width: full - inset * 2, height: full - inset * 2)
        return BitmapRenderer.image(pixelSize: CGSize(width: full, height: full)) { _ in
            PlatformBezierPath(ovalIn: inner).addClip()
            let s = image.size
            guard s.width > 0, s.height > 0 else { return }
            // aspect fill, centred: the centre square lands exactly on `inner`
            let k = max(inner.width / s.width, inner.height / s.height)
            let w = s.width * k, h = s.height * k
            image.draw(in: CGRect(x: inner.midX - w / 2, y: inner.midY - h / 2, width: w, height: h))
        }
    }

    /// The upload's `imageData`: `render(image)` as a PNG data URL within the server's limit.
    static func dataURL(for image: PlatformImage) -> Result<(url: String, image: PlatformImage), Failure> {
        let rendered = render(image)
        guard let png = rendered.pngData() else { return .failure(.unreadable) }
        let url = "data:image/png;base64," + png.base64EncodedString()
        guard url.count <= maxDataURLLength else { return .failure(.tooLarge) }
        return .success((url, rendered))
    }

    /// A picked file to the upload's payload.
    static func upload(from data: Data) -> Result<(url: String, image: PlatformImage), Failure> {
        guard let image = decode(data) else { return .failure(.unreadable) }
        return dataURL(for: image)
    }

    /// An inline picture (`data:image/...;base64,...`: profilePicUploadResponse's stored copy).
    static func image(fromDataURL url: String) -> PlatformImage? {
        guard url.hasPrefix("data:image"), let comma = url.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(url[url.index(after: comma)...])).flatMap { PlatformImage(data: $0) }
    }
}
