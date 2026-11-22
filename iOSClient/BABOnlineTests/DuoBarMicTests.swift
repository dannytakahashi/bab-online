import XCTest
import SwiftUI
@testable import BAB_Online

/// The mic in the iPhone Duo's vertical bar (owner 2026-11-22): where the game screen draws my
/// mic (MicSpot) and the bar glyph's state (VoiceBarButton). The bar itself (its overflow menu,
/// the long press's menu, the tint) is the system's: DuoBarMicUITests on the Duo simulator.
final class DuoBarMicTests: XCTestCase {
    func testTheMicGoesInTheBarOnlyWhileTheBarShowsTheTablesControls() {
        // a seat
        XCTAssertEqual(MicSpot.of(barControls: true, seatVoice: true, pureSpectator: false, spectatorVoice: false, watching: false), .bar)
        XCTAssertEqual(MicSpot.of(barControls: false, seatVoice: true, pureSpectator: false, spectatorVoice: false, watching: false), .seatRow)
        // a plain spectator: the pill's mic
        XCTAssertEqual(MicSpot.of(barControls: true, seatVoice: false, pureSpectator: true, spectatorVoice: true, watching: false), .bar)
        XCTAssertEqual(MicSpot.of(barControls: false, seatVoice: false, pureSpectator: true, spectatorVoice: true, watching: false), .pill)
        // a watcher: the mic above the eye
        XCTAssertEqual(MicSpot.of(barControls: true, seatVoice: false, pureSpectator: true, spectatorVoice: true, watching: true), .bar)
        XCTAssertEqual(MicSpot.of(barControls: false, seatVoice: false, pureSpectator: true, spectatorVoice: true, watching: true), .eye)
    }

    func testNoMicWithoutVoice() {
        for bar in [false, true] {
            XCTAssertEqual(MicSpot.of(barControls: bar, seatVoice: false, pureSpectator: false, spectatorVoice: false, watching: false), .none)
            // voice full / a tournament table: a spectator without spectator voice
            XCTAssertEqual(MicSpot.of(barControls: bar, seatVoice: false, pureSpectator: true, spectatorVoice: false, watching: false), .none)
            XCTAssertEqual(MicSpot.of(barControls: bar, seatVoice: false, pureSpectator: true, spectatorVoice: false, watching: true), .none)
        }
    }

    /// The bar draws the item's symbol itself: the state is the symbol and its tint (muted red,
    /// talking green); listen-only and muted stay apart from talking.
    func testTheBarGlyphShowsMutedListenOnlyAndTalking() {
        XCTAssertEqual(VoiceBarButton.symbol(listenOnly: false, muted: true), "mic.slash.fill")
        XCTAssertEqual(VoiceBarButton.symbol(listenOnly: false, muted: false), "mic.fill")
        XCTAssertEqual(VoiceBarButton.symbol(listenOnly: true, muted: true), "headphones")
        XCTAssertEqual(VoiceBarButton.symbol(listenOnly: true, muted: false), "headphones")

        XCTAssertEqual(VoiceBarButton.tint(listenOnly: false, muted: true, speaking: false), Theme.danger)
        // a muted mic never shows talking (the level meter may still hear the room)
        XCTAssertEqual(VoiceBarButton.tint(listenOnly: false, muted: true, speaking: true), Theme.danger)
        XCTAssertNil(VoiceBarButton.tint(listenOnly: false, muted: false, speaking: false))
        XCTAssertEqual(VoiceBarButton.tint(listenOnly: false, muted: false, speaking: true), Theme.success)
        XCTAssertNil(VoiceBarButton.tint(listenOnly: true, muted: false, speaking: true))
        XCTAssertNil(VoiceBarButton.tint(listenOnly: true, muted: true, speaking: false))
    }
}
