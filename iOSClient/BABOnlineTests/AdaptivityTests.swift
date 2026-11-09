import XCTest
import UIKit
import SwiftUI
@testable import BAB_Online

/// Item 27: orientation policy and the chat drafts.
final class AdaptivityTests: XCTestCase {
    func testOrientationMask() {
        let duoOpen = CGSize(width: 669, height: 951), duoClosed = CGSize(width: 466, height: 678)
        XCTAssertEqual(AppDelegate.mask(idiom: .pad, screen: CGSize(width: 820, height: 1180)), .all)
        XCTAssertEqual(AppDelegate.mask(idiom: .pad, screen: CGSize(width: 320, height: 1180)), .all, "iPad split view")
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, screen: duoOpen), .allButUpsideDown, "the open Duo's inner display")
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, screen: duoClosed), .portrait, "the Duo's outer display")
        for phone in [CGSize(width: 375, height: 667), CGSize(width: 393, height: 852), CGSize(width: 440, height: 956)] {
            XCTAssertEqual(AppDelegate.mask(idiom: .phone, screen: phone), .portrait, "\(phone)")
        }
        XCTAssertEqual(AppDelegate.mask(idiom: .phone, screen: .zero), .portrait)
    }

    /// The mask depends only on the display's short side, so rotating the open Duo
    /// never changes it (no portrait / landscape feedback loop through size classes).
    func testOrientationMaskStableAcrossRotation() {
        for size in [CGSize(width: 669, height: 951), CGSize(width: 466, height: 678), CGSize(width: 393, height: 852)] {
            let rotated = CGSize(width: size.height, height: size.width)
            XCTAssertEqual(AppDelegate.mask(idiom: .phone, screen: size), AppDelegate.mask(idiom: .phone, screen: rotated), "\(size)")
        }
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

    /// Drafts survive a rotation, not their context.
    @MainActor
    func testDraftsClearedWithTheirContext() {
        let main = MainRoomState(), lobby = LobbyState(), tournament = TournamentState(), game = GameState()
        func fill() { main.chatDraft = "m"; lobby.chatDraft = "l"; tournament.chatDraft = "t"; game.chatDraft = "g" }
        func drafts() -> [String] { [main.chatDraft, lobby.chatDraft, tournament.chatDraft, game.chatDraft] }
        func go(_ a: AppState.Screen, _ b: AppState.Screen) {
            ChatDrafts.screenChanged(from: a, to: b, mainRoom: main, lobby: lobby, tournament: tournament, game: game)
        }
        fill(); go(.game, .signIn)                       // forced logout / account deletion / sign-out
        XCTAssertEqual(drafts(), ["", "", "", ""])
        fill(); go(.gameLobby, .game)                    // game start
        XCTAssertEqual(drafts(), ["m", "", "t", "g"])
        fill(); go(.game, .mainRoom)                     // leave / abort / game end
        XCTAssertEqual(drafts(), ["m", "l", "t", ""])
        fill(); go(.tournamentLobby, .game)              // a tournament round: the tournament draft waits
        XCTAssertEqual(drafts(), ["m", "l", "t", "g"])
        fill(); go(.tournamentLobby, .mainRoom)          // left the tournament
        XCTAssertEqual(drafts(), ["m", "l", "", "g"])
        fill(); go(.mainRoom, .mainRoom)
        XCTAssertEqual(drafts(), ["m", "l", "t", "g"])
    }

    final class SizeClassBox: ObservableObject { @Published var h: UserInterfaceSizeClass = .compact }
    struct SizeClassSwitch<V: View>: View {
        @ObservedObject var box: SizeClassBox
        let content: V
        var body: some View { content.environment(\.horizontalSizeClass, box.h) }
    }

    /// A size-class change (the open Duo, an iPad split) with a part-typed main-room or
    /// tournament line: the draft stays (MainRoomView's AnyLayout also keeps the field focused).
    @MainActor
    func testDraftSurvivesASizeClassChange() throws {
        let main = MainRoomState(), auth = AuthState(), app = AppState(), tournament = TournamentState()
        tournament.phase = "lobby"
        for screen in ["main", "tournament"] {
            let box = SizeClassBox()
            let root: AnyView = screen == "main" ? AnyView(MainRoomView()) : AnyView(TournamentLobbyView())
            let view = SizeClassSwitch(box: box, content: root.environmentObject(main).environmentObject(auth).environmentObject(app)
                .environmentObject(tournament).environmentObject(SafetyState()))
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 900))
            if let ws = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window.windowScene = ws }
            let vc = UIHostingController(rootView: view)
            window.rootViewController = vc
            window.isHidden = false
            RunLoop.main.run(until: Date().addingTimeInterval(0.4))
            let field = try XCTUnwrap(textField(in: vc.view), screen)
            field.becomeFirstResponder()
            field.insertText("half a thought")
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            for h in [UserInterfaceSizeClass.regular, .compact, .regular] {
                box.h = h
                RunLoop.main.run(until: Date().addingTimeInterval(0.4))
                let now = try XCTUnwrap(textField(in: vc.view), "\(screen) \(h)")
                XCTAssertEqual(now.text, "half a thought", "\(screen) after switching to \(h)")
                if screen == "main" { XCTAssertTrue(now.isFirstResponder, "main room keeps the focus (\(h))") }
            }
            XCTAssertEqual(screen == "main" ? main.chatDraft : tournament.chatDraft, "half a thought")
            window.isHidden = true
        }
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
