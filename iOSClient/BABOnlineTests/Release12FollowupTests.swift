import XCTest
import SpriteKit
@testable import BAB_Online

/// My own pips' box keeps clear of the table at every listed size, chrome and
/// Duo pose (the TableLayoutTests rect model), inside my seat's row (SeatRowTests
/// checks the row's 8 pt clearances), the spectator badge keeps clear of it, and
/// the disconnect banner's keep-out spot.
@MainActor
final class MyPipsLayoutTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    /// Every rect myPips must not cover (the bid band and my bid bubble are exempt:
    /// the pips show once the bidding is over and my bubble is gone); it is my seat's
    /// row's first item, clear of the row's HSI and voice slots.
    static func problems(_ L: TableLayout) -> [String] {
        let r = L.myPips
        var out: [String] = []
        var keeps: [(String, CGRect)] = []
        for (g, rel) in [("partner", Rel.top), ("left", .left), ("right", .right)] {
            let a = L.seatAnchor(rel)
            keeps.append(("\(g).glow", TableLayout.glowRect(a)))
            keeps.append(("\(g).name", TableLayout.nameRect(a)))
            keeps.append(("\(g).bubble", L.bubbleRect(rel)))
        }
        for rel in [Rel.top, .bottom, .left, .right] { keeps.append(("trick.\(rel)", L.trickRect(rel))) }
        keeps.append(("hand", TableLayoutTests.handRect(L, count: 13, lifted: true)))
        keeps.append(("history", TableLayoutTests.historyRect(L, count: 13)))
        keeps.append(("row.hsi", L.seatRow.hsi))
        keeps.append(("row.voice", L.seatRow.voice))
        for (i, c) in L.cornerRects.enumerated() { keeps.append(("corner\(i)", c)) }
        if let f = L.chrome.fold, !L.foldIgnored { keeps.append(("fold", f)) }
        for (name, k) in keeps where TableLayout.overlaps(k, r) { out.append("myPips x \(name) \(r.intersection(k))") }
        let safe = L.safeRect.insetBy(dx: -0.01, dy: -0.01)
        if r.minX < safe.minX || r.maxX > safe.maxX || r.minY < safe.minY || r.maxY > L.topLimit + 0.01 { out.append("outside \(r)") }
        if r.size != TableLayout.myPipsSize { out.append("size \(r.size)") }
        if !L.seatRow.content.insetBy(dx: -0.01, dy: -0.01).contains(r) { out.append("not in the seat row \(r) \(L.seatRow.content)") }
        return out
    }

    func testMyPipsClearAtEveryListedSizeAndPose() {
        var checked = 0
        for (size, ins) in TableLayoutTests.listedSizes {
            for topBar in [CGFloat(70), 84] {
                for bottomBar in [CGFloat(0), 45] {
                    let L = TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, topBar: topBar, bottomBar: bottomBar))
                    XCTAssertEqual(Self.problems(L), [], "\(size) \(ins) topBar \(topBar) bottomBar \(bottomBar)")
                    // the badge keeps clear of it
                    XCTAssertFalse(TableLayout.overlaps(L.spectatorBadge(spectating: false), L.myPips), "\(size) badge over my pips")
                    checked += 1
                }
            }
        }
        for (fold, size, ins, topBar) in TableLayoutTests.reachableFolds {
            let L = TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, topBar: topBar, fold: fold))
            XCTAssertEqual(Self.problems(L), [], "\(size) fold \(fold) topBar \(topBar)")
            XCTAssertFalse(TableLayout.overlaps(L.spectatorBadge(spectating: false), L.myPips), "\(size) fold badge over my pips")
            checked += 1
        }
        // the measured devices (fixture mode)
        for (size, chrome) in SceneLayoutTests.measured {
            XCTAssertEqual(Self.problems(TableLayout(size: size, chrome: chrome)), [], "\(size) measured")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 60)
    }

    /// Fuzz: finite, inside the safe rect and the right size at random sizes.
    func testMyPipsFuzz() {
        var rng = SystemRandomNumberGenerator()
        for _ in 0..<300 {
            let w = CGFloat(Int.random(in: 320...1400, using: &rng)), h = CGFloat(Int.random(in: 480...1400, using: &rng))
            let L = TableLayout(size: CGSize(width: w, height: h), chrome: TableLayoutTests.chrome(topBar: 70))
            let r = L.myPips
            XCTAssertTrue(r.minX.isFinite && r.minY.isFinite)
            XCTAssertEqual(r.size, TableLayout.myPipsSize)
            if !L.isDegraded { XCTAssertTrue(L.safeRect.insetBy(dx: -0.01, dy: -0.01).contains(r), "\(w)x\(h) \(r)") }
        }
    }

    /// The scene's box node sits at the layout's spot (its pill against its neighbour in the row) and stays inside it.
    @MainActor
    func testMyPipsNodeOnTheScene() throws {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        for (size, chrome) in SceneLayoutTests.configs {
            let h = ReplayHarness()
            let scene = GameSKScene(size: size)
            scene.animator = InstantAnimator()
            scene.chrome = chrome
            scene.configure(gameState: h.store, actions: h.actions)
            scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
            h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
            let L = scene.layout
            let slots = scene.myPipsNode.pips?.slots ?? 0
            let want = slots > 0 ? L.myPipsCenter(slots: slots) : CGPoint(x: L.myPips.midX, y: L.myPips.midY)
            XCTAssertEqual(scene.myPipsNode.position.x, want.x, accuracy: 0.01, "\(size)")
            XCTAssertEqual(scene.myPipsNode.position.y, want.y, accuracy: 0.01, "\(size)")
            if !scene.myPipsNode.children.isEmpty {
                let f = scene.myPipsNode.calculateAccumulatedFrame()
                XCTAssertTrue(L.myPips.insetBy(dx: -0.5, dy: -0.5).contains(f), "\(size) \(f) not in \(L.myPips)")
            }
        }
    }

    func testDisconnectBannerKeepOut() {
        // the iPad: room below the partner, clear of every seat and card
        let ipad = TableLayout(size: CGSize(width: 820, height: 1180), chrome: TableLayoutTests.chrome(TableLayoutTests.insets(24, 0, 20, 0)))
        // an 80 pt banner, in scene units (the iPad's table is zoomed)
        let r = ipad.disconnectBanner(height: 80 / ipad.zoom, spectating: false)
        XCTAssertNotNil(r)
        if let r {
            for rel in [Rel.top, .left, .right] { XCTAssertFalse(TableLayout.overlaps(r, ipad.seatFootprint(rel)), "\(rel)") }
            for rel in [Rel.top, .bottom, .left, .right] { XCTAssertFalse(TableLayout.overlaps(r, ipad.trickRect(rel))) }
        }
        // a phone: no clear spot, the banner keeps its place under the corner buttons
        let phone = TableLayout(size: CGSize(width: 393, height: 852), chrome: TableLayoutTests.chrome(TableLayoutTests.insets(59, 0, 34, 0)))
        XCTAssertNil(phone.disconnectBanner(height: 40, spectating: false))
        // whatever it returns is clear, at every listed size
        for (size, ins) in TableLayoutTests.listedSizes {
            for spectating in [false, true] {
                let L = TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, bottomBar: spectating ? 45 : 0))
                guard let b = L.disconnectBanner(height: 44, spectating: spectating) else { continue }
                let seats: [Rel] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
                for rel in seats { XCTAssertFalse(TableLayout.overlaps(b, L.seatFootprint(rel)), "\(size) \(rel)") }
                XCTAssertTrue(L.safeRect.contains(b), "\(size)")
            }
        }
    }
}

