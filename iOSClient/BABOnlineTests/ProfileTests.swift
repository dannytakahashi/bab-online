import XCTest
import SpriteKit
@testable import BAB_Online

/// Profiles (iOS 1.2.2): the stats grid's numbers against the web's (ProfilePage.js
/// createStatsGrid), the profile replies' decoding, which page and which sheet a reply lands
/// on (ProfileState), the picture changes, the upload's image (the web's resizeImage: centre
/// crop, a circle with 16% padding, a 200 px PNG data URL), the passwords as sent, and the
/// seat avatar's tap target in the scene.
@MainActor
final class ProfileTests: XCTestCase {
    // MARK: - The grid

    func testGridMatchesTheWebForAnAccountWithGames() {
        let stats = ProfileStats(wire: [
            "gamesPlayed": 51, "wins": 30, "losses": 21, "totalPoints": 11801, "totalTricksBid": 637,
            "totalTricksTaken": 650, "totalHands": 663, "totalSets": 77, "totalSetPoints": 3080,
            "totalFaults": 10, "totalHSI": 5370.3,
        ] as [String: Any])
        // the web's order, labels and formats: toFixed(1) per game, toFixed(2) per bid and faults
        XCTAssertEqual(stats.cells.map(\.label), ["Games Played", "Wins", "Losses", "Win Rate", "Points/Game", "Bids/Game",
                                                  "Tricks/Game", "Tricks/Bid", "Set Rate", "Drag", "Faults/Game", "HSI"])
        XCTAssertEqual(stats.cells.map(\.value), ["51", "30", "21", "58.8%", "231.4", "12.5", "12.7", "1.02", "11.6%", "60.4", "0.20", "8.1"])
        XCTAssertEqual(Set(stats.cells.map(\.id)).count, 12)
    }

    func testGridOfAnAccountWithNoGamesIsTheWebsZeros() {
        for wire in [nil, [:], ["gamesPlayed": 0], "nonsense", ["gamesPlayed": true]] as [Any?] {
            XCTAssertEqual(ProfileStats(wire: wire).cells.map(\.value), ["0", "0", "0", "0%", "0", "0", "0", "0", "0%", "0", "0", "0"])
        }
        // games but no hands or bids recorded (a legacy account): the divisions that have nothing stay "0"
        let legacy = ProfileStats(wire: ["gamesPlayed": 4, "wins": 1, "losses": 3, "totalPoints": 500])
        XCTAssertEqual(legacy.cells.map(\.value), ["4", "1", "3", "25.0%", "125.0", "0.0", "0.0", "0", "0%", "0.0", "0.00", "0"])
    }

    // MARK: - Replies

    func testProfileReplyDecoding() {
        let reply: [String: Any] = [
            "success": true, "scope": "all", "avatarUrl": "/avatar/kim?v=0123456789abcdef",
            "profile": ["username": "kim", "profilePic": 12, "customProfilePic": NSNull(), "stats": ["gamesPlayed": 3]] as [String: Any],
        ]
        let p = PlayerProfile.from(response: reply)
        XCTAssertEqual(p?.username, "kim")
        XCTAssertEqual(p?.pictureKey, "/avatar/kim?v=0123456789abcdef", "a custom picture is its versioned path")
        XCTAssertEqual(p?.stats.gamesPlayed, 3)

        var stock = reply
        stock["avatarUrl"] = nil
        XCTAssertEqual(PlayerProfile.from(response: stock)?.pictureKey, "12")
        stock["avatarUrl"] = "https://elsewhere.invalid/avatar/kim"
        XCTAssertEqual(PlayerProfile.from(response: stock)?.pictureKey, "12", "only a same-origin /avatar path is loaded")
        stock["profile"] = ["username": "kim", "profilePic": 500]
        XCTAssertEqual(PlayerProfile.from(response: stock)?.profilePic, 1, "a stock number out of range: picture 1")

        XCTAssertNil(PlayerProfile.from(response: ["success": false, "message": "Player not found"]))
        XCTAssertNil(PlayerProfile.from(response: ["success": true, "profile": ["profilePic": 3]]))
        XCTAssertEqual(ProfilePicture.stockCount, 82)
        XCTAssertEqual(StatsScope.bots.profilePayload as? [String: String], ["scope": "bots"])
        XCTAssertEqual(StatsScope.human.profilePayload as? [String: String], ["scope": "human"], "profile requests always name the scope")
    }

