/**
 * What a shipped iOS build DECODES, and whether today's schema still sends
 * it (dev/test only).
 *
 * The iOS table store decodes every table event with JSONDecoder
 * (`ServerEvent.decode` -> `WirePayload.*`, `TableSnapshot`, `Card`). A
 * non-optional Swift property whose key is missing or null, or a value of
 * another JSON type, fails the WHOLE event (rejoin, restore, spectate and
 * resync included), so this is the hard floor under the schema baselines:
 *
 *   extractDecodes(sources)  read the build's Swift (a small subset parser:
 *                            structs, enums, stored properties, CodingKeys,
 *                            custom init(from:)) into a decode floor
 *   checkDecodes(floor, schema)  problems with the schema against it
 *
 * The parser throws on anything it does not understand (an unknown type, a
 * custom init it cannot read), so a floor is never quietly partial.
 *
 * Only the table events are covered: the lobby, main room, auth, tournament,
 * leaderboard, voice and safety handlers (Networking/Handlers) read
 * `[String: Any]` by hand (`guard let x = dict["k"] as? T`, which drops the
 * event when a key is missing), and only the schema baselines hold those.
 */

'use strict';

// ---------- Swift subset scanner ----------

/** Comments out, strings kept (braces inside them are not blocks). */
function stripComments(src) {
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '"') {
            if (src.startsWith('"""', i)) throw new Error('swiftDecodes: multi-line string literals are not supported');
            let j = i + 1;
            while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            out += src.slice(i, j + 1);
            i = j;
        } else if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 1;
        } else {
            out += c;
        }
    }
    return out;
}

const parenBalance = (s) => (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;

/** Brace tree: {header, stmts (direct statements), children, text (body)}. */
function blockTree(src) {
    const code = stripComments(src);
    const root = { header: null, stmts: [], children: [], text: code };
    const stack = [root];
    let buf = '';
    const flush = (node, keepLast) => {
        const segs = buf.split(/[;\n]/);
        let last = '';
        if (keepLast) {
            last = segs.pop();
            while (parenBalance(last) < 0 && segs.length) last = `${segs.pop()} ${last}`;
        }
        node.stmts.push(...segs.map((s) => s.trim()).filter(Boolean));
        buf = '';
        return last.trim();
    };
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '"') {
            let j = i + 1;
            while (j < code.length && code[j] !== '"' && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
            buf += code.slice(i, j + 1);
            i = j;
        } else if (c === '{') {
            const node = stack[stack.length - 1];
            const child = { header: flush(node, true), stmts: [], children: [], start: i + 1 };
            node.children.push(child);
            stack.push(child);
        } else if (c === '}') {
            const node = stack.pop();
            if (!node || stack.length === 0) throw new Error('swiftDecodes: unbalanced braces');
            flush(node, false);
            node.text = code.slice(node.start, i);
        } else {
            buf += c;
        }
    }
    flush(root, false);
    if (stack.length !== 1) throw new Error('swiftDecodes: unbalanced braces');
    return root;
}

// ---------- types ----------

const PRIMITIVE = { Int: 'integer', Double: 'number', String: 'string', Bool: 'boolean' };

/** 'X?', '[X]', '[String: X]', 'A.B' -> {opt} | {array} | {dict} | {name}. */
function parseType(text) {
    const t = text.trim();
    if (t.endsWith('?')) return { opt: parseType(t.slice(0, -1)) };
    if (t.startsWith('[') && t.endsWith(']')) {
        const inner = t.slice(1, -1);
        let depth = 0;
        for (let i = 0; i < inner.length; i++) {
            if (inner[i] === '[') depth++;
            else if (inner[i] === ']') depth--;
            else if (inner[i] === ':' && depth === 0) {
                if (inner.slice(0, i).trim() !== 'String') throw new Error(`swiftDecodes: only String-keyed dictionaries, got '${t}'`);
                return { dict: parseType(inner.slice(i + 1)) };
            }
        }
        return { array: parseType(inner) };
    }
    if (!/^[A-Za-z_][\w.]*$/.test(t)) throw new Error(`swiftDecodes: unsupported Swift type '${t}'`);
    return { name: t };
}

