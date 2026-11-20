import XCTest
@testable import BAB_Online

/// The main room's online count and list follow both refreshes the server sends:
/// mainRoomPlayerJoined and, from the build after 1.2.3 (24), mainRoomPlayerLeft (unread
/// before, so a player who went offline stayed listed until the next join). Both carry
/// the whole list; `LobbySocketHandler.applyOnlineList` is what each handler runs.
final class MainRoomOnlineListTests: XCTestCase {
    func testALeaveShrinksTheListAndAReturnGrowsIt() {
        let state = MainRoomState()
        LobbySocketHandler.applyOnlineList(["username": "kim", "onlineCount": 2, "onlineUsers": ["ivy", "kim"]], to: state)
        XCTAssertEqual(state.onlineCount, 2)
        XCTAssertEqual(state.onlineUsers, ["ivy", "kim"])

        // mainRoomPlayerLeft for kim
        LobbySocketHandler.applyOnlineList(["username": "kim", "onlineCount": 1, "onlineUsers": ["ivy"]], to: state)
        XCTAssertEqual(state.onlineCount, 1)
        XCTAssertEqual(state.onlineUsers, ["ivy"])

        // kim comes back (mainRoomPlayerJoined)
        LobbySocketHandler.applyOnlineList(["username": "kim", "onlineCount": 2, "onlineUsers": ["ivy", "kim"]], to: state)
        XCTAssertEqual(state.onlineUsers, ["ivy", "kim"])
    }

    func testAKeyOfTheWrongTypeLeavesThatValueAlone() {
        let state = MainRoomState()
        LobbySocketHandler.applyOnlineList(["onlineCount": 3, "onlineUsers": ["a", "b", "c"]], to: state)
        LobbySocketHandler.applyOnlineList(["onlineCount": "2", "onlineUsers": "a"], to: state)
        XCTAssertEqual(state.onlineCount, 3)
        XCTAssertEqual(state.onlineUsers, ["a", "b", "c"])
    }

    func testTheHandlerRegistersTheLeaveEvent() throws {
        // the socket handler is wired on a live socket; its source names both events in the loop
        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: ios.appendingPathComponent("BABOnline/Networking/Handlers/LobbySocketHandler.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("for event in [SocketEvents.Server.mainRoomPlayerJoined, SocketEvents.Server.mainRoomPlayerLeft]"))
    }
}
