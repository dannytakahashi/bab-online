import XCTest
@testable import BAB_Online

/// The game lobby's remove-bot rules (owner 2026-11-13, "no ability to remove bots from
/// lobby once added"), the web's (client/src/ui/screens/GameLobby.js): only a bot that is
/// not ready can be removed (every bot is ready once a human readies a full lobby, through
/// the start), the VoiceOver label keeps the lobby's generic bot name, and my Ready button
/// follows my flag in the server's list (removeBotFromLobby clears every flag).
final class LobbyBotRemovalTests: XCTestCase {
    /// As the server sends them (GameManager.addBotToLobby / lobbyPlayerData).
    private func wire(_ socketId: String, _ username: String, ready: Bool, bot: Bool) -> LobbyPlayer {
        LobbyPlayer.from(["socketId": socketId, "username": username, "ready": ready, "isBot": bot])!
    }

    func testOnlyABotThatIsNotReadyCanBeRemoved() {
        XCTAssertTrue(wire("bot:1", "🤖 Bot", ready: false, bot: true).canBeRemoved)
        XCTAssertFalse(wire("bot:1", "🤖 Bot", ready: true, bot: true).canBeRemoved, "ready: the lobby may be starting")
        XCTAssertFalse(wire("sid-ivy", "ivy", ready: false, bot: false).canBeRemoved, "never a human")
        XCTAssertFalse(wire("sid-ivy", "ivy", ready: true, bot: false).canBeRemoved)
    }

    func testTheRemoveLabelKeepsTheGenericName() {
        XCTAssertEqual(wire("bot:1", "🤖 Bot", ready: false, bot: true).removeBotLabel, "Remove Bot")
        XCTAssertEqual(wire("bot:2", "🤖 Bot 2", ready: false, bot: true).removeBotLabel, "Remove Bot 2")
        XCTAssertEqual(wire("bot:3", "🤖 Bot 3", ready: false, bot: true).botDisplayName, "Bot 3")
        // any other bot name says what it is
        XCTAssertEqual(wire("bot:4", "Mary", ready: false, bot: true).removeBotLabel, "Remove bot Mary")
        XCTAssertEqual(wire("bot:5", "🤖", ready: false, bot: true).removeBotLabel, "Remove bot")
    }

    /// The control sends the bot's own socket id (lobbyHandlers.removeBot looks it up by it).
    func testTheRowKeepsTheBotSocketId() {
        XCTAssertEqual(wire("bot:abc123", "🤖 Bot", ready: false, bot: true).id, "bot:abc123")
    }

    func testMyReadyFlagFollowsTheServerList() {
        let readyBefore = [wire("sid-ivy", "ivy", ready: true, bot: false), wire("bot:1", "🤖 Bot", ready: false, bot: true)]
        XCTAssertEqual(LobbyPlayer.readyFlag(of: "ivy", in: readyBefore), true)
        // the list after removeBot: every flag cleared
        let afterRemove = [wire("sid-ivy", "ivy", ready: false, bot: false)]
        XCTAssertEqual(LobbyPlayer.readyFlag(of: "ivy", in: afterRemove), false)
        // not in the list (or signed out): leave the button alone
        XCTAssertNil(LobbyPlayer.readyFlag(of: "kim", in: afterRemove))
        XCTAssertNil(LobbyPlayer.readyFlag(of: nil, in: afterRemove))
        XCTAssertNil(LobbyPlayer.readyFlag(of: "", in: afterRemove))
    }
}
