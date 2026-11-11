/**
 * Swift Codable for snapshot v2 (dev only; called from contract/gen.js).
 *
 * Renders `$defs.snapshotV2` (and the defs it references) as
 * `struct TableSnapshot: Codable, Equatable` with every type nested inside,
 * plus `ContractSeq.events` (the s2c events whose room form carries `seq`).
 * Output: iOSClient/BABOnline/Generated/TableSnapshot.swift.
 *
 * Only the schema subset the snapshot uses is understood: obj, arr, orNull,
 * enm, ref, int, num, bool, str, konst. Anything else, and any inline object
 * or enum without an entry in the name tables below, THROWS: a new snapshot
 * field gets a deliberate Swift name, never a guessed one.
 *
 * Mapping: a key that is required and not nullable is non-optional; a
 * nullable or optional key is Optional. String enums decode an unknown
 * value as `.unknown(raw)`, or throw when the decoder's
 * `userInfo[.contractStrict]` is true (the XCTest fixture decode).
 */

'use strict';

/** $defs name -> Swift type nested in TableSnapshot. */
const NAMED = { snapshotV2: 'TableSnapshot', viewerV2: 'Viewer', seatV2: 'Seat', drawV2: 'Draw', tournamentV2: 'Tournament', teamPair: 'TeamPair' };
/** $defs name -> existing Swift type (no struct emitted). */
const LEAF = { card: 'Card', position: 'Int', bidString: 'String', avatarUrl: 'String' };
/** Inline object, by its key path from the nearest named type ('Draw.' prefix unless TableSnapshot). */
const INLINE = {
    deal: 'Deal', turn: 'Turn', bids: 'Bids', 'bids.mults': 'TeamPair', trick: 'Trick', 'trick.cards[]': 'TrickCard', 'trickHistory[]': 'WonTrick',
    'entrants[]': 'Entrant', 'log[]': 'LogEntry', resume: 'Resume', 'Draw.drawn[]': 'DrawnCard',
};
/** Inline enum, by '<immediate struct>.<key>' (no prefix inside TableSnapshot). */
const ENUMS = {
    stage: 'Stage', 'partial[]': 'PartialKey', 'Viewer.role': 'Role', 'Viewer.ownerView': 'OwnerView', 'Turn.action': 'TurnAction',
    'Seat.controller': 'Controller', 'Seat.presence': 'Presence', 'Entrant.presence': 'EntrantPresence', 'LogEntry.type': 'LogType',
    'Resume.kind': 'ResumeKind',
};

const SWIFT_KEYWORDS = new Set(['associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init',
    'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript',
    'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in',
    'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'super', 'self', 'throw', 'throws',
    'true', 'try']);

const KNOWN_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', '$ref', 'anyOf',
    'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'description']);

const ident = (name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`snapshotSwift: '${name}' is not a Swift identifier`);
    return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
};

/** 'DRAW_RESOLVING' -> 'drawResolving', 'lazyWatcher' -> 'lazyWatcher'. */
function caseName(raw) {
    const words = /^[A-Z0-9_]+$/.test(raw) ? raw.toLowerCase().split('_') : [raw];
    const s = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
    if (s === 'unknown') throw new Error("snapshotSwift: enum value 'unknown' collides with the fallback case");
    return ident(s);
}

