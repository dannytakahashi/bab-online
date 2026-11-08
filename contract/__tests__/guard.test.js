/**
 * The contract guard itself (server/testUtils/contractCheck.js): a bad emit
 * is caught synchronously from its wire form, bot: targets and test markers
 * are skipped, and instrumenting is idempotent.
 */

const contractCheck = require('../../server/testUtils/contractCheck');

const card = { suit: 'hearts', rank: '2' };

afterEach(() => contractCheck.takeViolations());

test('a valid emit passes, a bad one is reported with event and path', () => {
    const log = contractCheck.instrument([]);
    log.push({ to: 'game:x', event: 'cardPlayed', data: { playerId: 'a', card, position: 1, trump: false } });
    expect(contractCheck.takeViolations()).toEqual([]);
    log.push({ to: 'game:x', event: 'cardPlayed', data: { playerId: 'a', card, position: 5, trump: 'no' } });
    const [v] = contractCheck.takeViolations();
    expect(v.event).toBe('cardPlayed');
    expect(v.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['$.position', '$.trump']));
    expect(log).toHaveLength(2);
});

test('payloads are checked in wire form at push time (live refs mutated later do not matter)', () => {
    const log = contractCheck.instrument([]);
    const data = { winner: 2 };
    log.push({ to: 'game:x', event: 'trickComplete', data });
    data.winner = 'garbage';
    expect(contractCheck.takeViolations()).toEqual([]);
    // undefined members vanish on the wire, as with socket.io
    log.push({ to: 'self:s', event: 'rejoinFailed', data: { reason: 'x', debug: undefined } });
    expect(contractCheck.takeViolations()).toEqual([]);
});

test('unknown and clientOnly events are violations; bot: targets and __markers are skipped', () => {
    const log = contractCheck.instrument([]);
    log.push({ to: 'self:s', event: 'noSuchEvent', data: {} });
    log.push({ to: 'self:s', event: 'roomFull', data: {} });
    log.push({ to: 'bot:Bot:1', event: 'noSuchEvent', data: {} });
    log.push({ to: 'db', event: '__marker' });
    const v = contractCheck.takeViolations();
    expect(v.map((x) => x.event)).toEqual(['noSuchEvent', 'roomFull']);
    expect(contractCheck.unknownEvents().has('noSuchEvent')).toBe(true);
});

test('no-payload events must emit nothing', () => {
    const log = contractCheck.instrument([]);
    log.push({ to: 'self:s', event: 'leftGame', data: undefined });
    expect(contractCheck.takeViolations()).toEqual([]);
    log.push({ to: 'self:s', event: 'leftGame', data: {} });
    expect(contractCheck.takeViolations()).toHaveLength(1);
});

test('instrument is idempotent', () => {
    const log = [];
    contractCheck.instrument(log);
    const push = log.push;
    contractCheck.instrument(log);
    expect(log.push).toBe(push);
    expect(Object.keys(log)).toEqual([]);
});
