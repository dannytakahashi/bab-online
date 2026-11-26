import XCTest
import Combine
@testable import BAB_Online

/// s2c updateRequired (iOS 1.2.7 (41)): the upgrade gate's update screen, read leniently.
final class UpdateRequiredTests: XCTestCase {
    func testTheNoticeIsReadLeniently() {
        let gate = UpdateRequiredNotice.from([
            "message": "Update required. Please update BAB Online in the App Store. You'll stay signed in.",
            "url": "https://apps.apple.com/app/id6759510890",
        ])
        XCTAssertEqual(gate.message, "Update required. Please update BAB Online in the App Store. You'll stay signed in.")
        XCTAssertEqual(gate.url, AppStoreLink.url)
        XCTAssertEqual(UpdateRequiredNotice.from(nil).message, UpdateRequiredNotice.defaultMessage)
        XCTAssertEqual(UpdateRequiredNotice.from(["message": "  "]).message, UpdateRequiredNotice.defaultMessage)
        // only the App Store's page is ever opened
        XCTAssertEqual(UpdateRequiredNotice.from(["url": "https://example.invalid/app"]).url, AppStoreLink.url)
        XCTAssertEqual(UpdateRequiredNotice.from(["url": 7]).url, AppStoreLink.url)
        XCTAssertEqual(UpdateRequiredNotice.from(["url": "https://apps.apple.com/us/app/id1"]).url.absoluteString, "https://apps.apple.com/us/app/id1")
    }

    func testTheStateKeepsOneNotice() {
        let state = UpdateRequiredState()
        XCTAssertNil(state.notice)
        state.receive(["message": "Update required."])
        XCTAssertEqual(state.notice?.message, "Update required.")
        var changes = 0
        let sub = state.$notice.dropFirst().sink { _ in changes += 1 }
        state.receive(["message": "Update required."])
        XCTAssertEqual(changes, 0, "a repeat push changes nothing")
        sub.cancel()
    }

    /// The handler is registered (the router's handlers for every connection).
    func testTheEventNameIsTheContracts() {
        XCTAssertEqual(SocketEvents.Server.updateRequired, "updateRequired")
    }
}