function renderSwiftSnapshot(schema, seqEvents) {
    const defs = schema.$defs;
    const types = []; // [{name, lines}] in first-use order
    const emitted = new Set();

    const checkKeys = (node, where) => {
        for (const k of Object.keys(node)) if (!KNOWN_KEYS.has(k)) throw new Error(`snapshotSwift: unsupported keyword '${k}' at ${where}`);
    };

    /** Swift type of a schema node; `nullable` is folded into the caller's Optional. */
    function typeOf(node, ctx) {
        checkKeys(node, ctx.where);
        if (node.anyOf) {
            const nonNull = node.anyOf.filter((v) => !(v.type === 'null'));
            if (nonNull.length !== 1 || node.anyOf.length !== 2) throw new Error(`snapshotSwift: only X|null anyOf is supported at ${ctx.where}`);
            return { swift: typeOf(nonNull[0], ctx).swift, nullable: true };
        }
        if (node.$ref) {
            const name = node.$ref.replace('#/$defs/', '');
            if (LEAF[name]) return { swift: LEAF[name], nullable: false };
            if (!NAMED[name]) throw new Error(`snapshotSwift: $defs.${name} has no Swift name (add it to NAMED or LEAF)`);
            renderStruct(NAMED[name], defs[name], { root: NAMED[name], path: '' });
            return { swift: NAMED[name], nullable: false };
        }
        if ('const' in node) {
            if (!Number.isInteger(node.const)) throw new Error(`snapshotSwift: only integer const at ${ctx.where}`);
            return { swift: 'Int', nullable: false };
        }
        if (node.enum) {
            const key = ctx.struct === 'TableSnapshot' ? ctx.key : `${ctx.struct}.${ctx.key}`;
            const name = ENUMS[key];
            if (!name) throw new Error(`snapshotSwift: inline enum '${key}' has no Swift name (add it to ENUMS)`);
            renderEnum(name, node.enum);
            return { swift: name, nullable: false };
        }
        const t = [].concat(node.type);
        const nullable = t.includes('null');
        const base = t.filter((x) => x !== 'null');
        if (base.length !== 1) throw new Error(`snapshotSwift: unsupported type ${JSON.stringify(node.type)} at ${ctx.where}`);
        switch (base[0]) {
        case 'string': return { swift: 'String', nullable };
        case 'integer': return { swift: 'Int', nullable };
        case 'number': return { swift: 'Double', nullable };
        case 'boolean': return { swift: 'Bool', nullable };
        case 'array': {
            const item = typeOf(node.items, { ...ctx, key: `${ctx.key}[]`, path: `${ctx.path}[]`, where: `${ctx.where}[]` });
            return { swift: `[${item.swift}${item.nullable ? '?' : ''}]`, nullable };
        }
        case 'object': {
            const key = ctx.root === 'TableSnapshot' ? ctx.path : `${ctx.root}.${ctx.path}`;
            const name = INLINE[key];
            if (!name) throw new Error(`snapshotSwift: inline object '${key}' has no Swift name (add it to INLINE)`);
            const named = Object.entries(NAMED).find(([, v]) => v === name);
            if (named) renderStruct(name, defs[named[0]], { root: name, path: '' });
            else renderStruct(name, node, { root: ctx.root, path: ctx.path });
            return { swift: name, nullable };
        }
        default:
            throw new Error(`snapshotSwift: unsupported type '${base[0]}' at ${ctx.where}`);
        }
    }

    function renderStruct(name, node, { root, path }) {
        if (emitted.has(name)) return;
        emitted.add(name);
        checkKeys(node, name);
        if ([].concat(node.type).filter((x) => x !== 'null')[0] !== 'object' || !node.properties) {
            throw new Error(`snapshotSwift: ${name} is not an object schema`);
        }
        const slot = { name, lines: null };
        types.push(slot);
        const required = new Set(node.required || []);
        const lines = [`    struct ${name}: Codable, Equatable {`];
        for (const [key, prop] of Object.entries(node.properties)) {
            const childPath = path ? `${path}.${key}` : key;
            const t = typeOf(prop, { struct: name, key, root, path: childPath, where: `${name}.${key}` });
            const optional = t.nullable || !required.has(key);
            lines.push(`        var ${ident(key)}: ${t.swift}${optional ? '?' : ''}`);
        }
        lines.push('    }');
        slot.lines = lines;
    }

    function renderEnum(name, values) {
        if (emitted.has(name)) return;
        emitted.add(name);
        if (!values.every((v) => typeof v === 'string')) throw new Error(`snapshotSwift: ${name}: only string enums`);
        const cases = values.map((v) => [caseName(v), v]);
        const lines = [
            `    enum ${name}: Codable, Equatable, Hashable {`,
            ...cases.map(([c]) => `        case ${c}`),
            '        case unknown(String)',
            '',
            '        init(rawValue: String) {',
            '            switch rawValue {',
            ...cases.map(([c, v]) => `            case ${JSON.stringify(v)}: self = .${c.replace(/`/g, '')}`),
            '            default: self = .unknown(rawValue)',
            '            }',
            '        }',
            '',
            '        var rawValue: String {',
            '            switch self {',
            ...cases.map(([c, v]) => `            case .${c.replace(/`/g, '')}: return ${JSON.stringify(v)}`),
            '            case .unknown(let raw): return raw',
            '            }',
            '        }',
            '',
            '        init(from decoder: Decoder) throws {',
            '            let raw = try decoder.singleValueContainer().decode(String.self)',
            '            self.init(rawValue: raw)',
            '            if case .unknown = self, decoder.userInfo[.contractStrict] as? Bool == true {',
            `                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown ${name} '\\(raw)'"))`,
            '            }',
            '        }',
            '',
            '        func encode(to encoder: Encoder) throws {',
            '            var c = encoder.singleValueContainer()',
            '            try c.encode(rawValue)',
            '        }',
            '    }',
        ];
        types.push({ name, lines });
    }

    if (!defs.snapshotV2) throw new Error('snapshotSwift: $defs.snapshotV2 missing');
    const top = { name: 'TableSnapshot', lines: null };
    emitted.add('TableSnapshot');
    const required = new Set(defs.snapshotV2.required || []);
    const props = [];
    for (const [key, prop] of Object.entries(defs.snapshotV2.properties)) {
        const t = typeOf(prop, { struct: 'TableSnapshot', key, root: 'TableSnapshot', path: key, where: `TableSnapshot.${key}` });
        props.push(`    var ${ident(key)}: ${t.swift}${t.nullable || !required.has(key) ? '?' : ''}`);
    }
    top.lines = props;

    const seq = Object.keys(seqEvents).sort();
    const out = [
        '// GENERATED by npm run contract:gen from contract/src — do not edit',
        '// Source: $defs.snapshotV2 (contract/src/defs.js) and SEQ_EVENTS (contract/src/s2c.js); generator contract/swift/snapshotSwift.js',
        '',
        'import Foundation',
        '',
        'extension CodingUserInfoKey {',
        '    /// true: an unknown enum value throws instead of decoding as `.unknown` (fixture tests).',
        '    static let contractStrict = CodingUserInfoKey(rawValue: "contractStrict")!',
        '}',
        '',
        '/// Snapshot v2 (contract/README.md "Snapshot v2"): one table view for one viewer.',
        'struct TableSnapshot: Codable, Equatable {',
        ...top.lines,
    ];
    for (const t of types) {
        out.push('');
        out.push(...t.lines);
    }
    out.push('}');
    out.push('');
    out.push('/// s2c events whose room broadcast carries `seq` (contract/README.md R1).');
    out.push('enum ContractSeq {');
    out.push('    static let events: Set<String> = [');
    for (const e of seq) out.push(`        ${JSON.stringify(e)},`);
    out.push('    ]');
    out.push('}');
    return out.join('\n') + '\n';
}

module.exports = { renderSwiftSnapshot, NAMED, LEAF, INLINE, ENUMS };