    private func reply(_ name: String, games: Int, scope: String? = "human", avatar: String? = nil, pic: Int = 5) -> [String: Any] {
        var r: [String: Any] = ["success": true, "profile": ["username": name, "profilePic": pic, "customProfilePic": NSNull(),
                                                              "stats": ["gamesPlayed": games]] as [String: Any]]
        if let scope { r["scope"] = scope }
        if let avatar { r["avatarUrl"] = avatar }
        return r
    }

    private func state() -> (ProfileState, sent: () -> [String]) {
        let s = ProfileState()
        var sent: [String] = []
        s.sendOwn = { sent.append("own:\($0.rawValue)") }
        s.sendPlayer = { sent.append("player:\($0):\($1.rawValue)") }
        s.sendStockPic = { sent.append("stock:\($0)") }
        s.sendUpload = { sent.append("upload:\($0.prefix(22)):\($0.count)") }
        return (s, { sent })
    }

    // MARK: - My own profile

    func testOwnStatsLandOnTheScopeTheReplyNames() {
        let (s, sent) = state()
        s.requestOwn(username: "ivy", scope: .human)
        s.requestOwn(username: "ivy", scope: .human)
        s.requestOwn(username: "ivy", scope: .bots)
        XCTAssertEqual(sent(), ["own:human", "own:bots"], "one request per scope while it waits")
        XCTAssertEqual(s.ownLoads[.human]?.isLoading, true)

        // the Bots answer first
        s.applyOwn(response: reply("ivy", games: 0, scope: "bots", pic: 31))
        XCTAssertEqual(s.ownLoads[.bots]?.stats?.gamesPlayed, 0)
        XCTAssertEqual(s.ownLoads[.bots]?.isLoading, false)
        XCTAssertNil(s.ownLoads[.human]?.stats)
        XCTAssertEqual(s.ownLoads[.human]?.isLoading, true)
        XCTAssertEqual(s.ownPictureKey, "31")

        // a success without an echo is human games (every request names its scope)
        s.applyOwn(response: reply("ivy", games: 51, scope: nil, pic: 31))
        XCTAssertEqual(s.ownLoads[.human]?.stats?.gamesPlayed, 51)
        XCTAssertEqual(s.ownLoads[.human]?.isLoading, false)

        // an echo this build does not know, and another account's reply: dropped
        s.applyOwn(response: reply("ivy", games: 9, scope: "ranked"))
        s.applyOwn(response: reply("someone", games: 9))
        XCTAssertEqual(s.ownLoads[.human]?.stats?.gamesPlayed, 51)
    }

    func testOwnFailureAnswersTheOldestRequestAndKeepsTheNumbers() {
        let (s, _) = state()
        s.requestOwn(username: "ivy", scope: .human)
        s.applyOwn(response: reply("ivy", games: 51))
        s.requestOwn(username: "ivy", scope: .human)
        s.requestOwn(username: "ivy", scope: .all)
        s.applyOwn(response: ["success": false, "message": "Database error"])
        XCTAssertEqual(s.ownLoads[.human]?.failure?.message, "Database error")
        XCTAssertEqual(s.ownLoads[.human]?.stats?.gamesPlayed, 51, "the last good numbers stay")
        XCTAssertEqual(s.ownLoads[.all]?.isLoading, true, "the other request still waits")
        // a failure with nothing waiting is dropped
        s.applyOwn(response: reply("ivy", games: 60, scope: "all"))
        s.applyOwn(response: ["success": false])
        XCTAssertNil(s.ownLoads[.all]?.failure)
    }

