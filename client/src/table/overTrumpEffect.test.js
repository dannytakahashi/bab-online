/**
 * The OT effect on the real page and scene (events-bots-s12, seat 1): hand
 * 2 (trump spades) has the trick 3:6d 4:Qd 1:3s 2:As, where seat 2's ace
 * over-trumps my 3 (rules/overTrump.js). The effect shows exactly once, on
 * that cardPlayed: never for the cards before it, never again on a render,
 * a relayout, a tab-return fast-forward, a snapshot resync or a repeated
 * (already applied) cardPlayed. My own play shows nothing until the server
 * confirms it.
 *
 * The partner case on the same trick is overTrumpPartner.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;
let impacts;

const card = (e) => `${e.data.position}:${e.data.card.rank}${e.data.card.suit[0]}`;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

/** The OT trick's four cardPlayed indexes. */
function otTrick() {
  const i = log.findIndex((e) => e.event === 'cardPlayed' && card(e) === '2:As' && e.data.seq === 209);
  expect(i).toBeGreaterThan(0);
  const plays = [];
  for (let k = i; plays.length < 4; k--) if (log[k].event === 'cardPlayed') plays.unshift(k);
  expect(plays.map((k) => card(log[k]))).toEqual(['3:6d', '4:Qd', '1:3s', '2:As']);
  return plays;
}

const ots = () => impacts.mock.calls.filter((c) => c[0] === 'ot').length;

describe('the OT effect fires once, from the server\'s cardPlayed', () => {
  it('no OT anywhere before the trick; my own 3 of spades (a ruff) shows none, pending or confirmed', () => {
    const plays = otTrick();
    impacts = vi.spyOn(page.scene.effectsManager, 'showImpactEvent');
    replay.replayLog(page, log, { to: plays[2] });
    replay.advance(200);
    expect(ots()).toBe(0);

    // my turn: click the 3 of spades (pending, not in the trick yet)
    expect(page.gameState.currentTurn).toBe(1);
    const sprite = page.scene.cardManager.getHandSprites().find((s) => {
      const c = s.getData('card');
      return c.suit === 'spades' && c.rank === '3';
    });
    expect(sprite).toBeTruthy();
    sprite.emit('pointerdown');
    replay.advance(100);
    expect(page.socket.emitted('playCard')).toHaveLength(1);
    expect(page.gameState.currentTrick).toHaveLength(2);
    expect(ots()).toBe(0);

    // the server's echo of my ruff (the first trump of the trick)
    replay.replayLog(page, log, { from: plays[2], to: plays[3] });
    expect(page.gameState.currentTrick).toHaveLength(3);
    expect(ots()).toBe(0);
  });

  it('the opponent\'s ace over my 3: one OT', () => {
    const plays = otTrick();
    replay.replayLog(page, log, { from: plays[3], to: plays[3] + 1 });
    expect(ots()).toBe(1);
  });

  it('a render, a relayout, a fast-forward, a repeated cardPlayed and a snapshot resync show no second OT', () => {
    const plays = otTrick();
    page.scene.render();
    page.scene.relayout();
    page.scene.director.fastForward('visible');
    // the same cardPlayed again (seq already applied: the gate drops it)
    page.socket.fire('cardPlayed', JSON.parse(JSON.stringify(log[plays[3]].data)));
    // a ping reply: the server's table now (the recording's checkpoint at my
    // turn, plus my 3 and the ace: TRICK_RESOLVING, 4 cards on the table)
    const cp = rec.checkpoints.filter((c) => c.viewer === 'seat1' && c.afterIndex <= plays[2]).pop();
    expect(cp.snapshot.trick.cards).toHaveLength(2);
    const snap = JSON.parse(JSON.stringify(cp.snapshot));
    snap.seq = log[plays[3]].data.seq;
    snap.stage = 'TRICK_RESOLVING';
    snap.turn = null;
    snap.hand = snap.hand.filter((c) => !(c.suit === 'spades' && c.rank === '3'));
    snap.trick.cards.push({ position: 1, card: { suit: 'spades', rank: '3' } }, { position: 2, card: { suit: 'spades', rank: 'A' } });
    for (const seat of snap.seats) if (seat.position <= 2) seat.cardsInHand -= 1;
    page.socket.fire('stateSnapshot', { snapshot: snap, requestId: 'ping-1' });
    replay.advance(300);
    expect(page.scene.tableCounts().trick).toBe(4);
    expect(page.gameState.currentTrick).toHaveLength(4);
    expect(ots()).toBe(1);
  });

  it('the rest of the game (with the old rule\'s same answers there) shows no other OT', () => {
    const plays = otTrick();
    replay.replayLog(page, log, { from: plays[3] + 1 });
    replay.advance(500);
    expect(ots()).toBe(1);
  });
});
