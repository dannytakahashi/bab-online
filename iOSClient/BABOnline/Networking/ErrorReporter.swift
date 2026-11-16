import Foundation

/// Client error reports: c2s `clientError {kind, message, stack?, where?, build?, page?}`
/// (contract/src/c2s.js; server/socket/clientErrorHandlers.js). New in the build after
/// 1.2.1 build 9; 1.2.0 through build 9 never send it.
///
/// An App Store build has no console anyone reads, so a table event this build cannot decode,
/// an unreadable table, a seq gap, an unexpected socket error or an uncaught exception used to
/// vanish. Each goes out once per kind per launch (the first one is the one worth having; the
/// server also caps a socket at 5 a minute), at most `maxKinds` kinds; only while connected,
/// with up to `maxBuffer` waiting for the next connect (`connected()` holds every report until
/// `flush`, called after the restore, so none goes out before the server knows the user).
/// Messages are what TableLog already logs (event names, coding paths, enum values: never a
/// payload value, a name or chat), cut to the server's limits. No crash reporter SDK: an
/// uncaught Objective-C exception is saved (UserDefaults, the app's own domain: CA92.1) and
/// sent after the next launch's connect (kept until it is sent); a Swift trap cannot be caught
/// and is not reported.
final class ErrorReporter {
    static let shared = ErrorReporter()

    static let maxBuffer = 5
    static let maxKinds = 20
    /// Seconds after a connect before the buffer goes out: the restore lands first, so the
    /// server can name the signed-in user.
    static let flushDelay: TimeInterval = 1.5
    static let pendingCrashKey = "bab.pendingCrashReport"
    static let limits = (message: 300, stack: 2000, location: 200, build: 64, page: 32)
    private static let stackLines = 12

    struct Report: Equatable {
        let kind: String
        let message: String
        var stack: String?
        var location: String?
        var build: String?
        var page: String?

        var payload: [String: Any] {
            var p: [String: Any] = ["kind": kind, "message": message]
            if let stack, !stack.isEmpty { p["stack"] = stack }
            if let location, !location.isEmpty { p["where"] = location }
            if let build, !build.isEmpty { p["build"] = build }
            if let page, !page.isEmpty { p["page"] = page }
            return p
        }
    }

    /// Emits one payload; false when it could not (not connected). Set by SocketService.
    var sender: (([String: Any]) -> Bool)?
    /// The screen now (set by BABOnlineApp); read on the main thread only.
    var page: (() -> String?)?
    private let build: String
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var seen = Set<String>()
    private var buffer: [Report] = []
    private var sending = false
    /// Between a connect and its `flush`: reports wait, so the restore lands first.
    private var flushPending = false
    /// The message of the last launch's saved exception, forgotten (defaults) only once sent.
    private var pendingCrashMessage: String?
    private(set) var deduped = 0
    private(set) var dropped = 0

    init(build: String = AppInfo.build, defaults: UserDefaults = .standard) {
        self.build = build
        self.defaults = defaults
    }

    var pending: Int { lock.lock(); defer { lock.unlock() }; return buffer.count }