    func testAnotherAccountStartsFromNothing() {
        let (s, _) = state()
        s.requestOwn(username: "ivy", scope: .human)
        s.applyOwn(response: reply("ivy", games: 51, avatar: "/avatar/ivy?v=1"))
        XCTAssertEqual(s.ownPictureKey, "/avatar/ivy?v=1")
        s.requestOwn(username: "kim", scope: .human)
        XCTAssertEqual(s.ownUsername, "kim")
        XCTAssertNil(s.ownPictureKey)
        XCTAssertNil(s.ownLoads[.human]?.stats)
        s.applyOwn(response: reply("ivy", games: 51))
        XCTAssertNil(s.ownLoads[.human]?.stats, "the old account's late reply is not shown")
    }

    func testOwnRequestTimesOut() {
        let (s, _) = state()
        s.timeout = 0.05
        s.requestOwn(username: "ivy", scope: .human)
        let done = expectation(description: "timeout")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { done.fulfill() }
        wait(for: [done], timeout: 2)
        XCTAssertEqual(s.ownLoads[.human]?.failure, .noReply)
        XCTAssertEqual(s.ownLoads[.human]?.isLoading, false)
    }

    // MARK: - My picture

    func testChoosingAStockPicture() {
        let (s, sent) = state()
        s.requestOwn(username: "ivy", scope: .human)
        s.applyOwn(response: reply("ivy", games: 1, avatar: "/avatar/ivy?v=1"))
        s.chooseStockPic(0)
        s.chooseStockPic(83)
        XCTAssertFalse(s.pictureBusy, "out of range: not sent")
        s.chooseStockPic(12)
        s.chooseStockPic(13)
        XCTAssertEqual(sent().filter { $0.hasPrefix("stock") }, ["stock:12"], "one change at a time")
        XCTAssertTrue(s.pictureBusy)
        s.applyStockPic(response: ["success": true, "profilePic": 12])
        XCTAssertFalse(s.pictureBusy)
        XCTAssertEqual(s.ownPictureKey, "12", "the stock picture shows in place of the custom one, as on the web")
        XCTAssertEqual(s.pictureNotice?.message, "Profile picture updated!")
        XCTAssertEqual(s.pictureNotice?.success, true)

        s.chooseStockPic(40)
        s.applyStockPic(response: ["success": false, "message": "Database error"])
        XCTAssertEqual(s.ownPictureKey, "12")
        XCTAssertEqual(s.pictureNotice?.message, "Database error")
        XCTAssertEqual(s.pictureNotice?.success, false)
        s.chooseStockPic(40)
        s.applyStockPic(response: ["success": false])
        XCTAssertEqual(s.pictureNotice?.message, "Failed to update profile picture", "the web's fallback wording")
    }

    func testUploadSendsThePaddedCircleAndShowsItAtOnce() throws {
        let (s, sent) = state()
        s.requestOwn(username: "ivy", scope: .human)
        s.applyOwn(response: reply("ivy", games: 1, pic: 31))
        s.upload(imageData: Data("not an image".utf8))
        XCTAssertEqual(s.pictureNotice?.message, "Failed to process image. Please try again.")
        XCTAssertFalse(s.pictureBusy)
        XCTAssertTrue(sent().allSatisfy { !$0.hasPrefix("upload") })

        s.upload(imageData: try XCTUnwrap(Self.photo(width: 600, height: 400).jpegData(compressionQuality: 0.9)))
        XCTAssertTrue(s.pictureBusy)
        let upload = try XCTUnwrap(sent().first { $0.hasPrefix("upload") })
        XCTAssertTrue(upload.hasPrefix("upload:data:image/png;base64,:"), upload)
        s.applyUpload(response: ["success": true, "customProfilePic": "data:image/webp;base64,AAAA", "avatarUrl": "/avatar/ivy?v=00000000000000aa"])
        XCTAssertFalse(s.pictureBusy)
        XCTAssertEqual(s.ownPictureKey, "/avatar/ivy?v=00000000000000aa", "the new version's path: what every cache loads")
        XCTAssertEqual(s.ownUploaded?.size, CGSize(width: 200, height: 200), "the picture sent shows at once")
        XCTAssertEqual(s.pictureNotice?.message, "Profile picture uploaded!")

        // the same path again in a later profile reply keeps the picture; a new path replaces it
        s.requestOwn(username: "ivy", scope: .all)
        s.applyOwn(response: reply("ivy", games: 1, scope: "all", avatar: "/avatar/ivy?v=00000000000000aa", pic: 31))
        XCTAssertNotNil(s.ownUploaded)
        s.requestOwn(username: "ivy", scope: .all)
        s.applyOwn(response: reply("ivy", games: 1, scope: "all", avatar: "/avatar/ivy?v=00000000000000bb", pic: 31))
        XCTAssertNil(s.ownUploaded)

        s.upload(imageData: try XCTUnwrap(Self.photo(width: 300, height: 300).pngData()))
        s.applyUpload(response: ["success": false, "message": "Busy, try again"])
        XCTAssertEqual(s.pictureNotice?.message, "Busy, try again")
        XCTAssertEqual(s.ownPictureKey, "/avatar/ivy?v=00000000000000bb")
    }

