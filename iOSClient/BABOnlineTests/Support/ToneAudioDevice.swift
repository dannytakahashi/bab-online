import AudioToolbox
import Foundation
@preconcurrency import WebRTC

/// A `SilentAudioDevice` whose samples flow, still without opening any audio (no audio unit,
/// no AVAudioSession): while recording it feeds WebRTC a 440 Hz tone, and while playing it pulls
/// WebRTC's mixed playout every 10 ms and keeps its level, so a test hears what a call plays
/// (`VoiceVolumeSilenceTests`: what a player's volume at 0% plays).
final class ToneAudioDevice: SilentAudioDevice, @unchecked Sendable {
    static let frames = 480  // 10 ms at 48 kHz, mono
    private let levelLock = NSLock()
    private var delegate: RTCAudioDeviceDelegate?
    private var recorder: Thread?
    private var player: Thread?
    private var levels: [Double] = []

    /// The loudest 10 ms of playout (RMS, full scale 1) since the last `resetLevel`.
    var peakLevel: Double {
        levelLock.lock()
        defer { levelLock.unlock() }
        return levels.max() ?? 0
    }

    /// How many 10 ms pulls since the last `resetLevel`.
    var pulls: Int {
        levelLock.lock()
        defer { levelLock.unlock() }
        return levels.count
    }

    func resetLevel() {
        levelLock.lock()
        levels = []
        levelLock.unlock()
    }

    override func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        levelLock.lock()
        self.delegate = delegate
        levelLock.unlock()
        return super.initialize(with: delegate)
    }

    override func terminateDevice() -> Bool {
        stopThreads()
        return super.terminateDevice()
    }

    override func startRecording() -> Bool {
        guard super.startRecording() else { return false }
        recorder?.cancel()
        let thread = Thread { [weak self] in self?.record() }
        thread.name = "ToneAudioDevice.record"
        recorder = thread
        thread.start()
        return true
    }

    override func stopRecording() -> Bool {
        recorder?.cancel()
        recorder = nil
        return super.stopRecording()
    }

    override func startPlayout() -> Bool {
        guard super.startPlayout() else { return false }
        player?.cancel()
        let thread = Thread { [weak self] in self?.play() }
        thread.name = "ToneAudioDevice.play"
        player = thread
        thread.start()
        return true
    }

    override func stopPlayout() -> Bool {
        player?.cancel()
        player = nil
        return super.stopPlayout()
    }

    private func stopThreads() {
        recorder?.cancel()
        player?.cancel()
        recorder = nil
        player = nil
    }

    private var currentDelegate: RTCAudioDeviceDelegate? {
        levelLock.lock()
        defer { levelLock.unlock() }
        return delegate
    }

    /// The tone, 10 ms at a time, on this one thread (WebRTC expects one recording thread).
    private func record() {
        var samples = [Int16](repeating: 0, count: Self.frames)
        var phase = 0.0
        var sampleTime = 0.0
        let step = 2 * Double.pi * 440 / 48_000
        while !Thread.current.isCancelled {
            for i in 0..<Self.frames {
                samples[i] = Int16(0.3 * 32_767 * sin(phase))
                phase += step
            }
            if let delegate = currentDelegate {
                var flags = AudioUnitRenderActionFlags()
                var stamp = AudioTimeStamp()
                stamp.mSampleTime = sampleTime
                stamp.mFlags = .sampleTimeValid
                samples.withUnsafeMutableBytes { raw in
                    var list = AudioBufferList(mNumberBuffers: 1,
                                               mBuffers: AudioBuffer(mNumberChannels: 1,
                                                                     mDataByteSize: UInt32(raw.count),
                                                                     mData: raw.baseAddress))
                    _ = delegate.deliverRecordedData(&flags, &stamp, 1, UInt32(Self.frames), &list, nil, nil)
                }
            }
            sampleTime += Double(Self.frames)
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    /// WebRTC's playout, 10 ms at a time; each pull's RMS is kept.
    private func play() {
        var samples = [Int16](repeating: 0, count: Self.frames)
        var sampleTime = 0.0
        while !Thread.current.isCancelled {
            if let delegate = currentDelegate {
                var flags = AudioUnitRenderActionFlags()
                var stamp = AudioTimeStamp()
                stamp.mSampleTime = sampleTime
                stamp.mFlags = .sampleTimeValid
                let rms: Double = samples.withUnsafeMutableBytes { raw in
                    var list = AudioBufferList(mNumberBuffers: 1,
                                               mBuffers: AudioBuffer(mNumberChannels: 1,
                                                                     mDataByteSize: UInt32(raw.count),
                                                                     mData: raw.baseAddress))
                    _ = delegate.getPlayoutData(&flags, &stamp, 0, UInt32(Self.frames), &list)
                    let ints = raw.bindMemory(to: Int16.self)
                    let sum = ints.reduce(0.0) { $0 + Double($1) * Double($1) }
                    return (sum / Double(ints.count)).squareRoot() / 32_768
                }
                levelLock.lock()
                levels.append(rms)
                levelLock.unlock()
            }
            sampleTime += Double(Self.frames)
            Thread.sleep(forTimeInterval: 0.01)
        }
    }
}