/// The restart notice (roadmap #17): what was lost, the one message, the window.
final class RestartNoticeTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testOneMessageForWhatWasLost() {
        var n = RestartNotice()
        n.shutdown(place: .seat, at: t0)
        XCTAssertEqual(n.lost(at: t0.addingTimeInterval(5)),
                       "Your game ended because the server restarted for an update. It won't count toward your stats.")
        // a second path (rejoinFailed after the restore, tournamentLeft, not_in_game) says nothing
        XCTAssertNil(n.lost(at: t0.addingTimeInterval(6)))
    }

    func testNothingLostNothingShown() {
        var n = RestartNotice()
        n.shutdown(place: nil, at: t0)          // the main room
        XCTAssertFalse(n.isPending)
        XCTAssertNil(n.lost(at: t0.addingTimeInterval(3)))
        // a game that survived (rejoinSuccess)
        n.shutdown(place: .seat, at: t0)
        n.survived()
        XCTAssertNil(n.lost(at: t0.addingTimeInterval(3)))
        // a restore with no notice at all (every launch)
        var none = RestartNotice()
        XCTAssertNil(none.lost(at: t0))
    }

    func testTheWindowIsAboutTwoMinutes() {
        var n = RestartNotice()
        n.shutdown(place: .lobby, at: t0)
        XCTAssertNotNil(n.lost(at: t0.addingTimeInterval(RestartNotice.window - 1)))
        n.shutdown(place: .lobby, at: t0)
        XCTAssertNil(n.lost(at: t0.addingTimeInterval(RestartNotice.window + 1)))
        XCTAssertEqual(RestartNotice.window, 120)
    }

    func testRepeatedNoticeKeepsTheFirstLoss() {
        var n = RestartNotice()
        n.shutdown(place: .tournamentGame, at: t0)
        n.shutdown(place: nil, at: t0.addingTimeInterval(30))   // the restarted server restarting again, from the main room
        XCTAssertEqual(n.place, .tournamentGame)
        XCTAssertNotNil(n.lost(at: t0.addingTimeInterval(140)))  // the window counts from the latest notice
    }

    func testWordingPerPlace() {
        XCTAssertEqual(RestartNotice.message(.spectating), "The game you were watching ended because the server restarted for an update.")
        XCTAssertEqual(RestartNotice.message(.lobby), "Your lobby closed because the server restarted for an update.")
        XCTAssertEqual(RestartNotice.message(.tournament), "Your tournament ended because the server restarted for an update.")
        XCTAssertTrue(RestartNotice.message(.tournamentGame).hasSuffix("won't count toward your stats."))
    }

    func testPlaceFromTheScreen() {
        typealias P = RestartNotice
        XCTAssertNil(P.place(screen: .mainRoom, role: .none, phase: .none, inTournament: false))
        XCTAssertNil(P.place(screen: .signIn, role: .none, phase: .none, inTournament: false))
        XCTAssertEqual(P.place(screen: .gameLobby, role: .none, phase: .none, inTournament: false), .lobby)
        XCTAssertEqual(P.place(screen: .tournamentLobby, role: .none, phase: .none, inTournament: true), .tournament)
        XCTAssertEqual(P.place(screen: .game, role: .seat, phase: .playing, inTournament: false), .seat)
        XCTAssertEqual(P.place(screen: .game, role: .lazyWatcher, phase: .bidding, inTournament: false), .seat)
        XCTAssertEqual(P.place(screen: .game, role: .entrant, phase: .draw, inTournament: false), .seat)
        XCTAssertEqual(P.place(screen: .game, role: .spectator, phase: .playing, inTournament: false), .spectating)
        XCTAssertEqual(P.place(screen: .game, role: .seat, phase: .playing, inTournament: true), .tournamentGame)
        // a finished game loses nothing; a finished tournament game still loses the tournament
        XCTAssertNil(P.place(screen: .game, role: .seat, phase: .ended, inTournament: false))
        XCTAssertEqual(P.place(screen: .game, role: .seat, phase: .ended, inTournament: true), .tournament)
        // a spectator of a finished game (GameEndView) loses nothing either
        XCTAssertNil(P.place(screen: .game, role: .spectator, phase: .ended, inTournament: false))
        XCTAssertNil(P.place(screen: .game, role: .spectator, phase: .none, inTournament: false))
        XCTAssertNil(P.place(screen: .game, role: .spectator, phase: .ended, inTournament: true))
        // a complete tournament (its results screen, or the last game's end) loses nothing
        XCTAssertNil(P.place(screen: .tournamentLobby, role: .none, phase: .none, inTournament: true, tournamentComplete: true))
        XCTAssertNil(P.place(screen: .game, role: .seat, phase: .ended, inTournament: true, tournamentComplete: true))
        XCTAssertEqual(P.place(screen: .tournamentLobby, role: .none, phase: .none, inTournament: true, tournamentComplete: false), .tournament)
    }

    /// The app's store: the toast state through the reconnect, then one alert.
    @MainActor
    func testStoreShowsOnce() {
        let a = RestartNotices()
        a.serverShutdown(place: .spectating)
        XCTAssertTrue(a.isRestarting)
        a.reconnected()                    // still connected: the server has not closed it yet
        XCTAssertTrue(a.isRestarting)
        a.disconnected()
        XCTAssertTrue(a.isRestarting)      // "Restarting for an update…" until the socket is back
        a.reconnected()
        XCTAssertFalse(a.isRestarting)
        // the restore found it gone (several paths fire): one message
        a.lost()
        XCTAssertEqual(a.message, RestartNotice.message(.spectating))
        a.message = nil
        a.lost()
        XCTAssertNil(a.message)
        XCTAssertNil(a.notice.place)
        // survived: no message
        let c = RestartNotices()
        c.serverShutdown(place: .seat)
        c.survived()
        c.lost()
        XCTAssertNil(c.message)
        // no notice (every launch's restore): nothing
        let d = RestartNotices()
        d.lost()
        XCTAssertNil(d.message)
    }

    /// SocketService.handleServerShutdown asks what is at stake and records it.
    @MainActor
    func testSocketServiceHandlerRecordsThePlace() {
        let service = SocketService.shared
        let saved = service.restartPlace
        defer { service.restartPlace = saved; RestartNotices.shared.survived() }
        service.restartPlace = { .lobby }
        service.handleServerShutdown(["message": "Server is restarting, please reconnect shortly"])
        XCTAssertEqual(RestartNotices.shared.notice.place, .lobby)
        XCTAssertTrue(RestartNotices.shared.isRestarting)
        XCTAssertEqual(ConnectionStatusToast.text(reconnected: false, restarting: true), "Restarting for an update\u{2026}")
        XCTAssertEqual(ConnectionStatusToast.text(reconnected: false, restarting: false), "Reconnecting...")
        XCTAssertEqual(ConnectionStatusToast.text(reconnected: true, restarting: true), "Connected!")
        RestartNotices.shared.disconnected()
        RestartNotices.shared.reconnected()
        XCTAssertFalse(RestartNotices.shared.isRestarting)
    }

    /// The stats claim, checked in the server source the app ships against: stats and
    /// gameRecords are written only on the gameEnd path, never on abort or shutdown.
    func testStatsClaimMatchesTheServerSource() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let handlers = try String(contentsOf: root.appendingPathComponent("server/socket/gameHandlers.js"), encoding: .utf8)
        let lifecycle = try String(contentsOf: root.appendingPathComponent("server/socket/gameLifecycle.js"), encoding: .utf8)
        let shutdown = try String(contentsOf: root.appendingPathComponent("server/utils/shutdown.js"), encoding: .utf8)
        XCTAssertEqual(handlers.components(separatedBy: "recordGameStats(game)").count - 1, 1, "one stats write")
        let end = try XCTUnwrap(handlers.range(of: "'gameEnd', {"))
        let write = try XCTUnwrap(handlers.range(of: "recordGameStats(game)"))
        XCTAssertLessThan(end.lowerBound, write.lowerBound, "stats only after gameEnd")
        XCTAssertFalse(lifecycle.contains("recordGame"))
        XCTAssertFalse(shutdown.contains("recordGame"))
        XCTAssertTrue(shutdown.contains("io.emit('serverShutdown'"))
    }
}

