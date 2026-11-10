/**
 * The seq gate and my acked actions on a recorded live table
 * (events-bots-s12, seat 1, the real page and scene):
 *
 *   - a seq gap buffers the event, sends requestSnapshot (log and custom
 *     pictures left out), and the reply's snapshot plus the buffered event
 *     give exactly the table the server had after it;
 *   - actionRejected puts the played card back in the hand (its snapshot);
 *   - an unanswered play asks for a snapshot after 5 s and reconciles from
 *     it: back in the hand if the server does not have it, in the trick if
 *     it does; a second silence reconnects instead of rolling back blindly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;
let cps;
let myAction;
let seqGate;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  cps = new Map(rec.checkpoints.filter((c) => c.viewer === 'seat1').map((c) => [c.afterIndex, c.snapshot]));
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  ({ getMyAction: myAction } = await import('../state/MyAction.js'));
  ({ getSeqGate: seqGate } = await import('../state/SeqGate.js'));
});

afterAll(() => vi.useRealTimers());

const sameCard = (a, b) => a.suit === b.suit && a.rank === b.rank;
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Click the hand sprite of `card` (CardManager's pointerdown). */
function clickCard(card) {
  const sprite = page.scene.cardManager.getHandSprites().find((s) => sameCard(s.getData('card'), card));
  expect(sprite, 'card in the hand').toBeTruthy();
  sprite.emit('pointerdown');
}

describe('seq gap → requestSnapshot → snapshot + replay', () => {
  it('a lost cardPlayed: the next broadcast is buffered, the snapshot resyncs, my turn opens', () => {
    // a cardPlayed (k), then the updateTurn to me (k + 1), then my play (k + 2,
    // with the server's checkpoint right before it)
    const k = log.findIndex((e, i) => e.event === 'cardPlayed' && log[i + 1]?.event === 'updateTurn' &&
      log[i + 1].data.seq === e.data.seq + 1 && log[i + 1].data.currentTurn === 1 && cps.get(i + 2)?.stage === 'PLAYING');
    expect(k).toBeGreaterThan(0);
    replay.replayLog(page, log, { to: k });
    replay.advance(1500);
    page.socket.clearEmits();
    const before = replay.liveCounts(page.scene);

    // entry k is lost on the way: k + 1 arrives with seq + 2
    page.socket.fire(log[k + 1].event, clone(log[k + 1].data));
    expect(seqGate().buffered).toBe(1);
    expect(page.gameState.currentTurn).not.toBe(1); // not applied
    expect(replay.liveCounts(page.scene)).toEqual(before);
    const asked = page.socket.emitted('requestSnapshot');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ requestId: 'gap-1', log: false, customPics: false });

    // the reply: the server's table after k + 1
    snapAtTurn = clone(cps.get(k + 2));
    expect(snapAtTurn.seq).toBe(log[k + 1].data.seq);
    page.socket.fire('stateSnapshot', { snapshot: clone(snapAtTurn), requestId: 'gap-1' });
    replay.advance(1500);
    expect(seqGate().buffered).toBe(0);
    expect(seqGate().lastSeq).toBe(log[k + 1].data.seq);
    expect(page.gameState.currentTurn).toBe(1);
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(snapAtTurn));
    // the lost card is on the table (from the snapshot)
    expect(page.scene.tableCounts().trick).toBe(before.trick + 1);
    // a late copy of the lost event is stale now
    page.socket.fire(log[k].event, clone(log[k].data));
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(snapAtTurn));
    turnAt = k + 2;
    card = log[turnAt].data.card;
    expect(log[turnAt].event).toBe('playCard');
  });
});

let turnAt;
let snapAtTurn;
let card;