function formatType(t) {
    if (t.opt) return `${formatType(t.opt)}?`;
    if (t.array) return `[${formatType(t.array)}]`;
    if (t.dict) return `[String: ${formatType(t.dict)}]`;
    return t.name;
}

// ---------- declarations ----------

const DECL_RE = /^(?:(?:public|internal|private|fileprivate|final|indirect)\s+)*(struct|enum|extension|class)\s+([A-Za-z_][\w.]*)\s*(?::\s*(.+?))?\s*$/;
const PROP_RE = /^(?:(?:public|internal|private|fileprivate|@\w+)\s+)*(static\s+)?(let|var)\s+(\w+)\s*:\s*([^=]+?)\s*(=\s*.+)?$/;
const INIT_RE = /^(?:(?:public|internal|private|fileprivate)\s+)*init\s*\(\s*from\s+decoder\s*:\s*Decoder\s*\)/;

/** Every struct / enum (qualified 'Outer.Inner') declared in the files. */
function collectDecls(files) {
    const decls = {};
    const visit = (node, scope, file) => {
        for (const child of node.children) {
            const m = DECL_RE.exec(child.header);
            if (m) {
                const [, kind, name, conf] = m;
                if (kind === 'extension') {
                    visit(child, name, file);
                    continue;
                }
                const qname = scope ? `${scope}.${name}` : name;
                if (decls[qname]) throw new Error(`swiftDecodes: ${qname} declared twice (${decls[qname].file}, ${file})`);
                const conformances = (conf || '').split(',').map((s) => s.trim()).filter(Boolean);
                decls[qname] = { kind, name: qname, scope, file, conformances, node: child };
                visit(child, qname, file);
            } else if (scope && INIT_RE.test(child.header)) {
                const host = Object.values(decls).find((d) => d.node === node);
                if (host) host.customInit = child.text;
            }
        }
    };
    for (const [file, src] of Object.entries(files)) visit(blockTree(src), '', file);
    return decls;
}

function resolveName(name, scope, decls) {
    if (PRIMITIVE[name]) return name;
    for (let s = scope; ; s = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : '') {
        const cand = s ? `${s}.${name}` : name;
        if (decls[cand]) return cand;
        if (!s) break;
    }
    throw new Error(`swiftDecodes: unknown Swift type '${name}' (in ${scope || 'top level'}); add the file that declares it`);
}

function resolveType(t, scope, decls) {
    if (t.opt) return { opt: resolveType(t.opt, scope, decls) };
    if (t.array) return { array: resolveType(t.array, scope, decls) };
    if (t.dict) return { dict: resolveType(t.dict, scope, decls) };
    return { name: resolveName(t.name, scope, decls) };
}

const isDecodable = (d) => d.conformances.some((c) => c === 'Codable' || c === 'Decodable');

function enumCases(decl) {
    const cases = [];
    for (const s of decl.node.stmts) {
        if (!s.startsWith('case ')) continue;
        for (const part of s.slice(5).split(/,(?![^(]*\))/)) {
            const m = /^\s*(\w+)\s*(?:\(([^)]*)\))?\s*(?:=\s*"([^"]*)")?\s*$/.exec(part);
            if (!m) throw new Error(`swiftDecodes: ${decl.name}: cannot read 'case ${part.trim()}'`);
            cases.push({ name: m[1], assoc: m[2], raw: m[3] !== undefined ? m[3] : m[1] });
        }
    }
    return cases;
}

