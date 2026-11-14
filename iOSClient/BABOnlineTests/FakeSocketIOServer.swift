import Foundation

/// A minimal Socket.IO 4 server (Engine.IO 4 over HTTP long-polling, no websocket
/// upgrade offered) on a local port, for driving a real `SocketManager` in unit tests
/// (ForegroundKeepTests). It speaks just enough of the protocol: the handshake, the default
/// namespace connect, and `requestSnapshot` answered with `stateSnapshot` (`not_in_game`,
/// the requestId echoed) as server/socket/snapshotHandlers.js does. Plain POSIX sockets
/// (one request per connection, `Connection: close`).
///
/// Faults it can inject: `answersSnapshots = false` (the server never answers: a stalled
/// or namespace-less connection), `restart()` (the process restarted: every held request
/// is dropped and old engine ids get Engine.IO's 400 "Session ID unknown").
final class FakeSocketIOServer {
    private let queue = DispatchQueue(label: "fake-socketio-server")
    private var listenFd: Int32 = -1
    private var engines: [String: Engine] = [:]
    private var _handshakes = 0
    private var _namespaceConnects = 0
    private var _events: [(engine: String, name: String, payload: [String: Any])] = []
    private var _answersSnapshots = true

    /// One accepted HTTP connection.
    private final class Conn {
        private var fd: Int32
        init(fd: Int32) { self.fd = fd }
        func close() {
            guard fd >= 0 else { return }
            Darwin.close(fd)
            fd = -1
        }
        func send(_ data: Data) {
            guard fd >= 0 else { return }
            data.withUnsafeBytes { raw in
                var off = 0
                while off < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress! + off, raw.count - off)
                    if n <= 0 { break }
                    off += n
                }
            }
            close()
        }
        /// Blocking: one whole request (headers + Content-Length body), or nil.
        func readRequest() -> Data? {
            var buf = Data()
            var chunk = [UInt8](repeating: 0, count: 65536)
            while true {
                if FakeSocketIOServer.isComplete(buf) { return buf }
                let n = Darwin.read(fd, &chunk, chunk.count)
                if n <= 0 { return nil }
                buf.append(chunk, count: n)
            }
        }
    }

    private final class Engine {
        let sid: String
        var namespaceSid: String?
        var outbox: [String] = []
        var heldPoll: Conn?
        init(sid: String) { self.sid = sid }
    }

    private(set) var port: UInt16 = 0
    var url: String { "http://127.0.0.1:\(port)" }

    /// Engine.IO handshakes so far: a new SocketManager connecting is one.
    var handshakes: Int { queue.sync { _handshakes } }
    var namespaceConnects: Int { queue.sync { _namespaceConnects } }
    /// Event names (and payloads) clients sent, in order.
    var events: [(name: String, payload: [String: Any])] { queue.sync { _events.map { ($0.name, $0.payload) } } }
    var answersSnapshots: Bool {
        get { queue.sync { _answersSnapshots } }
        set { queue.sync { _answersSnapshots = newValue } }
    }

    func start() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Self.error("socket") }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 128) == 0 else { Darwin.close(fd); throw Self.error("bind/listen") }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        port = UInt16(bigEndian: addr.sin_port)
        listenFd = fd
        let thread = Thread { [weak self] in self?.acceptLoop(fd) }
        thread.start()
    }

    func stop() {
        queue.sync {
            for e in engines.values { e.heldPoll?.close() }
            engines = [:]
        }
        stopped.lock(); isStopped = true; stopped.unlock()
        if listenFd >= 0 {
            Thread.sleep(forTimeInterval: 0.15)  // the accept loop sees the flag first
            Darwin.close(listenFd)
            listenFd = -1
        }
    }

    /// The server process restarted: every open request is dropped and no engine id it
    /// gave out is known any more (the port keeps listening, as a restarted server's would).
    func restart() {
        queue.sync {
            for e in engines.values { e.heldPoll?.close() }
            engines = [:]
        }
    }

    private static func error(_ what: String) -> NSError {
        NSError(domain: "FakeSocketIOServer", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(what) failed: \(errno)"])
    }

    // MARK: - HTTP

    private let stopped = NSLock()
    private var isStopped = false

    private func acceptLoop(_ fd: Int32) {
        while true {
            stopped.lock(); let done = isStopped; stopped.unlock()
            if done { return }
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&pfd, 1, 100) > 0, pfd.revents & Int16(POLLIN) != 0 else { continue }
            let client = accept(fd, nil, nil)
            if client < 0 { continue }
            var on: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            let conn = Conn(fd: client)
            DispatchQueue.global().async { [weak self] in
                guard let data = conn.readRequest(), let req = Self.parse(data) else { return conn.close() }
                self?.queue.async { self?.handle(req, on: conn) }
            }
        }
    }

    private struct Request { let method: String; let query: [String: String]; let body: String }

    fileprivate static func isComplete(_ data: Data) -> Bool { parse(data) != nil }

    private static func parse(_ data: Data) -> Request? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2 else { return nil }
        var length = 0
        for line in lines.dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let bodyStart = headerEnd.upperBound
        guard data.count - bodyStart >= length else { return nil }
        let body = String(data: data[bodyStart..<(bodyStart + length)], encoding: .utf8) ?? ""
        var query: [String: String] = [:]
        for item in URLComponents(string: "http://x" + String(parts[1]))?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(parts[0]), query: query, body: body)
    }

    private func respond(_ conn: Conn, status: String = "200 OK", _ body: String) {
        let bytes = Data(body.utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        conn.send(Data(head.utf8) + bytes)
    }

    // MARK: - Engine.IO / Socket.IO

    private func handle(_ req: Request, on conn: Conn) {
        guard req.query["transport"] == "polling" else { return respond(conn, status: "400 Bad Request", #"{"code":0,"message":"Transport unknown"}"#) }
        guard let sid = req.query["sid"] else {
            // handshake
            _handshakes += 1
            let sid = "e\(_handshakes)-\(UUID().uuidString.prefix(8))"
            engines[sid] = Engine(sid: sid)
            return respond(conn, #"0{"sid":"\#(sid)","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#)
        }
        guard let engine = engines[sid] else {
            return respond(conn, status: "400 Bad Request", #"{"code":1,"message":"Session ID unknown"}"#)
        }
        if req.method == "GET" {
            engine.heldPoll?.close()
            engine.heldPoll = conn
            flush(engine)
        } else {
            for packet in req.body.components(separatedBy: "\u{1e}") where !packet.isEmpty { receive(packet, engine) }
            respond(conn, "ok")
        }
    }

    private func receive(_ packet: String, _ engine: Engine) {
        switch packet.first {
        case "4":  // Engine.IO message: a Socket.IO packet
            let sio = packet.dropFirst()
            if sio.hasPrefix("0") {  // namespace connect ("0/," for the default namespace)
                _namespaceConnects += 1
                let nsid = "n\(_namespaceConnects)"
                engine.namespaceSid = nsid
                push(#"0{"sid":"\#(nsid)"}"#, to: engine)
            } else if sio.hasPrefix("2"), engine.namespaceSid != nil {  // event
                guard let data = String(sio.dropFirst()).data(using: .utf8),
                      let array = try? JSONSerialization.jsonObject(with: data) as? [Any],
                      let name = array.first as? String else { return }
                let payload = array.count > 1 ? (array[1] as? [String: Any] ?? [:]) : [:]
                _events.append((engine.sid, name, payload))
                if name == "requestSnapshot", _answersSnapshots {
                    var reply: [String: Any] = ["snapshot": NSNull(), "reason": "not_in_game"]
                    if let id = payload["requestId"] { reply["requestId"] = id }
                    if let json = try? JSONSerialization.data(withJSONObject: ["stateSnapshot", reply]),
                       let text = String(data: json, encoding: .utf8) {
                        push("2" + text, to: engine)
                    }
                }
            }
        default:  // "3" pong and anything else: nothing to answer
            break
        }
    }

    /// Queue a Socket.IO packet (Engine.IO message type 4) for the engine's next poll.
    private func push(_ sio: String, to engine: Engine) {
        engine.outbox.append("4" + sio)
        flush(engine)
    }

    private func flush(_ engine: Engine) {
        guard let conn = engine.heldPoll, !engine.outbox.isEmpty else { return }
        engine.heldPoll = nil
        let body = engine.outbox.joined(separator: "\u{1e}")
        engine.outbox = []
        respond(conn, body)
    }
}
