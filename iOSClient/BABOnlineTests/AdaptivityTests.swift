import XCTest
import UIKit
@testable import BAB_Online

/// Item 27: orientation policy and the chat drafts.
final class AdaptivityTests: XCTestCase {
    func testOrientationMask() {
        XCTAssertEqual(AppDelegate.mask(idiom: .pad, h: .regular, v: .regular), .all)
        XCTAssertEqual(AppDelegate.mask(idiom: .pad, h: .compact, v: .regular), .all, "iPad split view")
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, h: .regular, v: .regular), .allButUpsideDown, "the open Duo's inner display")
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, h: .compact, v: .regular), .portrait, "a phone, the Duo's outer display")
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, h: .regular, v: .compact), .portrait, "a large phone in landscape goes back")
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, h: .compact, v: .compact), .portrait)
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, h: .unspecified, v: .unspecified), .portrait)
    }
}
