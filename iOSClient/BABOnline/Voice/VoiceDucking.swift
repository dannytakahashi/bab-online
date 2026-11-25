import AudioToolbox
import Foundation
import MachO

/// Table sounds stay audible during voice (owner 2026-11-24, iOS 1.2.6: "when talking the card
/// sounds are very quiet / almost inaudible"). docs/claude/voice.md "iOS sounds and voice".
///
/// WebRTC plays and records a call through Apple's VoiceProcessingIO audio unit, which ducks
/// "other audio" (everything not played through that unit: the app's own AVAudioPlayers, so
/// every card, trick and turn sound and the bid tune) for as long as it runs, at
/// `kAUVoiceIOOtherAudioDuckingLevelDefault` unless told otherwise (AudioUnitProperties.h,
/// `kAUVoiceIOProperty_OtherAudioDuckingConfiguration`, iOS 17). WebRTC 140 (stasel/WebRTC,
/// the prebuilt framework) never sets that property and gives the app no handle on its unit:
/// the unit is made and initialized inside the framework's C++ audio device module
/// (`VoiceProcessingAudioUnit`), and `RTCAudioDevice` would mean replacing that whole module.
///
/// So the framework's own two calls into AudioToolbox, `AudioUnitInitialize` and
/// `AudioOutputUnitStart`, are pointed at this file (their symbol pointers in the WebRTC
/// image only; the fishhook technique, public dyld APIs, no private API): each forwards to
/// AudioToolbox unchanged and, for a VoiceProcessingIO unit only, sets the ducking to the
/// lowest level with advanced ducking off (`configure`) before the unit runs. Echo
/// cancellation, AGC, the route and the session are untouched; no other unit and no other
/// library is affected. If the symbols cannot be found (another WebRTC build), nothing is
/// rebound and voice works as before, ducked (`install` returns false; logged once).
enum VoiceDucking {
    /// The level the app asks for: the least ducking iOS offers.
    static let level = AUVoiceIOOtherAudioDuckingLevel.min
    /// Off, as iOS's own default (AudioUnitProperties.h: unset, advanced ducking is off at
    /// the Default level): advanced ducking ducks other audio by voice activity, more while
    /// anyone talks. The owner's "almost inaudible" was the Default level, advanced off.
    static let advanced = false

    /// The WebRTC framework's image (the app's Frameworks folder; the tests' host app's too).
    static let imageSuffix = "/WebRTC.framework/WebRTC"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed: Bool?
    nonisolated(unsafe) private static var rebound: [String: Int] = [:]
    nonisolated(unsafe) private static var configured = 0

