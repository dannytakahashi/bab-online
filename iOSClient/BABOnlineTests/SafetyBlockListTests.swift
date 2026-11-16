import XCTest
@testable import BAB_Online

/// blockListUpdated (1.2.2): `silent: true` replaces the list without the
/// "Block list updated." alert (an admin rename re-pointed a saved block list;
/// server/admin/accountDelete.js refreshBlockLists), as the web skips its toast.
final class SafetyBlockListTests: XCTestCase {
    func testSilentRefreshReplacesTheListWithoutAnAlert() {
        let state = SafetyState()
        state.setBlockedUsers(["Cy"])
        SafetySocketHandler.applyBlockListUpdated(["success": true, "blockedUsers": ["Cyrus", "Zed"], "silent": true], to: state)
        XCTAssertEqual(state.blockedUsers, ["Cyrus", "Zed"])
        XCTAssertNil(state.feedbackMessage)
    }

    func testSilentRefreshLeavesAnAlertAlreadyShowing() {
        let state = SafetyState()
        state.feedbackMessage = "Report submitted. Thank you."
        SafetySocketHandler.applyBlockListUpdated(["success": true, "blockedUsers": ["Zed"], "silent": true], to: state)
        XCTAssertEqual(state.blockedUsers, ["Zed"])
        XCTAssertEqual(state.feedbackMessage, "Report submitted. Thank you.")
    }

    func testThePlayersOwnBlockStillShowsTheAlert() {
        let state = SafetyState()
        SafetySocketHandler.applyBlockListUpdated(["success": true, "blockedUsers": ["Zed"]], to: state)
        XCTAssertEqual(state.blockedUsers, ["Zed"])
        XCTAssertEqual(state.feedbackMessage, "Block list updated.")
    }

    func testSilentFalseOrMalformedStillShowsTheAlert() {
        let values: [Any] = [false, "true", NSNull()]
        for silent in values {
            let state = SafetyState()
            SafetySocketHandler.applyBlockListUpdated(["success": true, "blockedUsers": ["Zed"], "silent": silent], to: state)
            XCTAssertEqual(state.blockedUsers, ["Zed"])
            XCTAssertEqual(state.feedbackMessage, "Block list updated.", "silent: \(silent)")
        }
    }

    func testAFailureKeepsTheListAndShowsTheServersMessage() {
        let state = SafetyState()
        state.setBlockedUsers(["Zed"])
        SafetySocketHandler.applyBlockListUpdated(["success": false, "message": "No player by that name."], to: state)
        XCTAssertEqual(state.blockedUsers, ["Zed"])
        XCTAssertEqual(state.feedbackMessage, "No player by that name.")
        state.feedbackMessage = nil
        SafetySocketHandler.applyBlockListUpdated(["success": false, "silent": true], to: state)
        XCTAssertEqual(state.feedbackMessage, "Failed to update block list. Try again.")
    }
}