/** {kind:'struct', fields} | {kind:'string'} | {kind:'enum', values} | {kind:'value', accepts}. */
function describe(decl, decls) {
    const init = decl.customInit;
    if (decl.kind === 'enum') {
        const cases = enumCases(decl);
        if (cases.some((c) => c.name === 'unknown' && c.assoc && c.assoc.trim() === 'String')) return { kind: 'string' };
        if (decl.conformances[0] === 'String' && isDecodable(decl) && !init) return { kind: 'enum', values: cases.map((c) => c.raw).sort() };
        if (init && /singleValueContainer/.test(init)) return valueKind(decl, init);
        throw new Error(`swiftDecodes: enum ${decl.name}: cannot tell how it decodes`);
    }
    if (decl.kind !== 'struct') throw new Error(`swiftDecodes: ${decl.name} is a ${decl.kind}; only structs and enums decode here`);
    if (!isDecodable(decl)) throw new Error(`swiftDecodes: ${decl.name} is not Decodable`);
    if (init && /singleValueContainer/.test(init)) return valueKind(decl, init);

    const codingKeys = decls[`${decl.name}.CodingKeys`];
    const rawKey = {};
    if (codingKeys) for (const c of enumCases(codingKeys)) rawKey[c.name] = c.raw;
    const fields = {};
    if (init) {
        // keyed custom init: decode = required, decodeIfPresent / try? = optional; contains() is no decode
        const re = /(?:let\s+(\w+)\s*=\s*)?try(\?)?\s*\w+\.(decode|decodeIfPresent)\(\s*(.+?)\.self\s*,\s*forKey:\s*\.(\w+)\s*\)/g;
        let m;
        while ((m = re.exec(init))) {
            const [, local, tryQ, how, typeText, key] = m;
            let t = resolveType(parseType(typeText), decl.name, decls);
            // `let s = decode(String)` then `guard let x = SomeEnum(rawValue: s) else { throw }`: the closed enum
            const asEnum = local && new RegExp(`(\\w+)\\(rawValue:\\s*${local}\\s*\\)`).exec(init);
            if (asEnum && t.name === 'String') {
                const e = resolveName(asEnum[1], decl.name, decls);
                if (!/throw/.test(init)) throw new Error(`swiftDecodes: ${decl.name}.${key}: ${e}(rawValue:) without a throw`);
                t = { name: e };
            }
            const optional = how === 'decodeIfPresent' || tryQ === '?';
            fields[rawKey[key] || key] = { type: formatType(t), optional };
        }
        if (!Object.keys(fields).length) throw new Error(`swiftDecodes: ${decl.name}: custom init(from:) with no keyed decode it can read`);
    } else {
        for (const s of decl.node.stmts) {
            const m = PROP_RE.exec(s);
            if (!m) continue;
            const [, isStatic, letVar, name, typeText, init0] = m;
            if (isStatic) continue;
            if (letVar === 'let' && init0) continue; // a let with a value is never decoded
            if (codingKeys && !(name in rawKey)) continue;
            const t = resolveType(parseType(typeText), decl.name, decls);
            fields[rawKey[name] || name] = { type: formatType(t.opt || t), optional: Boolean(t.opt) };
        }
    }
    return { kind: 'struct', fields };
}

function valueKind(decl, init) {
    const accepts = new Set();
    for (const m of init.matchAll(/\.decode\((\w+)\.self\)/g)) {
        if (!PRIMITIVE[m[1]]) throw new Error(`swiftDecodes: ${decl.name}: single-value decode of ${m[1]}`);
        accepts.add(PRIMITIVE[m[1]]);
        if (m[1] === 'Double') accepts.add('integer');
    }
    if (/decodeNil\(\)/.test(init)) accepts.add('null');
    if (!accepts.size) throw new Error(`swiftDecodes: ${decl.name}: single-value init with no decode it can read`);
    return { kind: 'value', accepts: [...accepts].sort() };
}

