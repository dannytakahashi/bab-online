/**
 * A dependency-free validator for the JSON Schema subset the socket
 * contract uses (dev/test only: production server code never requires
 * anything under contract/).
 *
 * compile(schema, defs) -> fn(value) -> errors [{path, message}] ([] = ok).
 *
 * Supported keywords: type (string or array; integer and null included),
 * const, enum, properties, required, additionalProperties (bool | schema),
 * patternProperties, items, minItems, maxItems, minimum, maximum,
 * minLength, maxLength, pattern, anyOf, $ref ('#/$defs/X' only).
 * Annotations (description, title, $comment, examples, default, notes and
 * the contract's per-event metadata keys) are ignored. Any other keyword
 * makes compile THROW, so the schema can never silently claim more than is
 * checked.
 */

'use strict';

const SUPPORTED = new Set([
    'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'patternProperties',
    'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
    'anyOf', '$ref',
]);

const ANNOTATIONS = new Set([
    'description', 'title', '$comment', 'examples', 'default', 'notes', '$schema', '$id', 'variant',
    // contract metadata (events.schema.json per-event keys)
    'payload', 'status', 'to', 'seq', 'variants', 'added', 'activates', 'reserved', 'clientReads',
    'emittedFrom', 'joi', 'rateLimit', 'sentBy',
]);

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function matchesType(v, t) {
    switch (t) {
        case 'null': return v === null;
        case 'array': return Array.isArray(v);
        case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
        case 'integer': return typeof v === 'number' && Number.isInteger(v);
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'string': return typeof v === 'string';
        case 'boolean': return typeof v === 'boolean';
        default: return false;
    }
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const show = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? 'undefined' : (s.length > 60 ? s.slice(0, 57) + '...' : s);
};

/**
 * @param {Object|boolean} schema
 * @param {Object} [defs] - the $defs table '#/$defs/X' refs resolve against
 * @returns {(value: any) => Array<{path: string, message: string}>}
 */
