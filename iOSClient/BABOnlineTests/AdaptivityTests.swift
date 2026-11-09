import XCTest
import UIKit
import SwiftUI
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

    @MainActor
    func testResetClearsEveryDraft() {
        let main = MainRoomState(), lobby = LobbyState(), tournament = TournamentState(), game = GameState()
        main.chatDraft = "a"; lobby.chatDraft = "b"; tournament.chatDraft = "c"; game.chatDraft = "d"
        main.reset(); lobby.reset(); tournament.reset(); game.reset()
        XCTAssertEqual([main.chatDraft, lobby.chatDraft, tournament.chatDraft, game.chatDraft], ["", "", "", ""])
        // the table state never carries the draft
        game.chatDraft = "typing"
        XCTAssertEqual(TableRenderModel(game.state), TableRenderModel(GameState().state))
    }

    private func textField(in view: UIView) -> UITextField? {
        if let t = view as? UITextField { return t }
        for v in view.subviews { if let t = textField(in: v) { return t } }
        return nil
    }

    /// A chat view rebuilt by a rotation / fold picks the draft up from the store, and typing writes it back.
    @MainActor
    func testDraftSurvivesARecreatedChatView() throws {
        let main = MainRoomState()
        let auth = AuthState()
        func host() -> (UIWindow, UITextField) {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 700))
            if let ws = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window.windowScene = ws }
            let vc = UIHostingController(rootView: MainRoomChatView().environmentObject(main).environmentObject(auth).environmentObject(SafetyState()))
            window.rootViewController = vc
            window.isHidden = false
            vc.view.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            return (window, textField(in: vc.view)!)
        }
        var (w1, field) = host()
        XCTAssertEqual(field.text ?? "", "")
        field.becomeFirstResponder()
        field.insertText("half a sentence")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(main.chatDraft, "half a sentence", "typing writes the draft to the store")
        w1.isHidden = true
        (w1, field) = host()  // a new view, as after a size-class change
        XCTAssertEqual(field.text, "half a sentence")
        w1.isHidden = true
    }
}