/// The opt-in socket log never prints a credential.
final class SocketLogRedactionTests: XCTestCase {
    /// Built from parts: no credential-shaped literal in the source (public repo).
    static let secret = ["t", "u", "r", "n"].joined() + "-" + String(repeating: "x", count: 6) + "-" + "unit"

    func testCredentialPayloadsAreRedacted() {
        let ice = "42[\"voiceIceServers\",{\"iceServers\":[{\"urls\":[\"turn:turn.example.invalid:3478\"],\"username\":\"u1\",\"credential\":\"\(Self.secret)\"}],\"turn\":true}]"
        let lines = [
            "Parsing \(ice)",
            "Got message: \(ice)",
            "Handling event: voiceIceServers with data: [{\"iceServers\": [{\"credential\": \"\(Self.secret)\"}]}]",
            "Emitting: 42[\"signIn\",{\"username\":\"a\",\"password\":\"\(Self.secret)\"}]",
            "Emitting: 42[\"signUp\",{\"username\":\"a\",\"password\":\"\(Self.secret)\"}]",
            "Emitting: 42[\"restoreSession\",{\"username\":\"a\",\"sessionToken\":\"\(Self.secret)\"}]",
            "Handling event: restoreSessionResponse with data: [{\"sessionToken\": \"\(Self.secret)\"}]",
            "Handling event: signInResponse with data: [{\"success\": 1, \"sessionToken\": \"\(Self.secret)\"}]",
            "Sending ws: 42[\"x\",{\"token\":\"\(Self.secret)\"}] as type: 4",
            "credential \(Self.secret)",
        ]
        for line in lines {
            let out = RedactingSocketLogger.redact(line)
            XCTAssertFalse(out.contains(Self.secret), out)
            XCTAssertTrue(out.hasSuffix(RedactingSocketLogger.marker), out)
        }
        XCTAssertEqual(RedactingSocketLogger.redact(lines[0]), "Parsing 42<redacted>")
    }