describe('my play: rejected, timed out, reconciled', () => {
  it('a click sends the play and flies the card in; actionRejected puts it back in the hand', () => {
    page.socket.clearEmits();
    const handBefore = page.scene.tableCounts().hand;
    const trickBefore = page.scene.tableCounts().trick;
    clickCard(card);
    expect(page.socket.emitted('playCard')).toEqual([{ card, position: 1 }]);
    expect(myAction().state).toBe('pending');
    expect(page.scene.tableCounts()).toMatchObject({ hand: handBefore - 1, trick: trickBefore + 1 });
    // GameState still holds it: only the echo takes it out
    expect(page.gameState.myCards.some((c) => sameCard(c, card))).toBe(true);
    clickCard(page.scene.cardManager.getHandSprites()[0].getData('card'));
    expect(page.socket.emitted('playCard')).toHaveLength(1);

    replay.advance(100);
    const rejected = clone(snapAtTurn);
    rejected.partial = ['customPics', 'log'];
    rejected.log = [];
    const rows = replay.logRows();
    page.socket.fire('actionRejected', { action: 'play', reason: 'not_your_turn', snapshot: rejected });
    replay.advance(50);
    expect(myAction().state).toBe('idle');
    expect(myAction().history.at(-1)).toMatchObject({ outcome: 'rolledBack', via: 'rejected' });
    expect(page.scene.tableCounts()).toMatchObject({ hand: handBefore, trick: trickBefore });
    expect(page.scene.cardManager.getHandSprites().some((s) => sameCard(s.getData('card'), card))).toBe(true);
    // the log is kept (partial 'log'); the card is playable again
    expect(replay.logRows()).toBe(rows);
    expect(page.scene.cardManager.getHandSprites().find((s) => sameCard(s.getData('card'), card)).getData('isLegal')).toBe(true);
  });

  it('no answer for 5 s: a snapshot is asked for; it shows the card not taken, so it returns', () => {
    page.socket.clearEmits();
    const handBefore = page.scene.tableCounts().hand;
    clickCard(card);
    replay.advance(4900);
    expect(page.socket.emitted('requestSnapshot')).toEqual([]);
    replay.advance(200);
    const asked = page.socket.emitted('requestSnapshot');
    expect(asked).toHaveLength(1);
    expect(asked[0].requestId).toMatch(/^ack-/);
    // still pending while the answer is out: nothing rolled back blindly
    expect(myAction().state).toBe('pending');
    expect(page.scene.tableCounts().hand).toBe(handBefore - 1);
    page.socket.fire('stateSnapshot', { snapshot: clone(snapAtTurn), requestId: asked[0].requestId });
    replay.advance(50);
    expect(myAction().state).toBe('idle');
    expect(myAction().history.at(-1)).toMatchObject({ outcome: 'rolledBack', via: 'ack' });
    expect(page.scene.tableCounts().hand).toBe(handBefore);
  });

  it('…and when the snapshot has it in the trick, it was accepted: it stays played', () => {
    page.socket.clearEmits();
    const handBefore = page.scene.tableCounts().hand;
    const trickBefore = page.scene.tableCounts().trick;
    clickCard(card);
    replay.advance(5100);
    const [{ requestId }] = page.socket.emitted('requestSnapshot');
    const accepted = clone(snapAtTurn);
    accepted.hand = accepted.hand.filter((c) => !sameCard(c, card));
    accepted.trick.cards.push({ position: 1, card });
    accepted.seats[0].cardsInHand -= 1;
    accepted.turn = null;
    accepted.viewer.canAct = false;
    page.socket.fire('stateSnapshot', { snapshot: accepted, requestId });
    replay.advance(50);
    expect(myAction().history.at(-1)).toMatchObject({ outcome: 'confirmed', via: 'ack' });
    expect(page.scene.tableCounts()).toMatchObject({ hand: handBefore - 1, trick: trickBefore + 1 });
    expect(page.gameState.myCards.some((c) => sameCard(c, card))).toBe(false);
  });

  it('two silences in a row reconnect (the rejoin snapshot decides), never a blind rollback', () => {
    // back to the turn (the server's table before the play)
    page.socket.fire('stateSnapshot', { snapshot: clone(snapAtTurn), requestId: 'x' });
    replay.advance(50);
    page.socket.clearEmits();
    page.socket.disconnect.mockClear();
    const handBefore = page.scene.tableCounts().hand;
    clickCard(card);
    replay.advance(5100);
    expect(page.socket.emitted('requestSnapshot')).toHaveLength(1);
    replay.advance(5100);
    expect(page.socket.disconnect).toHaveBeenCalled();
    expect(myAction().state).toBe('pending');
    expect(page.scene.tableCounts().hand).toBe(handBefore - 1);
    // the reconnect's rejoin brings the truth: not taken
    page.socket.reconnect('ios-h1-r9');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', { gameId: rec.gameId, snapshot: clone(snapAtTurn) });
    replay.advance(50);
    expect(myAction().state).toBe('idle');
    expect(myAction().history.at(-1)).toMatchObject({ outcome: 'rolledBack', via: 'rejoin' });
    expect(page.scene.tableCounts().hand).toBe(handBefore);
  });
});
