import XCTest

/// Opt-in live check of the iOS SFU transport (PR 3; docs/claude/voice.md "SFU voice, iOS")
/// against a local server with `VOICE_SFU=tournament` and the Cloudflare DEV app (never
/// production), with `scripts/voice-sfu-ios-live.mjs` on the host: N headless Chromium pages
/// that drive the client protocol by hand join the tournament this app creates.
///
/// Environment (TEST_RUNNER_ prefixed): `BAB_LIVE_SERVER=http://localhost:<port>`,
/// `BAB_LIVE_USER=<new name>`, `BAB_LIVE_PASS=<random>` (the account is created here; keep the
/// password out of logs and the repo), `BAB_LIVE_CTL=<the harness's --ctl dir>`,
/// `BAB_LIVE_RELAY=<relay port>` and `BAB_LIVE_RELAY_CTL=<its control port>` (the iPhone's SFU
/// media through the harness's UDP relay, `SfuRelay`), `BAB_LIVE_PHASES` (comma list, default
/// all): `core` (both ways, mute, volume, speaking, a page leaving and coming back), `ice` (a
/// forced ICE restart on the same session, the undocumented form), `relay` (the network cut
/// 8 s and 40 s, a NAT rebinding), `background` (5 / 30 / 60 s in the background, the app
/// suspended as iOS does, SIGSTOP by the harness; and 30 s not suspended), `relaunch` (the app
/// killed and launched again); opt-in, not in the default list, each run on its own after the
/// join (they unmute first, which `core` expects to do itself): `bundle` (the page whose pull
/// sits on the BUNDLE-tag m-section leaves: the session stays heard both ways; review of PR 3)
/// and `blip` (the app's socket refused by the harness's `--proxy-port` proxy, which
/// `BAB_LIVE_SERVER` must name, and the relay cut at once, 7 s and 12 s: the same session,
/// resumed). Every measurement is written to `<ctl>/ios-<step>.json`.
///
/// The app reads its own side from the DEBUG probe `voice.sfu.probe` (`-sfuProbe YES`): the
/// PeerConnection's state, the session, each pulled track's packets / bytes / volume / mute /
/// speaking, my bytes sent, the recoveries.
final class LiveSfuVoiceTests: XCTestCase {
    private var app: XCUIApplication!
    private var ctl = ""
    private var cmdNo = 0
    private var pages: [String] = []
    private var phases = Set<String>()

    override func setUp() {
        continueAfterFailure = true
    }

    // MARK: - Host commands and the probe