    func testPictureChangeTimesOut() {
        let (s, _) = state()
        s.timeout = 0.05
        s.chooseStockPic(3)
        let done = expectation(description: "timeout")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { done.fulfill() }
        wait(for: [done], timeout: 2)
        XCTAssertFalse(s.pictureBusy)
        XCTAssertEqual(s.pictureNotice?.message, ProfileState.noAnswer)
    }

    // MARK: - Another player

    func testViewedProfileAndScopes() {
        let (s, sent) = state()
        s.view("kim", scope: .human)
        XCTAssertEqual(sent(), ["player:kim:human"])
        XCTAssertEqual(s.viewed?.displayName, "kim")
        XCTAssertEqual(s.viewed?.loads[.human]?.isLoading, true)
        s.applyPlayer(response: reply("kim", games: 42, avatar: "/avatar/kim?v=3"))
        XCTAssertEqual(s.viewed?.username, "kim")
        XCTAssertEqual(s.viewed?.pictureKey, "/avatar/kim?v=3")
        XCTAssertEqual(s.viewed?.loads[.human]?.stats?.gamesPlayed, 42)

        s.requestViewed(scope: .bots)
        s.requestViewed(scope: .bots)
        XCTAssertEqual(sent(), ["player:kim:human", "player:kim:bots"])
        s.applyPlayer(response: reply("kim", games: 2, scope: "bots"))
        XCTAssertEqual(s.viewed?.loads[.bots]?.stats?.gamesPlayed, 2)
        XCTAssertEqual(s.viewed?.loads[.human]?.stats?.gamesPlayed, 42, "each scope keeps its page")
    }

    func testALateReplyForAnEarlierSheetIsNotShownUnderTheOpenOne() {
        let (s, _) = state()
        s.view("kim", scope: .human)
        s.closeViewed("kim")
        s.view("hal", scope: .human)
        s.applyPlayer(response: reply("kim", games: 42))
        XCTAssertNil(s.viewed?.username, "kim's answer is not hal's")
        XCTAssertEqual(s.viewed?.loads[.human]?.isLoading, true)
        s.applyPlayer(response: reply("hal", games: 7))
        XCTAssertEqual(s.viewed?.username, "hal")
        XCTAssertEqual(s.viewed?.loads[.human]?.stats?.gamesPlayed, 7)

        // a failure names nobody: it answers the oldest request (a bot seat's, closed since)
        s.view("🤖 Mary", scope: .human)
        s.closeViewed("🤖 Mary")
        s.view("jon", scope: .human)
        s.applyPlayer(response: ["success": false, "message": "Player not found"])
        XCTAssertNil(s.viewed?.loads[.human]?.failure, "the bot's Player not found is not jon's")
        s.applyPlayer(response: reply("jon", games: 25))
        XCTAssertEqual(s.viewed?.loads[.human]?.stats?.gamesPlayed, 25)

        // closing an older sheet's name does not close the open one
        s.closeViewed("kim")
        XCTAssertEqual(s.viewed?.requested, "jon")
    }