    /// The report the server accepts, or nil for a kind it would refuse.
    static func makeReport(kind: String, message: String, location: String? = nil, stack: String? = nil,
                           build: String? = nil, page: String? = nil) -> Report? {
        guard kind.range(of: "^[A-Za-z][A-Za-z0-9_.-]{0,31}$", options: .regularExpression) != nil else { return nil }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let stackText = stack.map { $0.split(separator: "\n", omittingEmptySubsequences: false).prefix(stackLines).joined(separator: "\n") }
        let pageText = page.map { String($0.unicodeScalars.filter { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-").contains($0) }) }
        return Report(kind: kind,
                      message: cut(text.isEmpty ? "(no message)" : text, limits.message),
                      stack: stackText.map { cut($0, limits.stack) },
                      location: location.map { cut($0, limits.location) },
                      build: build.map { cut($0, limits.build) },
                      page: pageText.map { String($0.prefix(limits.page)) })
    }

    /// Cut to `n` UTF-16 units (what Joi's max counts), with an ellipsis.
    static func cut(_ s: String, _ n: Int) -> String {
        guard s.utf16.count > n else { return s }
        var out = ""
        for ch in s {
            if out.utf16.count + ch.utf16.count > n - 1 { break }
            out.append(ch)
        }
        return out + "…"
    }

    /// Report `kind` once per launch. Never throws; safe from any thread.
    @discardableResult
    func report(kind: String, message: String, location: String? = nil, stack: String? = nil) -> Bool {
        let currentPage = Thread.isMainThread ? page?() : nil
        guard let r = Self.makeReport(kind: kind, message: message, location: location, stack: stack, build: build, page: currentPage) else { return false }
        lock.lock()
        if sending { lock.unlock(); return false }  // an error while sending one: never loop
        if seen.contains(kind) { deduped += 1; lock.unlock(); return false }
        if seen.count >= Self.maxKinds { lock.unlock(); return false }
        seen.insert(kind)  // now, so a second thread's same kind is a duplicate; undone on a drop
        let direct = buffer.isEmpty && !flushPending
        lock.unlock()
        if direct, send(r) { return true }
        lock.lock(); defer { lock.unlock() }
        guard buffer.count < Self.maxBuffer else {
            dropped += 1
            seen.remove(kind)  // never sent: its next one may still go
            return false
        }
        buffer.append(r)
        return true
    }

    /// The socket connected (SocketService, before it schedules `flush`): reports wait for it.
    func connected() {
        lock.lock(); flushPending = true; lock.unlock()
    }

    /// Send what waited, in order, while the sender takes it (SocketService, after a connect).
    func flush() {
        lock.lock(); flushPending = false; lock.unlock()
        while true {
            lock.lock()
            guard let next = buffer.first else { lock.unlock(); return }
            lock.unlock()
            guard send(next) else { return }
            lock.lock()
            if buffer.first == next { buffer.removeFirst() }
            lock.unlock()
        }
    }

    private func send(_ r: Report) -> Bool {
        guard let sender else { return false }
        lock.lock(); sending = true; lock.unlock()
        defer { lock.lock(); sending = false; lock.unlock() }
        let ok = sender(r.payload)
        if ok {
            lock.lock()
            let wasCrash = r.kind == "exception" && r.message == pendingCrashMessage
            if wasCrash { pendingCrashMessage = nil }
            lock.unlock()
            if wasCrash { defaults.removeObject(forKey: Self.pendingCrashKey) }
        }
        return ok
    }

    // MARK: - Socket errors

    /// A transport error that is just the network (offline, timed out, a deploy's close):
    /// not reported. Anything else Socket.IO-Client-Swift hands `.error` is.
    static func isExpectedSocketError(_ message: String) -> Bool {
        let m = message.lowercased()
        return ["offline", "timed out", "timeout", "could not connect", "network connection was lost",
                "not connected", "connection reset", "connection refused", "socket is not connected",
                "connection abort", "broken pipe", "cancelled", "canceled", "-1001", "-1004", "-1005", "-1009",
                // DNS and TLS on a flaky or captive network
                "could not be found", "-1003", "ssl error", "secure connection", "-1200",
                "tried emitting when not connected", "session id unknown"].contains { m.contains($0) }
    }

    // MARK: - Uncaught exceptions

    private static var previousHandler: (@convention(c) (NSException) -> Void)?
    private static var handlerInstalled = false

    /// Saves an uncaught exception for the next launch (the process ends before a socket could
    /// send it), then calls any handler that was installed before. Once: a second install would
    /// take our own handler as the previous one and recurse while crashing.
    static func installExceptionHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        previousHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            ErrorReporter.shared.savePendingCrash(name: exception.name.rawValue, reason: exception.reason,
                                                  stack: exception.callStackSymbols.joined(separator: "\n"))
            ErrorReporter.previousHandler?(exception)
        }
    }

    func savePendingCrash(name: String, reason: String?, stack: String) {
        let r = Self.makeReport(kind: "exception", message: [name, reason].compactMap { $0 }.joined(separator: ": "),
                                stack: stack, build: build)
        defaults.set(r?.payload, forKey: Self.pendingCrashKey)
        // the process aborts next: write it now, not on the defaults' own schedule
        defaults.synchronize()
    }

    /// The last launch's saved exception, reported once; forgotten when it is sent (`send`),
    /// so a launch that ends before it could go sends it the time after.
    func reportPendingCrash() {
        guard let saved = defaults.dictionary(forKey: Self.pendingCrashKey) else { return }
        guard let message = saved["message"] as? String else {
            defaults.removeObject(forKey: Self.pendingCrashKey)
            return
        }
        let text = "previous launch: \(message)"
        lock.lock()
        pendingCrashMessage = Self.makeReport(kind: "exception", message: text)?.message  // as cut
        lock.unlock()
        if !report(kind: "exception", message: text, stack: saved["stack"] as? String) {
            lock.lock(); pendingCrashMessage = nil; lock.unlock()
        }
    }
}
