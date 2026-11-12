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
    log.push({ to: 'game:x', event: 'cardPlayed', data: { card, position: 1, trumpBroken: false, seq: 1 } });
    expect(contractCheck.takeViolations()).toEqual([]);
    log.push({ to: 'game:x', event: 'cardPlayed', data: { card, position: 5, trumpBroken: 'no', seq: 2 } });
    const [v] = contractCheck.takeViolations();
    expect(v.event).toBe('cardPlayed');
    expect(v.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['$.position', '$.trumpBroken']));
    expect(log).toHaveLength(2);
});

test('payloads are checked in wire form at push time (live refs mutated later do not matter)', () => {
    const log = contractCheck.instrument([]);
    const data = { winner: 2, seq: 3 };
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

test('room broadcasts and gameStart need seq; private emits must not carry one', () => {
    const log = contractCheck.instrument([]);
    log.push({ to: 'game:x', event: 'updateTurn', data: { currentTurn: 1 } });
    log.push({ to: 's1', event: 'updateTurn', data: { currentTurn: 1, seq: 4 } });
    log.push({ to: 's1', event: 'updateTurn', data: { currentTurn: 1 } });
    log.push({ to: 'game:x', event: 'updateTurn', data: { currentTurn: 1, seq: 5 } });
    const v = contractCheck.takeViolations();
    expect(v.map((x) => x.to)).toEqual(['game:x', 's1']);
});

test('no-payload events must emit nothing', () => {
    const log = contractCheck.instrument([]);
    log.push({ to: 'self:s', event: 'leftGame', data: undefined });
    expect(contractCheck.takeViolations()).toEqual([]);
    log.push({ to: 'self:s', event: 'leftGame', data: {} });
    expect(contractCheck.takeViolations()).toHaveLength(1);
});

test('an event reaching a kind of target its schema `to` does not list is a violation', () => {
    const log = contractCheck.instrument([]);
    const snap = { snapshot: null, reason: 'not_in_game' };
    log.push({ to: 'self:s', event: 'stateSnapshot', data: snap });
    log.push({ to: 's', event: 'stateSnapshot', data: snap }); // io.to(socketId): still one client
    expect(contractCheck.takeViolations()).toEqual([]);
    log.push({ to: 'mainRoom', event: 'stateSnapshot', data: snap });
    log.push({ to: 'tournament:t', event: 'stateSnapshot', data: snap });
    log.push({ to: 'game:x', event: 'trickComplete', data: { winner: 2, seq: 1 } });
    log.push({ to: 'tournament:t', event: 'trickComplete', data: { winner: 2, seq: 2 } });
    log.push({ to: '*', event: 'mainRoomMessage', data: { username: 'a', message: 'm', timestamp: 1 } });
    const v = contractCheck.takeViolations();
    expect(v.map((x) => `${x.event}@${x.to}`)).toEqual(['stateSnapshot@mainRoom', 'stateSnapshot@tournament:t', 'trickComplete@tournament:t', 'mainRoomMessage@*']);
    expect(v[0].errors[0].message).toMatch(/schema allows self/);
});

test('stateSnapshot: a snapshot never comes with reason, and a null one always does', () => {
    const { validateS2C } = require('..');
    expect(validateS2C('stateSnapshot', { snapshot: null }).ok).toBe(false);
    expect(validateS2C('stateSnapshot', { snapshot: null, reason: 'not_in_game', requestId: 3 }).ok).toBe(true);
    expect(validateS2C('stateSnapshot', { snapshot: {}, reason: 'not_in_game' }).ok).toBe(false);
});

test('instrument is idempotent', () => {
    const log = [];
    contractCheck.instrument(log);
    const push = log.push;
    contractCheck.instrument(log);
    expect(log.push).toBe(push);
    expect(Object.keys(log)).toEqual([]);
});

test('seqCheck: a receiver gap, a split deal and an emit after the end are caught', () => {
    const { watchSeq } = require('../../server/testUtils/seqCheck');
    const io = { rooms: new Map([['game:g', new Set(['a', 'b'])]]) };
    const log = contractCheck.instrument([]);
    const room = (event, data) => log.push({ to: 'game:g', event, data });
    const start = (sid, seq) => log.push({ to: sid, event: 'gameStart', data: { gameId: 'g', seq } });

    const ok = watchSeq(io);
    room('trickComplete', { winner: 1, seq: 1 });
    start('a', 2);
    start('b', 2);
    room('updateTurn', { currentTurn: 1, seq: 3 });
    expect(ok.stop().failures).toEqual([]);

    const bad = watchSeq(io);
    room('trickComplete', { winner: 1, seq: 1 });
    start('a', 2);
    start('b', 3);                                  // one deal, two values
    room('updateTurn', { currentTurn: 1, seq: 5 }); // a gap for both receivers
    room('abortGame', { reason: 'x', seq: 6 });
    room('updateTurn', { currentTurn: 1, seq: 7 }); // after the end
    const why = bad.stop().failures.map((f) => f.why);
    expect(why).toEqual(expect.arrayContaining(['gameStarts of one deal differ', 'gap or repeat for a receiver', 'emit after terminal']));
    contractCheck.takeViolations(); // the synthetic gameStarts are not full payloads
});