/** event -> decoded root types, from ServerEvent.decode's `switch name`. */
function eventRoots(files, decls) {
    let sw = null;
    const find = (node) => {
        for (const c of node.children) {
            if (/^switch\s+name$/.test(c.header) && /\bd\(/.test(c.text)) sw = sw || c;
            find(c);
        }
    };
    for (const src of Object.values(files)) find(blockTree(src));
    if (!sw) throw new Error('swiftDecodes: no `switch name` with d(...) decodes (ServerEvent.decode) found');
    const events = {};
    const tolerated = [];
    const parts = sw.text.split(/\bcase\s+"(\w+)"\s*:/);
    for (let i = 1; i < parts.length; i += 2) {
        const name = parts[i];
        const body = parts[i + 1].split(/\bdefault\s*:/)[0];
        const roots = [];
        for (const m of body.matchAll(/(try\??)\s*d\(\s*([\w.]+)\.self\s*\)/g)) {
            if (m[1] === 'try?') {
                if (!tolerated.includes(name)) tolerated.push(name);
                continue;
            }
            const r = resolveName(m[2], '', decls);
            if (!roots.includes(r)) roots.push(r);
        }
        if (roots.length) events[name] = roots;
    }
    return { events, tolerated: tolerated.filter((e) => !events[e]).sort() };
}

/**
 * The decode floor of one build's Swift sources ({path: text}).
 * @returns {{events: Object<string,string[]>, tolerated: string[], types: Object}}
 */
function extractDecodes(files) {
    const decls = collectDecls(files);
    const { events, tolerated } = eventRoots(files, decls);
    const types = {};
    const queue = Object.values(events).flat();
    const named = (t) => {
        const p = parseType(t);
        const inner = (x) => (x.opt ? inner(x.opt) : x.array ? inner(x.array) : x.dict ? inner(x.dict) : x.name);
        return inner(p);
    };
    while (queue.length) {
        const n = queue.shift();
        if (types[n] || PRIMITIVE[n]) continue;
        const d = describe(decls[n], decls);
        types[n] = d;
        if (d.kind === 'struct') for (const f of Object.values(d.fields)) queue.push(named(f.type));
    }
    const sorted = {};
    for (const k of Object.keys(types).sort()) sorted[k] = types[k];
    const ev = {};
    for (const k of Object.keys(events).sort()) ev[k] = events[k];
    return { events: ev, tolerated, types: sorted };
}

// ---------- the check ----------

const refName = (node) => node.$ref.replace('#/$defs/', '');

/** One schema node as single-type branches, $refs and anyOf flattened. */
function branches(node, defs, seen = []) {
    if (node === true || !node || typeof node !== 'object' || !Object.keys(node).filter((k) => k !== 'description').length) return [{ any: true }];
    if (node.$ref) {
        const name = refName(node);
        if (!defs[name]) return [{ missingRef: name }];
        if (seen.includes(name)) return [{ any: true }];
        return branches(defs[name], defs, [...seen, name]);
    }
    if (node.anyOf) return node.anyOf.flatMap((b) => branches(b, defs, seen));
    if ('const' in node) return [{ ...node, type: node.const === null ? 'null' : (Number.isInteger(node.const) ? 'integer' : typeof node.const) }];
    if (node.type === undefined && node.enum) {
        const ts = [...new Set(node.enum.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v)))];
        return ts.map((t) => ({ ...node, type: t, enum: node.enum.filter((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v) === t) }));
    }
    if (node.type === undefined) return [{ any: true }];
    return [].concat(node.type).map((t) => ({ ...node, type: t }));
}

/**
 * Problems with `schema` against a build's decode floor; `label` names the
 * build in every line ("iOS 1.2.0 (6)"). `waived` maps a path
 * ('stateSnapshot.requestId') to why a mismatch there cannot reach iOS;
 * `relied` maps a path whose Swift property is optional to why the build
 * still needs it (held as if it were not optional). Both: decodeRules.js.
 */