    func testAMergedAccountsOldNameShowsTheAccountItJoined() {
        let (s, _) = state()
        s.view("old-kim", scope: .human)
        s.applyPlayer(response: reply("kim", games: 42))
        XCTAssertEqual(s.viewed?.requested, "old-kim")
        XCTAssertEqual(s.viewed?.displayName, "kim")
        XCTAssertEqual(s.viewed?.loads[.human]?.stats?.gamesPlayed, 42)
    }

    func testPlayerNotFound() {
        let (s, _) = state()
        s.view("🤖 Mary", scope: .all)
        s.applyPlayer(response: ["success": false, "message": "Player not found"])
        XCTAssertNil(s.viewed?.username)
        XCTAssertEqual(s.viewed?.loads[.all]?.failure?.message, "Player not found")
        XCTAssertEqual(s.viewed?.loads[.all]?.isLoading, false)
    }

    // MARK: - The upload's image

    /// Left half red, right half blue (so the crop shows).
    private static func photo(width: CGFloat, height: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { _ in
            UIColor.red.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: width / 2, height: height))
            UIColor.blue.setFill()
            UIRectFill(CGRect(x: width / 2, y: 0, width: width / 2, height: height))
        }
    }

    private static func rgba(_ image: UIImage, _ x: Int, _ y: Int) -> [UInt8] {
        let cg = image.cgImage!
        var px = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: -CGFloat(x), y: -CGFloat(cg.height - 1 - y), width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return px
    }

    func testUploadImageIsTheWebsPaddedCircle() throws {
        // a 600 x 400 photo: the centre 400 x 400 square (x 100...500) fills the circle
        let out = ProfilePicture.render(Self.photo(width: 600, height: 400))
        XCTAssertEqual(out.size, CGSize(width: 200, height: 200))
        XCTAssertEqual(out.scale, 1)
        XCTAssertEqual(out.cgImage?.width, 200, "200 pixels, whatever the screen's scale")
        // the 16% margin (32 px) is transparent on every edge, and so are the corners
        for (x, y) in [(0, 0), (199, 0), (0, 199), (199, 199), (100, 10), (100, 28), (10, 100), (28, 100), (189, 100), (100, 189), (45, 45)] {
            XCTAssertEqual(Self.rgba(out, x, y)[3], 0, "(\(x),\(y)) is outside the circle")
        }
        // inside the circle (radius 68 about the centre) the photo is opaque
        for (x, y) in [(100, 100), (36, 100), (163, 100), (100, 36), (100, 163), (60, 60)] {
            XCTAssertEqual(Self.rgba(out, x, y)[3], 255, "(\(x),\(y)) is inside the circle")
        }
        // the photo's vertical middle is the circle's: red left of centre, blue right of it
        let left = Self.rgba(out, 70, 100), right = Self.rgba(out, 130, 100)
        XCTAssertGreaterThan(left[0], 200); XCTAssertLessThan(left[2], 60)
        XCTAssertGreaterThan(right[2], 200); XCTAssertLessThan(right[0], 60)
        // a tall photo crops the same way (its width fills the circle's width)
        let tall = ProfilePicture.render(Self.photo(width: 300, height: 900))
        XCTAssertGreaterThan(Self.rgba(tall, 40, 100)[0], 200, "the left edge of the photo reaches the circle's left edge")
        XCTAssertGreaterThan(Self.rgba(tall, 160, 100)[2], 200)
    }

    func testUploadPayloadIsAPngDataUrlWithinTheServersLimit() throws {
        let made = try ProfilePicture.dataURL(for: Self.photo(width: 4000, height: 3000)).get()
        XCTAssertTrue(made.url.hasPrefix("data:image/png;base64,"))
        XCTAssertLessThanOrEqual(made.url.count, 682_666, "the handler's 500 KB check; the contract allows 682700")
        XCTAssertLessThanOrEqual(ProfilePicture.maxDataURLLength, 682_700)
        let back = try XCTUnwrap(ProfilePicture.image(fromDataURL: made.url))
        XCTAssertEqual(back.cgImage?.width, 200)
        XCTAssertEqual(back.cgImage?.height, 200)
        XCTAssertNil(ProfilePicture.image(fromDataURL: "/avatar/kim?v=1"))

        // a picked file: decoded no larger than 800 px before the crop, upright
        let file = try XCTUnwrap(Self.photo(width: 3000, height: 2000).jpegData(compressionQuality: 0.8))
        let decoded = try XCTUnwrap(ProfilePicture.decode(file))
        XCTAssertEqual(max(decoded.size.width, decoded.size.height), 800)
        XCTAssertNil(ProfilePicture.decode(Data("nope".utf8)))
        XCTAssertEqual(ProfilePicture.upload(from: Data()).failure, .unreadable)
    }

    // MARK: - Passwords as sent

    func testPasswordsAreSentTrimmedLikeTheWeb() {
        XCTAssertEqual(PasswordEntry.sent("  hunter22 \n"), "hunter22")
        XCTAssertEqual(PasswordEntry.sent("two words"), "two words", "inner spaces stay")
        XCTAssertEqual(PasswordEntry.sent("   "), "")
        XCTAssertNil(PasswordEntry.asTypedFallback("hunter22"), "nothing to fall back to")
        XCTAssertEqual(PasswordEntry.asTypedFallback("hunter22 "), "hunter22 ", "an older iOS password may end in the space")
        XCTAssertNil(PasswordEntry.asTypedFallback("   "), "an empty password is never sent")
        // the new-password rule counts the characters that are sent
        XCTAssertNotNil(PasswordRule.newPasswordProblem(PasswordEntry.sent(" 1234567 ")))
        XCTAssertNil(PasswordRule.newPasswordProblem(PasswordEntry.sent(" 12345678 ")))
    }

    // MARK: - The seat avatar's tap target

    func testSeatTapFindsTheSeatUnderThePoint() throws {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        let size = CGSize(width: 466, height: 678)
        let h = ReplayHarness()
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        XCTAssertNil(scene.seatName(at: CGPoint(x: 233, y: 339)), "no table yet")
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))

        let nodes = scene.opponentManager.nodes
        XCTAssertEqual(nodes.count, 3)
        for node in nodes.values {
            let center = node.convert(CGPoint.zero, to: scene)
            XCTAssertEqual(scene.seatName(at: center), node.fullName, "the avatar's centre")
            XCTAssertEqual(scene.seatName(at: node.convert(CGPoint(x: 0, y: -34), to: scene)), node.fullName, "the name under it")
            XCTAssertEqual(scene.seatName(at: node.convert(CGPoint(x: 21, y: 21), to: scene)), node.fullName, "a 44 pt target")
            XCTAssertNil(scene.seatName(at: node.convert(CGPoint(x: 0, y: 60), to: scene)), "above the seat")
        }
        XCTAssertNil(scene.seatName(at: CGPoint(x: size.width / 2, y: 20)), "my hand is not a seat")
        XCTAssertNil(scene.seatName(at: CGPoint(x: size.width / 2, y: size.height / 2)), "the trick area is not a seat")
        // no node became interactive: only the hand's cards take touches
        XCTAssertTrue(nodes.values.allSatisfy { !$0.isUserInteractionEnabled })
    }

    func testSeatTapsReachTheTablesHostOnly() {
        var got: [String] = []
        let sub = SeatTaps.subject.sink { got.append($0) }
        SeatTaps.subject.send("kim")
        sub.cancel()
        XCTAssertEqual(got, ["kim"])
    }
}

private extension Result {
    var failure: Failure? {
        if case .failure(let f) = self { return f }
        return nil
    }
}