    @discardableResult
    private func cmd(_ action: String, _ args: [String: Any] = [:], timeout: TimeInterval = 90) -> [String: Any] {
        cmdNo += 1
        let n = String(format: "%04d", cmdNo)
        var body = args
        body["action"] = action
        let data = try! JSONSerialization.data(withJSONObject: body)
        FileManager.default.createFile(atPath: "\(ctl)/cmd-\(n).json", contents: data)
        let done = "\(ctl)/done-\(n).json"
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if let d = FileManager.default.contents(atPath: done), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                return j
            }
            usleep(200_000)
        }
        XCTFail("no answer to \(action)")
        return [:]
    }

    private func save(_ step: String, _ value: Any) {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        FileManager.default.createFile(atPath: "\(ctl)/ios-\(step).json", contents: data)
        let a = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        a.name = "sfu-\(step)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-sfu-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    struct Probe {
        var raw: String
        var fields: [String: String]
        /// username -> (packets, bytes, volume, on, speaking)
        var pulls: [String: (packets: Int, bytes: Int, volume: String, on: String, speaking: String)]
        var pc: String { fields["pc"] ?? "-" }
        var sid: String { fields["sid"] ?? "-" }
        func int(_ k: String) -> Int { Int(fields[k] ?? "") ?? 0 }
    }

    private func probe() -> Probe {
        let el = app.descendants(matching: .any)["voice.sfu.probe"]
        let raw = el.exists ? el.label : ""
        var fields: [String: String] = [:]
        for part in raw.split(separator: " ") {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { fields[kv[0]] = kv[1] }
        }
        var pulls: [String: (Int, Int, String, String, String)] = [:]
        for p in (fields["pulls"] ?? "-").split(separator: ",") {
            let f = p.split(separator: ":").map(String.init)
            if f.count == 6 { pulls[f[0]] = (Int(f[1]) ?? 0, Int(f[2]) ?? 0, f[3], f[4], f[5]) }
        }
        return Probe(raw: raw, fields: fields, pulls: pulls)
    }

    /// Waits until `cond` holds on the probe; returns how long it took (nil: never).
    @discardableResult
    private func until(_ what: String, timeout: TimeInterval = 30, _ cond: (Probe) -> Bool) -> TimeInterval? {
        let t0 = Date()
        while Date().timeIntervalSince(t0) < timeout {
            if cond(probe()) { return Date().timeIntervalSince(t0) }
            usleep(250_000)
        }
        XCTFail("timed out: \(what) (\(probe().raw))")
        return nil
    }

    /// Inbound bytes per pulled page over `seconds` (the iPhone hears them).
    private func iphoneHears(_ seconds: TimeInterval = 3) -> [String: Any] {
        let a = probe()
        sleep(UInt32(seconds))
        let b = probe()
        var out: [String: Any] = [:]
        for page in pages {
            let x = b.pulls[page], y = a.pulls[page]
            let kbps = x.map { Int(Double(($0.bytes - (y?.bytes ?? 0)) * 8) / seconds / 1000) } ?? 0
            out[page] = ["kbps": kbps, "packets": (x?.packets ?? 0) - (y?.packets ?? 0)]
        }
        out["pc"] = b.pc
        out["sent_kbps"] = Int(Double((b.int("sent") - a.int("sent")) * 8) / seconds / 1000)
        return out
    }

    private func hearsAll(_ h: [String: Any], min kbps: Int = 5) -> Bool {
        pages.allSatisfy { ((h[$0] as? [String: Any])?["kbps"] as? Int ?? 0) >= kbps }
    }

    private func pagesHearIphone(_ min: Int = 5) -> (ok: Bool, result: [String: Any]) {
        let r = cmd("hearIos")
        let heard = r["heard"] as? [[String: Any]] ?? []
        let ok = heard.count == pages.count && heard.allSatisfy { ($0["kbps"] as? Int ?? 0) >= min }
        return (ok, r)
    }

    // MARK: - App

    private func launch(fresh: Bool) {
        let env = ProcessInfo.processInfo.environment
        var args = ["-serverURL", env["BAB_LIVE_SERVER"]!, "-sfuProbe", "YES", "-sfuProbeCtl", ctl, "-keepAliveLimit", "5"]
        if let relay = env["BAB_LIVE_RELAY"], let relayCtl = env["BAB_LIVE_RELAY_CTL"] {
            args += ["-sfuRelay", "127.0.0.1:\(relay)", "-sfuRelayCtl", relayCtl]
        }
        app = XCUIApplication()
        app.launchArguments = args
        app.launch()
    }

    private func register(_ user: String, _ pass: String) {
        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass)
        let tournament = app.buttons["Tournament"]
        for _ in 0..<3 where !tournament.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = tournament.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(tournament.waitForExistence(timeout: 20), "not in the main room after registering")
    }

    private func tapMic() {
        let mic = app.descendants(matching: .any)["tournament.mic"]
        XCTAssertTrue(mic.waitForExistence(timeout: 30), "the header's mic")
        mic.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
    }

    /// Unmuted and published: a phase that checks the pages hear the iPhone needs it (muted, a
    /// new session pushes nothing, step 4, so after one the pages have nothing to pull; `core`
    /// ends muted).
    private func unmuted() {
        if probe().fields["muted"] == "true" { tapMic() }
        until("published", timeout: 20) { $0.fields["pub"] == "mic" && $0.fields["muted"] == "false" }
    }

    // MARK: - The run

    func testTheTournamentRoomOnTheSfu() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let ctlDir = env["BAB_LIVE_CTL"], server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), _USER, _PASS, _CTL")
        }
        ctl = ctlDir
        phases = Set((env["BAB_LIVE_PHASES"] ?? "core,ice,relay,background,relaunch").split(separator: ",").map(String.init))
        launch(fresh: true)
        register(user, pass)
        let tournament = app.buttons["Tournament"]
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: tournament)
        wait(for: [enabled], timeout: 15)
        tournament.tap()
        XCTAssertTrue(app.descendants(matching: .any)["screen.tournamentLobby"].waitForExistence(timeout: 20), "no tournament lobby")
        XCTAssertTrue(app.descendants(matching: .any)["voice.sfu.probe"].waitForExistence(timeout: 10), "the probe (-sfuProbe YES)")
        // alone (if the pages are not in yet): no session
        let alone = probe()
        if alone.int("members") == 0 { XCTAssertEqual(alone.sid, "-", "alone: no session") }

        // the pages join and publish
        let ready = cmd("ready", timeout: 120)
        pages = (try? JSONSerialization.jsonObject(with: FileManager.default.contents(atPath: "\(ctl)/pages.json") ?? Data()) as? [String]) ?? []
        XCTAssertFalse(pages.isEmpty)
        save("0-ready", ["pages": pages, "ready": ready, "aloneProbe": alone.raw])

        // the iPhone (muted) hears every page: one session, one PeerConnection, a pull each
        let joinTime = until("every page pulled", timeout: 30) { p in self.pages.allSatisfy { p.pulls[$0] != nil } && p.pc == "connected" }
        let muted = iphoneHears()
        XCTAssertTrue(hearsAll(muted), "the iPhone hears every page: \(muted)")
        let p1 = probe()
        XCTAssertEqual(p1.fields["pub"], "-", "muted at the start: nothing pushed")
        XCTAssertEqual(p1.fields["sessions"], "1")
        save("1-iphone-hears", ["joinSeconds": joinTime ?? -1, "hears": muted, "probe": p1.raw])
        shot("1-joined")

        if phases.contains("bundle") { bundlePhase() }
        if phases.contains("blip"), env["BAB_LIVE_RELAY"] != nil { blipPhase() }
        if phases.contains("core") { core() }
        if phases.contains("ice") { ice() }
        if phases.contains("relay"), env["BAB_LIVE_RELAY"] != nil { relayPhase() }
        if phases.contains("background") { background() }
        if phases.contains("relaunch") { relaunch(user: user, pass: pass) }
        cmd("stop")
    }

    /// Both ways, mute, volume, speaking, a page leaving and coming back.
    private func core() {
        // the first unmute: the push; every page hears the iPhone
        tapMic()
        let pushTime = until("published", timeout: 20) { $0.fields["pub"] == "mic" }
        sleep(2)
        let heard = pagesHearIphone()
        XCTAssertTrue(heard.ok, "every page hears the iPhone after its first unmute: \(heard.result)")
        let hearsBack = iphoneHears()
        XCTAssertTrue(hearsAll(hearsBack), "and the iPhone still hears every page")
        save("2-unmuted", ["pushSeconds": pushTime ?? -1, "pagesHear": heard.result, "iphoneHears": hearsBack, "probe": probe().raw])

        // speaking levels: the pages' beep lights each pulled track at some poll
        var talked = Set<String>()
        for _ in 0..<24 {
            for (u, v) in probe().pulls where v.speaking == "talk" { talked.insert(u) }
            usleep(250_000)
        }
        XCTAssertEqual(talked, Set(pages), "every page seen speaking (the per-receiver poll)")

        // mute: the published track goes silent (still sending, so it stays pullable)
        tapMic()
        sleep(2)
        let mutedHeard = pagesHearIphone(1)
        save("3-muted", ["pagesHear": mutedHeard.result, "probe": probe().raw, "talked": Array(talked)])
        XCTAssertTrue(mutedHeard.ok, "muted: the pages still receive the silent track (packets)")

        // per-player volume (RTCAudioTrack.source.volume of the pulled track)
        let mic = app.descendants(matching: .any)["tournament.mic"]
        mic.press(forDuration: 1.2)
        let slider = app.sliders["voice.volume.\(pages[0])"]
        XCTAssertTrue(slider.waitForExistence(timeout: 10), "the voice panel's slider for \(pages[0])")
        slider.adjust(toNormalizedSliderPosition: 0)
        until("volume 0", timeout: 5) { $0.pulls[self.pages[0]]?.volume == "0.00" }
        shot("4-panel")
        slider.adjust(toNormalizedSliderPosition: 0.5)
        until("volume back", timeout: 5) { ($0.pulls[self.pages[0]]?.volume ?? "") != "0.00" }
        let mute = app.buttons["Mute \(pages[0])"]
        if mute.exists {
            mute.tap()
            until("muted row", timeout: 5) { $0.pulls[self.pages[0]]?.on == "off" }
            app.buttons["Unmute \(pages[0])"].tap()
            until("unmuted row", timeout: 5) { $0.pulls[self.pages[0]]?.on == "on" }
        }
        let volumeProbe = probe().raw
        app.buttons["Done"].tap()
        save("4-volume", ["probe": volumeProbe])

        // a page leaves the room and comes back (a new session there)
        let leaver = pages.count > 1 ? pages.count - 1 : 0
        let before = probe().pulls[pages[leaver]]
        cmd("leavePage", ["page": leaver])
        let goneIn = until("\(pages[leaver]) closed", timeout: 15) { $0.pulls[self.pages[leaver]] == nil }
        cmd("returnPage", ["page": leaver])
        let backIn = until("\(pages[leaver]) pulled again", timeout: 30) { ($0.pulls[self.pages[leaver]]?.bytes ?? 0) > 0 && ($0.pulls[self.pages[leaver]]?.bytes ?? 0) != before?.bytes }
        let again = iphoneHears()
        XCTAssertTrue(hearsAll(again), "the iPhone hears every page after the rejoin: \(again)")
        save("5-leave-rejoin", ["page": pages[leaver], "closedSeconds": goneIn ?? -1, "pulledAgainSeconds": backIn ?? -1, "hears": again, "probe": probe().raw])
    }

    /// Heard both ways by and from `subset` (pages by name).
    private func hearsBothWays(_ subset: [String], min kbps: Int = 5) -> (ok: Bool, iphone: [String: Any], pages: [String: Any]) {
        let h = iphoneHears()
        let r = cmd("hearIos")
        let heard = (r["heard"] as? [[String: Any]] ?? []).filter { subset.contains($0["page"] as? String ?? "") }
        let iphoneOk = subset.allSatisfy { ((h[$0] as? [String: Any])?["kbps"] as? Int ?? 0) >= kbps }
        let pagesOk = heard.count == subset.count && heard.allSatisfy { ($0["kbps"] as? Int ?? 0) >= kbps }
        return (iphoneOk && pagesOk, h, r)
    }

    /// The pull on the BUNDLE-tag m-section (mid 0: the muted iPhone's first pull) closes when
    /// its page leaves; the session must stay heard both ways (review of PR 3: a negotiated
    /// close of it took the transport down).
    private func bundlePhase() {
        unmuted()
        sleep(2)
        let before = probe()
        let tagUser = before.fields["tag"] ?? "-"
        guard let leaver = pages.firstIndex(of: tagUser) else {
            XCTFail("no page's pull on the BUNDLE tag: \(before.raw)")
            return
        }
        let others = pages.filter { $0 != tagUser }
        cmd("leavePage", ["page": leaver])
        let goneIn = until("\(tagUser) closed", timeout: 15) { $0.pulls[tagUser] == nil }
        var states: [String] = []
        for _ in 0..<12 {
            let pc = probe().pc
            if states.last != pc { states.append(pc) }
            usleep(500_000)
        }
        let after = hearsBothWays(others)
        let p = probe()
        XCTAssertEqual(states, ["connected"], "the PeerConnection stays connected after the BUNDLE tag's close")
        XCTAssertTrue(after.ok, "the others still heard both ways: \(after)")
        XCTAssertEqual(p.sid, before.sid, "the same session")
        XCTAssertEqual(p.int("sessions"), before.int("sessions"))
        cmd("returnPage", ["page": leaver])
        let backIn = until("\(tagUser) pulled again", timeout: 30) { ($0.pulls[tagUser]?.bytes ?? 0) > 0 }
        sleep(1)
        let again = hearsBothWays(pages)
        XCTAssertTrue(again.ok, "everyone heard both ways after the return: \(again)")
        XCTAssertEqual(probe().sid, before.sid, "still the same session")
        save("10-bundle-tag", ["tagPage": tagUser, "closedSeconds": goneIn ?? -1, "statesAfterClose": states, "afterClose": ["iphone": after.iphone, "pages": after.pages],
                               "sameSession": p.sid == before.sid, "pulledAgainSeconds": backIn ?? -1, "afterReturn": ["iphone": again.iphone, "pages": again.pages],
                               "probe": probe().raw])
    }

    /// A blip that takes the app's socket (the harness's proxy refuses it) and its SFU media
    /// (the relay cut) at once, as a Wi-Fi drop does: the same session (step 11: never a new one
    /// for it), resumed on the new socket, heard both ways again.
    private func blipPhase() {
        unmuted()
        var out: [String: Any] = [:]
        for seconds in [7, 12] {
            sleep(3)
            let before = probe()
            let t0 = Date()
            let r = cmd("blip", ["seconds": seconds], timeout: 60)
            var states: [String] = []
            var heard: TimeInterval?
            while Date().timeIntervalSince(t0) < Double(seconds) + 40 {
                let p = probe()
                let s = "\(p.pc)/\(p.sid)"
                if states.last != s { states.append(s) }
                if p.pc == "connected", pages.allSatisfy({ p.pulls[$0] != nil }) {
                    let a = probe(); usleep(1_500_000); let b = probe()
                    if pages.allSatisfy({ (b.pulls[$0]?.bytes ?? 0) > (a.pulls[$0]?.bytes ?? 0) }) { heard = Date().timeIntervalSince(t0) - Double(seconds); break }
                }
                usleep(250_000)
            }
            sleep(1)
            let both = hearsBothWays(pages)
            let after = probe()
            XCTAssertNotNil(heard, "blip \(seconds) s: the iPhone hears every page again")
            XCTAssertTrue(both.ok, "blip \(seconds) s: heard both ways again: \(both)")
            XCTAssertEqual(after.sid, before.sid, "blip \(seconds) s: the same session (never a new one for a signaling outage)")
            XCTAssertEqual(after.int("sessions"), before.int("sessions"), "blip \(seconds) s: no new session")
            XCTAssertGreaterThanOrEqual(after.int("resumes"), before.int("resumes") + 1, "blip \(seconds) s: resumed on the new socket")
            out["blip\(seconds)"] = ["harness": r, "heardAgainAfterRestoreSeconds": heard ?? -1, "states": states, "sameSession": after.sid == before.sid,
                                     "newSessions": after.int("sessions") - before.int("sessions"), "resumes": after.int("resumes") - before.int("resumes"),
                                     "restarts": after.int("restarts") - before.int("restarts"), "rec": after.fields["rec"] ?? "-",
                                     "iphoneHears": both.iphone, "pagesHear": both.pages, "probe": after.raw]
            save("11-blip\(seconds)", out["blip\(seconds)"]!)
        }
    }

    /// The undocumented ICE restart form (tracks/new re-declaring my track) from iOS WebRTC.
    private func ice() {
        unmuted()  // the restart form needs a published track
        sleep(1)
        var results: [[String: Any]] = []
        for i in 0..<3 {
            let n = probe().int("restarts")
            FileManager.default.createFile(atPath: "\(ctl)/app-ice-restart", contents: Data())  // SfuProbeView acts on it
            until("restart \(i + 1)", timeout: 15) { $0.int("restarts") == n + 1 && $0.fields["ice"] != "-" && $0.fields["rec"]?.hasPrefix("iceRestart_ok") == true }
            sleep(2)
            let p = probe()
            let heard = iphoneHears()
            let back = pagesHearIphone()
            XCTAssertTrue(hearsAll(heard) && back.ok, "still heard both ways after the restart")
            XCTAssertEqual(p.int("sessions"), probe().int("sessions"), "the same session")
            results.append(["answeredMs": Int(p.fields["ice"] ?? "") ?? -1, "rec": p.fields["rec"] ?? "-", "sid": p.sid, "iphoneHears": heard, "pagesHear": back.result])
        }
        save("6-ice-restart", ["restarts": results, "probe": probe().raw])
    }

    /// The simulator's network to the SFU cut (the harness's relay drops both ways) and back.
    private func relayPhase() {
        unmuted()
        var out: [String: Any] = [:]
        for (name, seconds) in [("cut8", 8), ("cut40", 40)] {
            let sid = probe().sid
            let sessions = probe().int("sessions")
            cmd("relay", ["mode": "cut"])
            var states: [String] = []
            for _ in 0..<(seconds * 2) {
                let pc = probe().pc
                if states.last != pc { states.append(pc) }
                usleep(500_000)
            }
            cmd("relay", ["mode": "restore"])
            let healed = until("\(name): heard again", timeout: 45) { p in
                p.pc == "connected" && self.pages.allSatisfy { p.pulls[$0] != nil }
            }
            sleep(1)
            let h = iphoneHears()
            let back = pagesHearIphone()
            XCTAssertTrue(hearsAll(h) && back.ok, "\(name): heard both ways again")
            let p = probe()
            out[name] = ["statesDuringCut": states, "connectedAfterRestoreSeconds": healed ?? -1, "sameSession": p.sid == sid,
                         "newSessions": p.int("sessions") - sessions, "rec": p.fields["rec"] ?? "-", "iphoneHears": h, "pagesHear": back.result,
                         "relay": cmd("relayState")]
        }
        // a NAT rebinding: the same local candidate, a new public port (the downlink stall detector)
        let restarts = probe().int("restarts"), sessionsBefore = probe().int("sessions")
        let t0 = Date()
        cmd("relay", ["mode": "rebind"])
        let restarted = until("the stall detector's restart", timeout: 20) { $0.int("restarts") > restarts || $0.int("sessions") > sessionsBefore }
        sleep(2)
        let h = iphoneHears()
        XCTAssertTrue(hearsAll(h), "rebind: the iPhone hears every page again")
        out["rebind"] = ["recoveredSeconds": restarted ?? -1, "totalSeconds": Date().timeIntervalSince(t0), "rec": probe().fields["rec"] ?? "-",
                         "iphoneHears": h, "pagesHear": pagesHearIphone().result]
        save("7-network", out)
    }

    /// Backgrounds: suspended as iOS does (SIGSTOP by the harness) for 5, 30 and 60 s, and 30 s
    /// not suspended (the simulator keeps a backgrounded app running).
    private func background() {
        var out: [String: Any] = [:]
        for (name, seconds, suspend) in [("bg5-suspended", 5, true), ("bg30-suspended", 30, true), ("bg60-suspended", 60, true), ("bg30-running", 30, false)] {
            let before = probe()
            XCUIDevice.shared.press(.home)
            sleep(1)
            if suspend { cmd("suspendApp") }
            sleep(UInt32(seconds))
            let pagesDuring = pagesHearIphone(1)
            if suspend { cmd("resumeApp") }
            let t0 = Date()
            app.activate()
            var states: [String] = []
            var heard: TimeInterval?
            while Date().timeIntervalSince(t0) < 60 {
                let p = probe()
                if states.last != "\(p.pc)/\(p.sid)" { states.append("\(p.pc)/\(p.sid)") }
                if p.pc == "connected", pages.allSatisfy({ p.pulls[$0] != nil }) {
                    let a = probe(); usleep(1_500_000); let b = probe()
                    if pages.allSatisfy({ (b.pulls[$0]?.bytes ?? 0) > (a.pulls[$0]?.bytes ?? 0) }) { heard = Date().timeIntervalSince(t0); break }
                }
                usleep(250_000)
            }
            XCTAssertNotNil(heard, "\(name): the iPhone hears the pages again")
            let back = pagesHearIphone()
            let after = probe()
            out[name] = ["seconds": seconds, "suspended": suspend, "hearsAgainAfterForegroundSeconds": heard ?? -1, "states": states,
                         "sameSession": after.sid == before.sid, "sessionsBefore": before.int("sessions"), "sessionsAfter": after.int("sessions"),
                         "resumes": after.int("resumes") - before.int("resumes"), "restarts": after.int("restarts") - before.int("restarts"),
                         "rec": after.fields["rec"] ?? "-", "pagesHearDuring": pagesDuring.result, "pagesHearAfter": back.result]
            save("8-\(name)", out[name]!)
            sleep(3)
        }
        save("8-background", out)
    }

    /// The app killed and launched again: signed in from the saved session, back into the
    /// tournament from the main room, the pages pulled again, heard again after an unmute.
    private func relaunch(user: String, pass: String) {
        app.terminate()
        sleep(3)
        let afterKill = cmd("pagesState")
        launch(fresh: false)
        // a debug launch under XCUITest may not keep the saved session: sign in again then
        let name = app.textFields["Username"]
        if name.waitForExistence(timeout: 8) {
            name.tap(); name.typeText(user)
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
            app.buttons.matching(NSPredicate(format: "label == %@", "Sign In")).firstMatch.tap()
        }
        let join = app.buttons.matching(NSPredicate(format: "label == %@", "Join")).firstMatch
        XCTAssertTrue(join.waitForExistence(timeout: 40), "the tournament's Join in the main room")
        let t0 = Date()
        join.tap()
        XCTAssertTrue(app.descendants(matching: .any)["screen.tournamentLobby"].waitForExistence(timeout: 20))
        let hears = until("the pages pulled after the relaunch", timeout: 40) { p in p.pc == "connected" && self.pages.allSatisfy { p.pulls[$0] != nil } }
        let h = iphoneHears()
        XCTAssertTrue(hearsAll(h), "after a relaunch the iPhone hears every page")
        tapMic()
        until("published again", timeout: 20) { $0.fields["pub"] == "mic" }
        sleep(3)
        let back = pagesHearIphone()
        XCTAssertTrue(back.ok, "and every page hears it after its unmute")
        save("9-relaunch", ["pagesAfterKill": afterKill, "pulledSeconds": hears ?? -1, "sinceJoinSeconds": Date().timeIntervalSince(t0),
                            "iphoneHears": h, "pagesHear": back.result, "probe": probe().raw])
        shot("9-relaunched")
    }
}
