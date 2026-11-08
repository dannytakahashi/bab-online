/**
 * The contract's JSON-Schema subset validator (contract/lib/validate.js).
 */

const { compile } = require('../lib/validate');

const ok = (schema, value, defs) => expect(compile(schema, defs)(value)).toEqual([]);
const bad = (schema, value, defs) => {
    const errors = compile(schema, defs)(value);
    expect(errors.length).toBeGreaterThan(0);
    return errors;
};

describe('types', () => {
    test('single and union types, integer vs number, null', () => {
        ok({ type: 'string' }, 'x');
        bad({ type: 'string' }, 1);
        ok({ type: 'integer' }, 3);
        bad({ type: 'integer' }, 3.5);
        ok({ type: 'number' }, 3.5);
        bad({ type: 'number' }, NaN);
        ok({ type: ['string', 'null'] }, null);
        bad({ type: ['string', 'null'] }, undefined);
        ok({ type: 'array' }, []);
        bad({ type: 'object' }, []);
        bad({ type: 'object' }, null);
        ok({ type: 'boolean' }, false);
    });

    test('const and enum (deep equality)', () => {
        ok({ const: 2 }, 2);
        bad({ const: 2 }, '2');
        ok({ const: { a: [1] } }, { a: [1] });
        ok({ enum: ['a', 'b'] }, 'b');
        bad({ enum: ['a', 'b'] }, 'c');
    });

    test('numeric and string bounds, pattern', () => {
        ok({ type: 'integer', minimum: 1, maximum: 4 }, 4);
        bad({ type: 'integer', minimum: 1, maximum: 4 }, 0);
        bad({ type: 'integer', minimum: 1, maximum: 4 }, 5);
        ok({ type: 'string', minLength: 1, maxLength: 3 }, 'abc');
        bad({ type: 'string', maxLength: 3 }, 'abcd');
        bad({ type: 'string', minLength: 1 }, '');
        ok({ type: 'string', pattern: '^[1-4]$' }, '3');
        bad({ type: 'string', pattern: '^[1-4]$' }, '5');
    });
});

describe('objects', () => {
    const closed = {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
    };

    test('required, closed, open, schema-valued additionalProperties', () => {
        ok(closed, { a: 1 });
        ok(closed, { a: 1, b: 'x' });
        expect(bad(closed, { b: 'x' })[0].message).toMatch(/missing required 'a'/);
        expect(bad(closed, { a: 1, c: 2 })[0].message).toMatch(/unexpected key 'c'/);
        ok({ ...closed, additionalProperties: true }, { a: 1, c: 2 });
        ok({ type: 'object', properties: {} }, { anything: 1 });
        ok({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 1, y: 2 });
        bad({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 'no' });
    });

    test('patternProperties (open maps keyed by position)', () => {
        const s = { type: 'object', patternProperties: { '^[1-4]$': { type: 'integer' } }, additionalProperties: false };
        ok(s, { 1: 2, 4: 0 });
        bad(s, { 5: 2 });
        bad(s, { 1: 'x' });
    });

    test('nested paths are reported', () => {
        const s = { type: 'object', properties: { x: { type: 'array', items: { type: 'integer' } } } };
        const [e] = bad(s, { x: [1, 'two'] });
        expect(e.path).toBe('$.x[1]');
    });
});

describe('arrays', () => {
    test('items, minItems, maxItems', () => {
        const s = { type: 'array', items: { type: ['string', 'null'] }, minItems: 1, maxItems: 2 };
        ok(s, ['a', null]);
        bad(s, []);
        bad(s, ['a', 'b', 'c']);
        bad(s, [1]);
    });
});

describe('anyOf and $ref', () => {
    const defs = {
        card: {
            type: 'object',
            properties: { suit: { enum: ['hearts', 'joker'] }, rank: { type: 'string' } },
            required: ['suit', 'rank'],
            additionalProperties: false,
        },
    };

    test('$ref resolves against $defs', () => {
        ok({ $ref: '#/$defs/card' }, { suit: 'hearts', rank: '2' }, defs);
        bad({ $ref: '#/$defs/card' }, { suit: 'clubs', rank: '2' }, defs);
    });

    test('recursive refs compile', () => {
        const d = { node: { type: 'object', properties: { next: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/node' }] } } } };
        ok({ $ref: '#/$defs/node' }, { next: { next: { next: null } } }, d);
        bad({ $ref: '#/$defs/node' }, { next: { next: 3 } }, d);
    });

    test('anyOf reports the closest variant', () => {
        const s = {
            anyOf: [
                { variant: 'success', type: 'object', properties: { success: { const: true }, username: { type: 'string' } }, required: ['success', 'username'], additionalProperties: false },
                { variant: 'failure', type: 'object', properties: { success: { const: false }, message: { type: 'string' } }, required: ['success', 'message'], additionalProperties: false },
            ],
        };
        ok(s, { success: true, username: 'a' });
        ok(s, { success: false, message: 'no' });
        const errors = bad(s, { success: false });
        expect(errors[0].message).toMatch(/closest variant: failure/);
    });

    test('unresolved and non-local refs throw at compile time', () => {
        expect(() => compile({ $ref: '#/$defs/nope' }, defs)).toThrow(/unresolved/);
        expect(() => compile({ $ref: 'http://x/y' }, defs)).toThrow(/unsupported \$ref/);
    });
});

describe('keywords', () => {
    test('annotations are ignored', () => {
        ok({ type: 'string', description: 'd', title: 't', $comment: 'c', examples: ['x'], default: 'x', notes: 'n' }, 'x');
    });

    test('any unsupported keyword throws', () => {
        for (const k of ['oneOf', 'allOf', 'not', 'format', 'multipleOf', 'uniqueItems', 'dependentRequired', 'if']) {
            expect(() => compile({ [k]: [] })).toThrow(/unsupported keyword/);
        }
        expect(() => compile({ type: 'object', properties: { a: { format: 'uuid' } } })).toThrow(/unsupported keyword 'format'/);
        expect(() => compile({ type: 'datetime' })).toThrow(/unknown type/);
    });

    test('true / false schemas', () => {
        ok(true, 42);
        bad(false, 42);
    });
});