    /// Points the WebRTC framework's AudioUnitInitialize / AudioOutputUnitStart at the hooks.
    /// Idempotent; true once both are rebound. Called before the app's factory makes
    /// WebRTC's audio device module (`VoiceChatManager.makeFactory`).
    @discardableResult
    static func install() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let installed { return installed }
        let counts = rebind(in: imageSuffix, hookAddresses)
        rebound = counts
        let ok = (counts["_AudioUnitInitialize"] ?? 0) > 0 && (counts["_AudioOutputUnitStart"] ?? 0) > 0
        installed = ok
        // NSLog, not print: in the unified log, where a live run (or a device's Console) sees it
        NSLog("%@", ok ? "[Voice] ducking hook installed \(counts)" : "[Voice] ducking hook not installed \(counts): table sounds duck during voice")
        return ok
    }

    /// For tests: symbol pointers rebound per symbol (0: not found).
    static var reboundCounts: [String: Int] { lock.lock(); defer { lock.unlock() }; return rebound }
    /// For tests and the log: VoiceProcessingIO units configured so far.
    static var configuredUnits: Int { lock.lock(); defer { lock.unlock() }; return configured }

    /// Sets the ducking on `unit` if it is a VoiceProcessingIO unit (any other unit: nothing,
    /// `nil`). The OSStatus of the set otherwise.
    @discardableResult
    static func configure(_ unit: AudioUnit) -> OSStatus? {
        guard isVoiceProcessing(unit) else { return nil }
        var config = AUVoiceIOOtherAudioDuckingConfiguration(mEnableAdvancedDucking: DarwinBoolean(advanced), mDuckingLevel: level)
        let status = AudioUnitSetProperty(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0,
                                          &config, UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size))
        lock.lock()
        if status == noErr { configured += 1 }
        let n = configured
        lock.unlock()
        // rare (each initialize and start of WebRTC's unit): logged every time
        NSLog("%@", status == noErr ? "[Voice] ducking set on VoiceProcessingIO: level min, advanced off (\(n))"
                                    : "[Voice] ducking not set: OSStatus \(status)")
        return status
    }

    /// The unit's ducking as it reads back (tests, the log).
    static func current(_ unit: AudioUnit) -> AUVoiceIOOtherAudioDuckingConfiguration? {
        var config = AUVoiceIOOtherAudioDuckingConfiguration()
        var size = UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size)
        let status = AudioUnitGetProperty(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0, &config, &size)
        return status == noErr ? config : nil
    }

    static func isVoiceProcessing(_ unit: AudioUnit) -> Bool {
        let component = AudioComponentInstanceGetComponent(unit)
        var desc = AudioComponentDescription()
        guard AudioComponentGetDescription(component, &desc) == noErr else { return false }
        return desc.componentType == kAudioUnitType_Output && desc.componentSubType == kAudioUnitSubType_VoiceProcessingIO
    }

    // MARK: - The hooks (C functions: no captures; this image's own AudioToolbox bindings)

    private typealias UnitCall = @convention(c) (AudioUnit) -> OSStatus

    /// WebRTC's AudioUnitInitialize: the real one, then the ducking (a property of an
    /// initialized unit, kept until it is uninitialized; WebRTC initializes again after a
    /// route or sample-rate change, and each time comes through here).
    private static let hookedInitialize: UnitCall = { unit in
        let status = AudioUnitInitialize(unit)
        if status == noErr { VoiceDucking.configure(unit) }
        return status
    }

    /// WebRTC's AudioOutputUnitStart: the ducking again (harmless when already set), then the
    /// real one, so a unit never runs with the default ducking.
    private static let hookedStart: UnitCall = { unit in
        VoiceDucking.configure(unit)
        return AudioOutputUnitStart(unit)
    }

    // MARK: - Symbol rebinding (one image)

    /// Replaces the symbol pointers (lazy and non-lazy) that the image whose path ends with
    /// `suffix` uses for `symbols` (Mach-O names, leading underscore) with the given
    /// addresses. Returns how many pointers were replaced per symbol.
    static func rebind(in suffix: String, _ symbols: [String: UnsafeMutableRawPointer]) -> [String: Int] {
        var counts = Dictionary(uniqueKeysWithValues: symbols.keys.map { ($0, 0) })
        forEachSlot(in: suffix, Set(symbols.keys)) { symbol, slot in
            if let replacement = symbols[symbol], write(replacement, to: slot) { counts[symbol, default: 0] += 1 }
        }
        return counts
    }

    /// For tests: what the image's symbol pointers for `symbol` hold now.
    static func slots(in suffix: String, _ symbol: String) -> [UnsafeMutableRawPointer?] {
        var found: [UnsafeMutableRawPointer?] = []
        forEachSlot(in: suffix, [symbol]) { _, slot in found.append(slot.pointee) }
        return found
    }

    /// For tests: the hooks' addresses (what the slots hold once installed).
    static var hookAddresses: [String: UnsafeMutableRawPointer] {
        ["_AudioUnitInitialize": unsafeBitCast(hookedInitialize, to: UnsafeMutableRawPointer.self),
         "_AudioOutputUnitStart": unsafeBitCast(hookedStart, to: UnsafeMutableRawPointer.self)]
    }

    private static func forEachSlot(in suffix: String, _ symbols: Set<String>,
                                    _ body: (String, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Void) {
        for i in 0..<_dyld_image_count() {
            guard let cName = _dyld_get_image_name(i), String(cString: cName).hasSuffix(suffix),
                  let header = _dyld_get_image_header(i) else { continue }
            forEachSlot(header, slide: _dyld_get_image_vmaddr_slide(i), symbols, body)
        }
    }

    private static func name<T>(_ tuple: T) -> String {
        withUnsafeBytes(of: tuple) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// Walks the image's load commands: __LINKEDIT, the symbol and indirect symbol tables, and
    /// the symbol pointer sections of __DATA / __DATA_CONST; calls `body` for each pointer
    /// whose symbol is in `symbols`.
    private static func forEachSlot(_ header: UnsafePointer<mach_header>, slide: Int, _ symbols: Set<String>,
                                    _ body: (String, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Void) {
        guard header.pointee.magic == MH_MAGIC_64 else { return }
        let base = UnsafeRawPointer(header)
        var linkedit: segment_command_64?
        var symtab: symtab_command?
        var dysymtab: dysymtab_command?
        var pointerSections: [section_64] = []

        var cursor = base + MemoryLayout<mach_header_64>.size
        for _ in 0..<header.pointee.ncmds {
            let cmd = cursor.load(as: load_command.self)
            switch cmd.cmd {
            case UInt32(LC_SEGMENT_64):
                let segment = cursor.load(as: segment_command_64.self)
                let segName = name(segment.segname)
                if segName == SEG_LINKEDIT { linkedit = segment }
                if segName == SEG_DATA || segName == "__DATA_CONST" {
                    var sectionCursor = cursor + MemoryLayout<segment_command_64>.size
                    for _ in 0..<segment.nsects {
                        let section = sectionCursor.load(as: section_64.self)
                        let type = Int32(section.flags) & SECTION_TYPE
                        if type == S_LAZY_SYMBOL_POINTERS || type == S_NON_LAZY_SYMBOL_POINTERS {
                            pointerSections.append(section)
                        }
                        sectionCursor += MemoryLayout<section_64>.size
                    }
                }
            case UInt32(LC_SYMTAB):
                symtab = cursor.load(as: symtab_command.self)
            case UInt32(LC_DYSYMTAB):
                dysymtab = cursor.load(as: dysymtab_command.self)
            default:
                break
            }
            cursor += Int(cmd.cmdsize)
        }
        guard let linkedit, let symtab, let dysymtab, dysymtab.nindirectsyms > 0 else { return }

        let linkeditBase = UInt(bitPattern: slide) &+ UInt(linkedit.vmaddr) &- UInt(linkedit.fileoff)
        guard let symbolTable = UnsafePointer<nlist_64>(bitPattern: linkeditBase &+ UInt(symtab.symoff)),
              let stringTable = UnsafePointer<CChar>(bitPattern: linkeditBase &+ UInt(symtab.stroff)),
              let indirect = UnsafePointer<UInt32>(bitPattern: linkeditBase &+ UInt(dysymtab.indirectsymoff)) else { return }

        let pointerSize = MemoryLayout<UnsafeMutableRawPointer>.size
        for section in pointerSections {
            let count = Int(section.size) / pointerSize
            guard count > 0,
                  let slots = UnsafeMutablePointer<UnsafeMutableRawPointer?>(bitPattern: UInt(bitPattern: slide) &+ UInt(section.addr))
            else { continue }
            let firstIndex = Int(section.reserved1)
            for j in 0..<count where firstIndex + j < Int(dysymtab.nindirectsyms) {
                let symbolIndex = indirect[firstIndex + j]
                // INDIRECT_SYMBOL_ABS (0x40000000) / INDIRECT_SYMBOL_LOCAL (0x80000000): no symbol
                if symbolIndex & 0xC000_0000 != 0 { continue }
                guard symbolIndex < symtab.nsyms else { continue }
                let strx = symbolTable[Int(symbolIndex)].n_un.n_strx
                guard strx > 0, strx < symtab.strsize else { continue }
                let symbol = String(cString: stringTable + Int(strx))
                guard symbols.contains(symbol) else { continue }
                body(symbol, slots + j)
            }
        }
    }

    /// Writes one pointer, making its page writable first if it is read-only (__DATA_CONST
    /// after dyld), and read-only again after.
    private static func write(_ value: UnsafeMutableRawPointer, to slot: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Bool {
        let pageSize = UInt(getpagesize())
        let address = UInt(bitPattern: slot)
        let page = address & ~(pageSize - 1)
        // vm_region tells whether the page is writable already
        var regionAddress = vm_address_t(page)
        var regionSize = vm_size_t(0)
        var info = vm_region_basic_info_data_64_t()
        var infoCount = mach_msg_type_number_t(MemoryLayout<vm_region_basic_info_data_64_t>.size / MemoryLayout<integer_t>.size)
        var object: mach_port_t = 0
        let regionStatus = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(infoCount)) {
                vm_region_64(mach_task_self_, &regionAddress, &regionSize, VM_REGION_BASIC_INFO_64, $0, &infoCount, &object)
            }
        }
        let writable = regionStatus == KERN_SUCCESS && (info.protection & VM_PROT_WRITE) != 0
        if !writable {
            guard mprotect(UnsafeMutableRawPointer(bitPattern: page), Int(pageSize), PROT_READ | PROT_WRITE) == 0 else { return false }
        }
        slot.pointee = value
        if !writable, regionStatus == KERN_SUCCESS {
            _ = mprotect(UnsafeMutableRawPointer(bitPattern: page), Int(pageSize), info.protection)
        }
        return true
    }
}