function compile(schema, defs = {}) {
    const cache = new Map();

    function build(s, where) {
        if (s === true) return () => [];
        if (s === false) return (v, path) => [{ path, message: 'no value allowed here' }];
        if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`contract schema at ${where}: not a schema`);
        if (cache.has(s)) return cache.get(s);

        for (const k of Object.keys(s)) {
            if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k)) {
                throw new Error(`contract schema at ${where}: unsupported keyword '${k}'`);
            }
        }

        const checks = [];
        let self = null;
        const fn = (v, path) => {
            const errors = [];
            for (const c of checks) {
                const e = c(v, path);
                if (e.length) {
                    errors.push(...e);
                    // a type mismatch makes the structural checks noise
                    if (c.isType) break;
                }
            }
            return errors;
        };
        cache.set(s, fn);
        self = fn;

        if (s.$ref !== undefined) {
            const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(s.$ref);
            if (!m) throw new Error(`contract schema at ${where}: unsupported $ref '${s.$ref}'`);
            const target = defs[m[1]];
            if (target === undefined) throw new Error(`contract schema at ${where}: unresolved $ref '${s.$ref}'`);
            let resolved = null;
            checks.push((v, path) => {
                if (!resolved) resolved = build(target, `#/$defs/${m[1]}`);
                return resolved(v, path);
            });
        }

        if (s.type !== undefined) {
            const types = Array.isArray(s.type) ? s.type : [s.type];
            for (const t of types) {
                if (!TYPES.has(t)) throw new Error(`contract schema at ${where}: unknown type '${t}'`);
            }
            const c = (v, path) => (types.some((t) => matchesType(v, t))
                ? []
                : [{ path, message: `expected ${types.join('|')}, got ${typeOf(v)} ${show(v)}` }]);
            c.isType = true;
            checks.push(c);
        }

        if (s.const !== undefined) {
            checks.push((v, path) => (deepEqual(v, s.const) ? [] : [{ path, message: `expected const ${show(s.const)}, got ${show(v)}` }]));
        }
        if (s.enum !== undefined) {
            checks.push((v, path) => (s.enum.some((e) => deepEqual(v, e)) ? [] : [{ path, message: `expected one of ${show(s.enum)}, got ${show(v)}` }]));
        }

        if (s.minimum !== undefined || s.maximum !== undefined) {
            checks.push((v, path) => {
                if (typeof v !== 'number') return [];
                if (s.minimum !== undefined && v < s.minimum) return [{ path, message: `${v} < minimum ${s.minimum}` }];
                if (s.maximum !== undefined && v > s.maximum) return [{ path, message: `${v} > maximum ${s.maximum}` }];
                return [];
            });
        }
        if (s.minLength !== undefined || s.maxLength !== undefined || s.pattern !== undefined) {
            const re = s.pattern !== undefined ? new RegExp(s.pattern) : null;
            checks.push((v, path) => {
                if (typeof v !== 'string') return [];
                if (s.minLength !== undefined && v.length < s.minLength) return [{ path, message: `string shorter than ${s.minLength}` }];
                if (s.maxLength !== undefined && v.length > s.maxLength) return [{ path, message: `string longer than ${s.maxLength}` }];
                if (re && !re.test(v)) return [{ path, message: `string ${show(v)} does not match ${s.pattern}` }];
                return [];
            });
        }

        if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) {
            const item = s.items !== undefined ? build(s.items, `${where}/items`) : null;
            checks.push((v, path) => {
                if (!Array.isArray(v)) return [];
                const errors = [];
                if (s.minItems !== undefined && v.length < s.minItems) errors.push({ path, message: `array has ${v.length} items, minItems ${s.minItems}` });
                if (s.maxItems !== undefined && v.length > s.maxItems) errors.push({ path, message: `array has ${v.length} items, maxItems ${s.maxItems}` });
                if (item) v.forEach((x, i) => errors.push(...item(x, `${path}[${i}]`)));
                return errors;
            });
        }

        if (s.properties !== undefined || s.required !== undefined ||
            s.additionalProperties !== undefined || s.patternProperties !== undefined) {
            const props = {};
            for (const [k, ps] of Object.entries(s.properties || {})) props[k] = build(ps, `${where}/properties/${k}`);
            const patterns = Object.entries(s.patternProperties || {}).map(([p, ps]) => [new RegExp(p), build(ps, `${where}/patternProperties/${p}`)]);
            const ap = s.additionalProperties;
            const apFn = ap !== undefined && typeof ap === 'object' ? build(ap, `${where}/additionalProperties`) : null;
            const required = s.required || [];
            checks.push((v, path) => {
                if (v === null || typeof v !== 'object' || Array.isArray(v)) return [];
                const errors = [];
                for (const k of required) {
                    if (!Object.prototype.hasOwnProperty.call(v, k)) errors.push({ path, message: `missing required '${k}'` });
                }
                for (const [k, x] of Object.entries(v)) {
                    const p = `${path}.${k}`;
                    let matched = false;
                    if (props[k]) {
                        matched = true;
                        errors.push(...props[k](x, p));
                    }
                    for (const [re, pf] of patterns) {
                        if (re.test(k)) {
                            matched = true;
                            errors.push(...pf(x, p));
                        }
                    }
                    if (!matched) {
                        if (ap === false) errors.push({ path, message: `unexpected key '${k}'` });
                        else if (apFn) errors.push(...apFn(x, p));
                    }
                }
                return errors;
            });
        }

        if (s.anyOf !== undefined) {
            if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) throw new Error(`contract schema at ${where}: anyOf must be a non-empty array`);
            const variants = s.anyOf.map((vs, i) => [vs.variant || String(i), build(vs, `${where}/anyOf/${i}`)]);
            checks.push((v, path) => {
                let best = null;
                for (const [name, vf] of variants) {
                    const e = vf(v, path);
                    if (e.length === 0) return [];
                    if (!best || e.length < best.errors.length) best = { name, errors: e };
                }
                // Report the closest variant
                return best.errors.map((e) => ({ ...e, message: `${e.message} (closest variant: ${best.name})` }));
            });
        }

        return self;
    }

    const root = build(schema, '#');
    return (value) => root(value, '$');
}

module.exports = { compile, SUPPORTED, ANNOTATIONS, deepEqual };