function checkDecodes(floor, schema, label, waived = {}, relied = {}) {
    const out = new Set();
    const defs = schema.$defs || {};
    let root = '';
    const say = (where, msg) => {
        if (!waived[where]) out.add(`${label} decodes ${where} (${root}): ${msg}`);
    };

    function check(t, node, where, depth) {
        if (depth > 40) return;
        const nullOk = Boolean(t.opt);
        const base = t.opt || t;
        const type = base.name ? floor.types[base.name] : null;
        const accepts = (b) => {
            if (b.any) return 'the schema no longer constrains it';
            if (b.missingRef) return `$defs.${b.missingRef} is gone`;
            if (b.type === 'null') return nullOk || (type && type.kind === 'value' && type.accepts.includes('null')) ? null : `it may be null (${t.relied ? `relied on: ${t.relied}` : 'the Swift property is not optional'})`;
            if (base.array) return b.type === 'array' ? null : `it is ${b.type}, Swift wants an array`;
            if (base.dict) return b.type === 'object' ? null : `it is ${b.type}, Swift wants an object`;
            if (PRIMITIVE[base.name]) {
                const ok = base.name === 'Double' ? ['number', 'integer'] : [PRIMITIVE[base.name]];
                return ok.includes(b.type) ? null : `it is ${b.type}, Swift wants ${base.name}`;
            }
            if (!type) return `no decode floor for ${base.name}`;
            if (type.kind === 'value') return type.accepts.includes(b.type) ? null : `it is ${b.type}, ${base.name} decodes ${type.accepts.join(' | ')}`;
            if (type.kind === 'string') return b.type === 'string' ? null : `it is ${b.type}, ${base.name} decodes a string`;
            if (type.kind === 'enum') {
                if (b.type !== 'string') return `it is ${b.type}, ${base.name} decodes a string`;
                const vals = 'const' in b ? [b.const] : b.enum;
                if (!vals) return `any string may come, ${base.name} decodes only ${type.values.join(' | ')}`;
                const extra = vals.filter((v) => !type.values.includes(v));
                return extra.length ? `${JSON.stringify(extra)} would throw (${base.name} decodes only ${type.values.join(' | ')})` : null;
            }
            return b.type === 'object' ? null : `it is ${b.type}, ${base.name} wants an object`;
        };
        for (const b of branches(node, defs)) {
            const why = accepts(b);
            if (why) {
                say(where, why);
                continue;
            }
            if (b.type === 'null') continue;
            if (base.array) {
                if (b.items === undefined) say(`${where}[]`, 'the schema no longer constrains the items');
                else check(base.array, b.items, `${where}[]`, depth + 1);
            } else if (base.dict) {
                const vals = [...Object.entries(b.properties || {}).map(([k, v]) => [`${where}.${k}`, v]),
                    ...Object.entries(b.patternProperties || {}).map(([k, v]) => [`${where}[${k}]`, v])];
                if (b.additionalProperties && typeof b.additionalProperties === 'object') vals.push([`${where}[*]`, b.additionalProperties]);
                else if (b.additionalProperties !== false) vals.push([`${where}[*]`, true]);
                for (const [w, v] of vals) check(base.dict, v, w, depth + 1);
            } else if (type && type.kind === 'struct') {
                for (const [key, f] of Object.entries(type.fields)) {
                    const ft = parseType(f.type);
                    const prop = b.properties && b.properties[key];
                    const w = `${where}.${key}`;
                    if (f.optional && !relied[w]) {
                        if (prop) check({ opt: ft }, prop, w, depth + 1);
                        continue;
                    }
                    const why = f.optional ? `relied on: ${relied[w]}` : `${base.name}.${key}: ${f.type} is not optional`;
                    if (!prop) say(w, `gone from the schema (${why})`);
                    else {
                        if (!(b.required || []).includes(key)) say(w, `no longer required (${why})`);
                        check(f.optional ? { ...ft, relied: relied[w] } : ft, prop, w, depth + 1);
                    }
                }
            }
        }
    }

    for (const [event, roots] of Object.entries(floor.events)) {
        const entry = schema.s2c && schema.s2c[event];
        root = roots.join(', ');
        if (!entry) {
            say(event, 'the event is gone');
            continue;
        }
        if (entry.payload === null) {
            say(event, 'it has no payload any more (a missing payload fails the decode)');
            continue;
        }
        for (const r of roots) {
            root = r;
            check({ name: r }, entry.payload, event, 0);
        }
    }
    return [...out];
}

module.exports = { extractDecodes, checkDecodes, parseType, formatType, blockTree };
