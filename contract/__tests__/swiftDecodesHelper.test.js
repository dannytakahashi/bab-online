'use strict';

// contract/lib/swiftDecodes.js reads a lenient custom init(from:) that decodes through a local
// helper (iOS 1.2.3 (18): WirePayload.AssistHint, WirePayload.GameLogEntry) only when the
// helper is exactly `(try? c.decodeIfPresent(t, forKey: k)) ?? nil`: every call is optional.
// Anything else still throws, so a floor is never quietly partial.

const { extractDecodes } = require('../lib/swiftDecodes');

const event = (init, { inExtension = false } = {}) => ({
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
${inExtension ? '' : initBlock(init)}
    }
}
${inExtension ? `extension WirePayload.Hint {${initBlock(init)}}` : ''}
struct Card: Decodable { var suit: String; var rank: String }`,
});

function initBlock(init) {
    return `
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
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
