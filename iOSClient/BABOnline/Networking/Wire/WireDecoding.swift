import Foundation

/// Decoding of Socket.IO payload values: `[Any]` element → JSONSerialization →
/// JSONDecoder. Explicit nulls, NSNumber bools (never read as Int) and sparse
/// arrays all decode the way the JSON on the wire reads.
enum Wire {
    static func decode<T: Decodable>(_ type: T.Type, _ any: Any?, strict: Bool = false) throws -> T {
        let value: Any = any ?? NSNull()
        let data: Data
        if JSONSerialization.isValidJSONObject(value) {
            data = try JSONSerialization.data(withJSONObject: value)
        } else {
            data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        }
        let decoder = JSONDecoder()
        if strict { decoder.userInfo[.contractStrict] = true }
        return try decoder.decode(T.self, from: data)
    }
}

/// A bid as the server echoes it: an Int (iOS numeric bids, V1_REMOVALS #11)
/// or a string ("5", "b", "2B"); always normalised to an uppercase string.
struct BidWire: Decodable, Equatable {
    let value: String
    init(_ value: String) { self.value = value.uppercased() }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s.uppercased(); return }
        if let n = try? c.decode(Int.self) { value = String(n); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "bid is neither a string nor an integer")
    }
}

/// A picture slot: avatar number (Int or digit string), a data URL, or null.
struct PicWire: Decodable, Equatable {
    let pic: Pic
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { pic = .none; return }
        if let n = try? c.decode(Int.self) { pic = .avatar(n); return }
        if let s = try? c.decode(String.self) { pic = Pic(string: s); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "pic is not a number, string or null")
    }
}

/// An Int that may arrive as a numeric string.
struct LenientInt: Decodable, Equatable {
    let value: Int
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { value = n; return }
        if let s = try? c.decode(String.self), let n = Int(s) { value = n; return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not an integer")
    }
}

/// A seat picture (the wire's number | data URL | null).
enum Pic: Equatable, Hashable {
    case avatar(Int)
    case custom(String)
    case none

    init(string s: String) {
        if let n = Int(s) { self = .avatar(n) } else if s.isEmpty { self = .none } else { self = .custom(s) }
    }

    /// The `String?` form the views and OpponentHandNode load (numbered or data URL).
    var string: String? {
        switch self {
        case .avatar(let n): return String(n)
        case .custom(let s): return s
        case .none: return nil
        }
    }

    var number: Int? { if case .avatar(let n) = self { return n } else { return nil } }
}