    func testOtherLinesStay() {
        let line = "Handling event: cardPlayed with data: [{\"position\": 2}]"
        XCTAssertEqual(RedactingSocketLogger.redact(line), line)
        XCTAssertEqual(RedactingSocketLogger.redact("Engine is being closed"), "Engine is being closed")
    }

    /// Off unless `-socketLog YES`; the logger logs only through redact.
    func testOptInOnly() {
        XCTAssertFalse(UserDefaults.standard.bool(forKey: "socketLog"))
        XCTAssertFalse(RedactingSocketLogger.isEnabled)
        XCTAssertTrue(RedactingSocketLogger().log)
    }
}

/// VoiceOver labels of the icon-only controls (pre-submission audit).
final class AccessibilityLabelSourceTests: XCTestCase {
    /// Every Button whose label is only an SF Symbol has an accessibilityLabel within its modifiers.
    func testIconOnlyButtonsAreLabelled() throws {
        let views = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BABOnline/Views")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: views, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 20)
        var unlabelled: [String] = []
        for url in files {
            let lines = try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains("Button(action:") && line.hasSuffix("{") {
                // the label: the next line is an Image(systemName:) and no Text / Label follows before the closing brace
                guard i + 1 < lines.count, lines[i + 1].trimmingCharacters(in: .whitespaces).hasPrefix("Image(systemName:") else { continue }
                let indent = line.prefix { $0 == " " }.count
                var j = i + 1
                var hasText = false
                while j < lines.count {
                    let l = lines[j]
                    if l.contains("Text(") || l.contains("Label(") { hasText = true }
                    if l.trimmingCharacters(in: .whitespaces) == "}" && l.prefix(while: { $0 == " " }).count == indent { break }
                    j += 1
                }
                if hasText { continue }
                // modifiers after the closing brace, up to the next blank line or statement
                let after = lines[(j + 1)..<min(lines.count, j + 12)].prefix { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                if !after.contains(where: { $0.contains(".accessibilityLabel(") }) {
                    unlabelled.append("\(url.lastPathComponent):\(i + 1)")
                }
            }
        }
        XCTAssertEqual(unlabelled, [])
    }
}
