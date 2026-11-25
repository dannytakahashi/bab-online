import AudioToolbox
import XCTest
@testable import BAB_Online

/// Table sounds during voice (owner 2026-11-24, iOS 1.2.6: "when talking the card sounds are
/// very quiet / almost inaudible"; docs/claude/voice.md "iOS sounds and voice"): WebRTC's
/// VoiceProcessingIO unit ducks every other sound of the app unless its
/// `kAUVoiceIOProperty_OtherAudioDuckingConfiguration` says otherwise, and WebRTC never sets
/// it, so `VoiceDucking` points the framework's AudioUnitInitialize / AudioOutputUnitStart at
/// hooks that set the least ducking on a VoiceProcessingIO unit. What a test can show: the
/// framework's symbol pointers hold the hooks, and the setting itself takes on a real
/// VoiceProcessingIO unit (read back). What it cannot: how loud a sound is under a running
/// unit (the simulator plays through the Mac, with no way to record the output here).
final class VoiceDuckingTests: XCTestCase {

    func testTheHooksReplaceWebRTCsAudioUnitCalls() throws {
        XCTAssertTrue(VoiceDucking.install(), "both symbols found in the WebRTC framework")
        XCTAssertTrue(VoiceDucking.install(), "idempotent")
        let counts = VoiceDucking.reboundCounts
        XCTAssertGreaterThan(counts["_AudioUnitInitialize"] ?? 0, 0, "\(counts)")
        XCTAssertGreaterThan(counts["_AudioOutputUnitStart"] ?? 0, 0, "\(counts)")
        for (symbol, hook) in VoiceDucking.hookAddresses {
            let slots = VoiceDucking.slots(in: VoiceDucking.imageSuffix, symbol)
            XCTAssertFalse(slots.isEmpty, symbol)
            for slot in slots { XCTAssertEqual(slot, hook, "\(symbol): WebRTC calls the hook") }
        }
    }

    func testOnlyWebRTCsImageIsTouched() {
        _ = VoiceDucking.install()
        // the app's (and this bundle's) own AudioToolbox calls are the real ones: the hooks
        // call AudioUnitInitialize / AudioOutputUnitStart through them
        XCTAssertTrue(VoiceDucking.slots(in: "/BAB Online.app/BAB Online", "_AudioUnitInitialize")
            .allSatisfy { $0 != VoiceDucking.hookAddresses["_AudioUnitInitialize"] })
        XCTAssertEqual(VoiceDucking.rebind(in: "/no/such/image", VoiceDucking.hookAddresses),
                       ["_AudioUnitInitialize": 0, "_AudioOutputUnitStart": 0], "an image that is not there: nothing")
    }

    private func unit(_ subType: OSType) throws -> AudioUnit {
        var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: subType,
                                             componentManufacturer: kAudioUnitManufacturer_Apple,
                                             componentFlags: 0, componentFlagsMask: 0)
        let component = try XCTUnwrap(AudioComponentFindNext(nil, &desc))
        var unit: AudioUnit?
        XCTAssertEqual(AudioComponentInstanceNew(component, &unit), noErr)
        return try XCTUnwrap(unit)
    }

    /// The setting on a real VoiceProcessingIO unit (made, never initialized: no audio I/O),
    /// read back: the least ducking, advanced ducking off. Before it, iOS's default.
    func testAVoiceProcessingUnitGetsTheLeastDucking() throws {
        let vpio = try unit(kAudioUnitSubType_VoiceProcessingIO)
        defer { AudioComponentInstanceDispose(vpio) }
        XCTAssertTrue(VoiceDucking.isVoiceProcessing(vpio))
        let before = VoiceDucking.current(vpio)
        print("[VoiceDucking] default: advanced=\(before.map { $0.mEnableAdvancedDucking.boolValue ? 1 : 0 } ?? -1) level=\(before?.mDuckingLevel.rawValue ?? 999)")
        let configured = VoiceDucking.configuredUnits
        XCTAssertEqual(VoiceDucking.configure(vpio), noErr)
        XCTAssertEqual(VoiceDucking.configuredUnits, configured + 1)
        let after = try XCTUnwrap(VoiceDucking.current(vpio))
        XCTAssertFalse(after.mEnableAdvancedDucking.boolValue, "advanced ducking off (it ducks harder while anyone talks)")
        XCTAssertEqual(after.mDuckingLevel, .min, "the least ducking iOS offers")
        print("[VoiceDucking] set: advanced=\(after.mEnableAdvancedDucking.boolValue) level=\(after.mDuckingLevel.rawValue)")
    }

    func testAnyOtherUnitIsLeftAlone() throws {
        let remote = try unit(kAudioUnitSubType_RemoteIO)
        defer { AudioComponentInstanceDispose(remote) }
        XCTAssertFalse(VoiceDucking.isVoiceProcessing(remote))
        XCTAssertNil(VoiceDucking.configure(remote), "not a voice unit: nothing set")
    }
}
