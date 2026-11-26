'use strict';

// contract/lib/swiftDecodes.js reads a lenient custom init(from:) that decodes through a local
// helper (iOS 1.2.3 (18): WirePayload.AssistHint, WirePayload.GameLogEntry) only when the
// helper is exactly `(try? c.decodeIfPresent(t, forKey: k)) ?? nil`: every call is optional.
// Also a try? wrapper, and (iOS 1.2.7 (41), Get Your Bid) a lenient `try? decoder.container`
// read through `c.flatMap { try? $0.decode(...) }`. Anything else still throws, so a floor is
// never quietly partial.

const { extractDecodes } = require('../lib/swiftDecodes');

const event = (init, { inExtension = false, container = 'try' } = {}) => ({
    'ServerEvent.swift': `
enum ServerEvent {
    static func decode(name: String) throws {
        switch name {
        case "hint":
            event = .hint(try d(WirePayload.Hint.self))
        default:
            break
        }
    }
}`,
    'WirePayloads.swift': `
enum WirePayload {
    struct Hint: Decodable {
        var v: Int?
        var reasons: [String]?
        var card: Card?
        var label: String?

        enum CodingKeys: String, CodingKey {
            case v, reasons, card
            case label = "text"
        }
${inExtension ? '' : initBlock(init, container)}
    }
}
${inExtension ? `extension WirePayload.Hint {${initBlock(init, container)}}` : ''}
struct Card: Decodable { var suit: String; var rank: String }`,
});

function initBlock(init, container = 'try') {
    return `
        init(from decoder: Decoder) throws {
            let c = ${container} decoder.container(keyedBy: CodingKeys.self)
${init}
        }
`;
}

const LENIENT = `
            func opt<T: Decodable>(_ t: T.Type, _ k: CodingKeys) -> T? { (try? c.decodeIfPresent(t, forKey: k)) ?? nil }
            v = opt(Int.self, .v)
            reasons = opt([String].self, .reasons)
            card = opt(Card.self, .card)
            label = opt(String.self, .label)`;

test('a lenient helper: every call is an optional field, under its raw key', () => {
    const floor = extractDecodes(event(LENIENT));
    expect(floor.events).toEqual({ hint: ['WirePayload.Hint'] });
    expect(floor.types['WirePayload.Hint']).toEqual({
        kind: 'struct',
        fields: {
            v: { type: 'Int', optional: true },
            reasons: { type: '[String]', optional: true },
            card: { type: 'Card', optional: true },
            text: { type: 'String', optional: true },
        },
    });
    // the helper's types are followed like any other field
    expect(floor.types.Card.fields.suit).toEqual({ type: 'String', optional: false });
});

test('a helper that throws (decode, not try? decodeIfPresent) is not read: the extract fails', () => {
    const strict = LENIENT.replace('(try? c.decodeIfPresent(t, forKey: k)) ?? nil', 'try! c.decode(t, forKey: k)');
    expect(() => extractDecodes(event(strict))).toThrow(/decode helper it cannot read/);
});

test('plain decodes and the helper mix: decode stays required', () => {
    const mixed = LENIENT.replace('v = opt(Int.self, .v)', 'v = try c.decode(Int.self, forKey: .v)');
    const { fields } = extractDecodes(event(mixed)).types['WirePayload.Hint'];
    expect(fields.v).toEqual({ type: 'Int', optional: false });
    expect(fields.card).toEqual({ type: 'Card', optional: true });
});

test('a second, strict helper beside the lenient one fails the extract (never a quietly partial floor)', () => {
    const two = LENIENT + `
            func req<T: Decodable>(_ t: T.Type, _ k: CodingKeys) throws -> T { try c.decode(t, forKey: k) }`;
    expect(() => extractDecodes(event(two))).toThrow(/decode helper it cannot read/);
});

test('a key decoded strictly and through the helper stays required', () => {
    const both = LENIENT + `
            v = try c.decode(Int.self, forKey: .v)`;
    expect(extractDecodes(event(both)).types['WirePayload.Hint'].fields.v).toEqual({ type: 'Int', optional: false });
});

test('an init(from:) in an extension (WirePayload.GameLogEntry\'s shape) is read like one in the type', () => {
    expect(extractDecodes(event(LENIENT, { inExtension: true })).types['WirePayload.Hint'].fields.v).toEqual({ type: 'Int', optional: true });
    const strict = LENIENT.replace('v = opt(Int.self, .v)', 'v = try c.decode(Int.self, forKey: .v)');
    expect(extractDecodes(event(strict, { inExtension: true })).types['WirePayload.Hint'].fields.v).toEqual({ type: 'Int', optional: false });
    const unreadable = '            v = nonsense()';
    expect(() => extractDecodes(event(unreadable, { inExtension: true }))).toThrow(/no keyed decode it can read/);
});

