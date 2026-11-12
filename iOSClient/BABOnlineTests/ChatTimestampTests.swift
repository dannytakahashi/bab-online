import XCTest
@testable import BAB_Online

/// Item 6 (owner, 2026-11-11): chat lines carry the SERVER's time, and the lists show
/// Messages-style dividers: above the first message and after a gap of more than ~15 min,
/// worded "Today 2:14 PM" / "Yesterday 9:03 PM" / "Mon 4:10 PM" / "Nov 3, 4:10 PM".
final class ChatTimestampTests: XCTestCase {
    private let tz = TimeZone(identifier: "America/Los_Angeles")!
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = tz
        return c
    }

    /// 2026-11-11 (a Wednesday) h:m in Los Angeles, `daysAgo` days earlier.
    private func at(_ h: Int, _ m: Int, daysAgo: Int = 0, year: Int = 2026, month: Int = 11, day: Int = 11) -> Date {
        let base = calendar.date(from: DateComponents(timeZone: tz, year: year, month: month, day: day, hour: h, minute: m))!
        return calendar.date(byAdding: .day, value: -daysAgo, to: base)!
    }

    private var now: Date { at(18, 30) }
    private let us = Locale(identifier: "en_US")
    private let us24 = Locale(identifier: "en_US@hours=h23")   // the device's 24-Hour Time switch
    private let gb = Locale(identifier: "en_GB")

    private func label(_ d: Date, _ locale: Locale) -> String {
        // DateFormatter may use a narrow no-break space before AM/PM: compare with plain spaces
        ChatTimestamps.label(for: d, now: now, locale: locale, calendar: calendar)
            .replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    // MARK: wording

    func testTodayYesterdayWeekdayDate() {
        XCTAssertEqual(label(at(14, 14), us), "Today 2:14 PM")
        XCTAssertEqual(label(at(21, 3, daysAgo: 1), us), "Yesterday 9:03 PM")
        XCTAssertEqual(label(at(16, 10, daysAgo: 2), us), "Mon 4:10 PM")         // Nov 9
        XCTAssertEqual(label(at(16, 10, daysAgo: 6), us), "Thu 4:10 PM")         // Nov 5: still within the week
        XCTAssertEqual(label(at(16, 10, daysAgo: 8), us), "Nov 3, 4:10 PM")
        XCTAssertEqual(label(at(9, 5, year: 2025, month: 12, day: 24), us), "Dec 24, 2025, 9:05 AM")
    }

    func testTwentyFourHourSettingAndLocale() {
        XCTAssertEqual(label(at(14, 14), us24), "Today 14:14")
        XCTAssertEqual(label(at(16, 10, daysAgo: 8), us24), "Nov 3, 16:10")
        XCTAssertEqual(label(at(9, 3, daysAgo: 1), gb), "Yesterday 09:03")
        XCTAssertEqual(label(at(16, 10, daysAgo: 8), gb), "3 Nov, 16:10")
        // another language: the day words and order are the locale's
        let de = label(at(14, 14), Locale(identifier: "de_DE"))
        XCTAssertTrue(de.hasPrefix("Heute"), de)
        XCTAssertTrue(de.hasSuffix("14:14"), de)
    }

    func testMidnightBoundariesUseTheCalendarDay() {
        XCTAssertEqual(ChatTimestamps.dayKind(at(0, 1), now: now, calendar: calendar), .today)
        XCTAssertEqual(ChatTimestamps.dayKind(at(23, 59, daysAgo: 1), now: now, calendar: calendar), .yesterday)
        XCTAssertEqual(ChatTimestamps.dayKind(at(0, 0, daysAgo: 6), now: now, calendar: calendar), .thisWeek)
        XCTAssertEqual(ChatTimestamps.dayKind(at(23, 59, daysAgo: 7), now: now, calendar: calendar), .older(sameYear: true))
        // a server clock a little ahead reads as today, never as a future day
        XCTAssertEqual(ChatTimestamps.dayKind(now.addingTimeInterval(30), now: now, calendar: calendar), .today)
    }

    func testVoiceOverReadsTheFullForm() {
        let spoken = ChatTimestamps.spokenLabel(for: at(14, 14), now: now, locale: us, calendar: calendar)
            .replacingOccurrences(of: "\u{202F}", with: " ")
        XCTAssertTrue(spoken.hasPrefix("Today"), spoken)
        XCTAssertTrue(spoken.contains("2:14 PM"), spoken)
        let older = ChatTimestamps.spokenLabel(for: at(16, 10, daysAgo: 8), now: now, locale: us, calendar: calendar)
        XCTAssertTrue(older.contains("Tuesday, November 3, 2026"), older)
    }

    // MARK: divider rules

    func testDividersAboveTheFirstAndAfterAGap() {
        let t0 = at(10, 0)
        let dates = [t0, t0 + 60, t0 + 14 * 60, t0 + 29 * 60, t0 + 44 * 60 + 1, t0 + 45 * 60, t0 + 3 * 3600]
        // 14 -> 29 min is 15 min exactly: not more than the gap, no divider
        XCTAssertEqual(ChatTimestamps.dividerIndices(dates), [0, 4, 6])
        XCTAssertEqual(ChatTimestamps.dividerIndices([]), [])
        XCTAssertEqual(ChatTimestamps.dividerIndices([t0]), [0])
        XCTAssertEqual(ChatTimestamps.gap, 15 * 60)
    }

    // MARK: the server's time

    func testServerDateParsesEveryWireForm() {
        let ms = 1_762_900_440_000.0   // 2025-11-11T22:34:00Z
        let want = Date(timeIntervalSince1970: ms / 1000)
        XCTAssertEqual(ChatMessage.serverDate(Int(ms)), want)
        XCTAssertEqual(ChatMessage.serverDate(NSNumber(value: ms)), want)
        XCTAssertEqual(ChatMessage.serverDate(ms), want)
        XCTAssertEqual(ChatMessage.serverDate("1762900440000"), want)
        XCTAssertEqual(ChatMessage.serverDate(1_762_900_440), want)                // seconds
        XCTAssertEqual(ChatMessage.serverDate("2025-11-11T22:34:00Z"), want)
        XCTAssertEqual(ChatMessage.serverDate("2025-11-11T22:34:00.000Z"), want)
        XCTAssertNil(ChatMessage.serverDate(nil))
        XCTAssertNil(ChatMessage.serverDate(true))
        XCTAssertNil(ChatMessage.serverDate("soon"))
        XCTAssertNil(ChatMessage.serverDate(0))
    }

    func testChatLinesKeepTheServersTimestamp() {
        let sent = Date().addingTimeInterval(-3 * 3600)
        let ms = Int(sent.timeIntervalSince1970 * 1000)
        // main room / lobby lines ({username, message, timestamp}), tournament lines (+ isSpectator)
        let main = ChatMessage.from(["username": "ann", "message": "hi", "timestamp": ms])
        XCTAssertEqual(main!.timestamp.timeIntervalSince1970, sent.timeIntervalSince1970, accuracy: 0.001)
        let tour = ChatMessage.from(["username": "bo", "message": "gg", "isSpectator": true, "timestamp": ms])
        XCTAssertEqual(tour!.timestamp.timeIntervalSince1970, sent.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(tour!.type, .spectator)
        // no time on the wire: now (a live line)
        let live = ChatMessage.from(["username": "cy", "message": "yo"])!
        XCTAssertLessThan(abs(live.timestamp.timeIntervalSinceNow), 5)
    }

    func testMainRoomHistoryIsNotNow() {
        let handler = MainRoomState()
        let old = Int(Date().addingTimeInterval(-2 * 86400).timeIntervalSince1970 * 1000)
        handler.messages = [["username": "ann", "message": "old", "timestamp": old]].compactMap { ChatMessage.from($0) }
        XCTAssertGreaterThan(-handler.messages[0].timestamp.timeIntervalSinceNow, 86400)
    }

    func testSnapshotLogUsesAt() throws {
        let sent = 1_762_900_440_000
        let snap = try T.snapshot("trick-mid-lead3") { raw in
            raw["log"] = [
                ["message": "ann: hello", "type": "chat", "position": 1, "at": sent],
                ["message": "Bids are in", "type": "system", "position": NSNull(), "at": sent + 20 * 60 * 1000],
            ]
            raw["partial"] = []
        }
        let s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .requested("t"))
        XCTAssertEqual(s.log.entries.map(\.timestamp.timeIntervalSince1970), [1_762_900_440, 1_762_901_640])
        XCTAssertEqual(ChatTimestamps.dividerIndices(s.log.entries.map(\.timestamp)), [0, 1])
    }

    func testLiveTableLinesAreStampedOnArrival() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("chatMessage", ["username": "P", "message": "hi", "position": 3, "isSpectator": false]))
        XCTAssertLessThan(abs(s.log.entries.last!.timestamp.timeIntervalSinceNow), 5)
    }
}
