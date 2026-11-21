import XCTest
@testable import BAB_Online

/// The over-the-shoulder view's mirrored hint cards (docs/claude/spectators.md, owner
/// 2026-11-21): the words a watched seat's advice and tip show (AssistRules / TutorialRules
/// "A watched seat's hint"). Whose hand it is by name ("Alice's advice", "Alice's tip"), and no
/// count, "Not counted", free / unlimited or bot-assisted words anywhere, whatever the copy's
/// uses / freeUses / assisted / counted / unlimited say (they are the watched player's).
final class WatchedHintTests: XCTestCase {
    private func advice(_ kind: AssistHint.Kind = .bid, uses: Int = 2, counted: Bool = true, assisted: Bool = false,
                        unlimited: Bool = false, source: String = "help", confidence: String? = "clear",
                        note: String? = nil) -> AssistHint {
        var h = AssistHint(kind: kind, headline: kind == .status ? "Not your turn yet." : "Bid 2", turnKey: "1|BIDDING|1|0|0")
        h.source = source
        h.uses = uses
        h.counted = counted
        h.assisted = assisted
        h.unlimited = unlimited
        h.confidence = confidence
        h.note = note
        if kind != .status { h.reasons = ["Your hand should take about 2 tricks.", "Alice's partner bid 1."] }
        return h
    }

    /// No count words of the asker's own card in a watched card's text.
    private let countWords = ["Help ", "free", "Free", "counted", "Counted", "bot-assisted", "unlimited", "Unlimited", " of 3"]

    private func assertNoCounts(_ text: String?, _ tag: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let text else { return }
        for w in countWords {
            XCTAssertFalse(text.contains(w), "\(tag): \"\(text)\" has \"\(w)\"", file: file, line: line)
        }
    }

    func testTheHeadingsNameThePlayer() {
        XCTAssertEqual(AssistRules.watchedHeading("Alice"), "Alice's advice")
        XCTAssertEqual(TutorialRules.watchedHeading("Alice"), "Alice's tip")
        XCTAssertEqual(AssistRules.watchedHeading("  Alice \n"), "Alice's advice", "trimmed")
        XCTAssertEqual(AssistRules.watchedHeading("Chris"), "Chris's advice")
        XCTAssertEqual(AssistRules.watchedSuffix, "'s advice")
        XCTAssertEqual(TutorialRules.watchedSuffix, "'s tip")
        // a blank name: no heading (the card still shows no count)
        for blank in [nil, "", "   "] as [String?] {
            XCTAssertNil(AssistRules.watchedHeading(blank), String(describing: blank))
            XCTAssertNil(TutorialRules.watchedHeading(blank), String(describing: blank))
            XCTAssertNil(AssistRules.watchedHeadingName(blank), String(describing: blank))
        }
        // names only: never a seat or team number
        for heading in [AssistRules.watchedHeading("Alice"), TutorialRules.watchedHeading("Alice")] {
            XCTAssertNil(heading?.rangeOfCharacter(from: .decimalDigits), heading ?? "-")
            XCTAssertFalse(heading?.contains("Team") ?? true)
        }
    }

    func testTheFooterNeverShowsTheWatchedPlayersCounts() {
        // every count state my own card words differently
        var cases: [(String, AssistHint)] = []
        for uses in 0...6 {
            for counted in [true, false] {
                cases.append(("uses \(uses) counted \(counted)", advice(uses: uses, counted: counted, assisted: uses > 3)))
            }
        }
        cases.append(("unlimited", advice(uses: 9, unlimited: true)))
        cases.append(("tutorial advice", advice(counted: false, source: "tutorial")))
        cases.append(("card", advice(.card, uses: 4, assisted: true)))
        for (tag, h) in cases {
            XCTAssertEqual(AssistRules.watchedFooter(h), AssistRules.footerBot, tag)
            assertNoCounts(AssistRules.watchedFooter(h), tag)
        }
        // my own card would have said a count for these (the case the watched card must not copy)
        XCTAssertEqual(AssistRules.footer(advice(uses: 4, assisted: true)),
                       "What our strongest bot would play \u{00B7} Help 4: this game counts as bot-assisted for you")
        // a forced move: never "Not counted"
        let only = advice(confidence: "only")
        XCTAssertEqual(AssistRules.footer(only), "Not counted")
        XCTAssertEqual(AssistRules.watchedFooter(only), AssistRules.footerBot)
        // a quick suggestion: the Quick note alone, counted or not
        for counted in [true, false] {
            let quick = advice(uses: 4, counted: counted, assisted: true, confidence: "quick")
            XCTAssertEqual(AssistRules.watchedFooter(quick), AssistRules.footerQuick)
            assertNoCounts(AssistRules.watchedFooter(quick), "quick")
        }
        // the server mirrors no status reply and no tip as advice: no footer
        XCTAssertNil(AssistRules.watchedFooter(advice(.status)))
        XCTAssertNil(AssistRules.watchedFooter(advice(.tip, confidence: nil)))
    }

    func testVoiceOverNamesThePlayer() {
        XCTAssertEqual(AssistRules.watchedLabel("Alice"), "Suggestion for Alice")
        XCTAssertEqual(AssistRules.watchedLabel(" "), "Suggestion")
        XCTAssertEqual(TutorialRules.watchedLabel("Alice"), "Tip for Alice")
        XCTAssertEqual(TutorialRules.watchedLabel(nil), "Tip")
        // the advice: the label, the headline and the main reason; never the note
        let h = advice(uses: 4, assisted: true, note: "This game now counts as bot-assisted for you.")
        XCTAssertEqual(AssistRules.announcement(h),
                       "Suggestion: Bid 2. Alice's partner bid 1. This game now counts as bot-assisted for you.")
        XCTAssertEqual(AssistRules.watchedAnnouncement(h, name: "Alice"), "Suggestion for Alice: Bid 2. Alice's partner bid 1.")
        assertNoCounts(AssistRules.watchedAnnouncement(h, name: "Alice"), "announcement")
        XCTAssertEqual(AssistRules.watchedAnnouncement(h, name: nil), "Suggestion: Bid 2. Alice's partner bid 1.")
        // the tip
        var tip = AssistHint(kind: .tip, headline: "Trump")
        tip.source = "tutorial"
        tip.tipId = "T.trump"
        tip.reasons = ["Trump this hand is hearts \u{2665}."]
        XCTAssertEqual(TutorialRules.watchedAnnouncement(tip, name: "Alice"), "Tip for Alice: Trump. Trump this hand is hearts \u{2665}.")
        XCTAssertEqual(TutorialRules.watchedAnnouncement(tip, name: ""), "Tip: Trump. Trump this hand is hearts \u{2665}.")
    }

    /// My own card's words are unchanged by the watched words (nil = today's card).
    func testMyOwnCardsWordsAreUnchanged() {
        XCTAssertEqual(AssistRules.footer(advice(uses: 2)), "What our strongest bot would play \u{00B7} Help 2 of 3 free")
        XCTAssertEqual(AssistRules.announcement(advice()), "Suggestion: Bid 2. Alice's partner bid 1.")
        var tip = AssistHint(kind: .tip, headline: "Trump")
        tip.reasons = ["Text."]
        XCTAssertEqual(TutorialRules.announcement(tip), "Tip: Trump. Text.")
    }
}