const wrapped = (init) => ({
    'ServerEvent.swift': `
enum ServerEvent {
    static func decode(name: String) throws {
        switch name {
        case "start":
            event = .start(try d(WirePayload.Start.self))
        default:
            break
        }
    }
}`,
    'WirePayloads.swift': `
enum WirePayload {
    struct Start: Decodable {
        var seq: Int?
        var wrap: Wrap?
    }
    struct Wrap: Decodable {
        var value: Card?
        var n: Int?
        init(from decoder: Decoder) throws { ${init} }
    }
}
struct Card: Decodable { var suit: String; var rank: String }`,
});

test('a try? wrapper around another type decodes anything: a value of every JSON type, nothing required', () => {
    const floor = extractDecodes(wrapped('value = try? Card(from: decoder)'));
    expect(floor.types['WirePayload.Wrap']).toEqual({ kind: 'value', accepts: ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'] });
    expect(floor.types.Card).toBeUndefined();
});

test('a try? wrapper with anything more in its init is still refused', () => {
    expect(() => extractDecodes(wrapped('value = try? Card(from: decoder); n = 1'))).toThrow(/WirePayload.Wrap: custom init\(from:\) with no keyed decode/);
    expect(() => extractDecodes(wrapped('value = try Card(from: decoder)'))).toThrow(/WirePayload.Wrap: custom init\(from:\) with no keyed decode/);
});

// A lenient container (iOS 1.2.7 (41): StartDraw, GybStart, GybDoneBidding, GybSnapshot):
//   let c = try? decoder.container(keyedBy: CodingKeys.self)
//   x = c.flatMap { try? $0.decode(T.self, forKey: .k) }
// The closure's own try / try? says required / optional, as for a plain read.
const FLATMAP = `
            v = c.flatMap { try? $0.decode(Int.self, forKey: .v) } ?? 0
            reasons = c.flatMap { try? $0.decodeIfPresent([String].self, forKey: .reasons) } ?? nil
            label = c.flatMap { try? $0.decode(String.self, forKey: .label) }`;

test('a lenient container read through flatMap: every try? read is optional, under its raw key', () => {
    const floor = extractDecodes(event(FLATMAP, { container: 'try?' }));
    expect(floor.types['WirePayload.Hint']).toEqual({
        kind: 'struct',
        fields: {
            v: { type: 'Int', optional: true },
            reasons: { type: '[String]', optional: true },
            text: { type: 'String', optional: true },
        },
    });
});

test('a strict read inside the flatMap stays required, beside the tolerant ones', () => {
    const init = `${FLATMAP}
            card = c.flatMap { try $0.decode(Card.self, forKey: .card) }`;
    const { fields } = extractDecodes(event(init, { container: 'try?' })).types['WirePayload.Hint'];
    expect(fields.card).toEqual({ type: 'Card', optional: false });
    expect(fields.v).toEqual({ type: 'Int', optional: true });
});

test('a flatMap over anything but this init\'s own try? keyed container is refused', () => {
    // `c` here is the strict container: a flatMap over it is not this pattern, never guessed at
    expect(() => extractDecodes(event(FLATMAP))).toThrow(/c\.flatMap \{ \$0\.decode \} over a container it cannot read/);
    const other = `
            let n = try? c.nestedContainer(keyedBy: CodingKeys.self, forKey: .card)
            v = n.flatMap { try? $0.decode(Int.self, forKey: .v) }`;
    expect(() => extractDecodes(event(other))).toThrow(/n\.flatMap \{ \$0\.decode \} over a container it cannot read/);
});

test('today\'s Swift (the next build to freeze) is readable: every decode source parses into a floor', () => {
    const fs = require('fs');
    const path = require('path');
    const { DECODE_SOURCES } = require('../baseline');
    const root = path.join(__dirname, '..', '..');
    const files = Object.fromEntries(DECODE_SOURCES.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
    const floor = extractDecodes(files);
    expect(floor.types.GybStart).toEqual({ kind: 'struct', fields: { scores: { type: '[Int]', optional: true } } });
    expect(floor.types['WirePayload.GameStart'].fields.gyb).toEqual({ type: 'GybStart', optional: true });
});
