/**
 * Test harness: which card backs a real scene shows (the back alternates
 * red and blue by hand: cards/cardFaces.js backFrameForHand), for the
 * table/backColour*.test.js files.
 */
import { replayLog, advance } from './replay.js';

/** The colour hand `handNo` must show (independent of the code under test). */
export const wantBack = (handNo) => (handNo >= 1 && handNo % 2 === 0 ? 'back-blue' : 'back-red');

/** Every back on the table now, all and by where it is. */
export function backs(scene) {
  const frame = (s) => (s && s.active !== false && s.texture?.key === 'cards' && /^back-/.test(s.frame?.name || '') ? s.frame.name : null);
  const of = (list) => list.map(frame).filter(Boolean);
  const om = scene.opponentManager;
  const tm = scene.trickManager;
  const all = of(scene.liveObjects());
  const atlas = scene.textures?.get?.('cards')?.frames || {};
  return {
    all,
    // a back whose frame the atlas does not hold (Phaser would draw its missing texture)
    missing: all.filter((f) => !atlas[f]),
    fans: of(Object.values(om?._cardSprites || {}).flat()),
    deck: of(scene.drawManager?.allCards || []),
    stacks: of([...(tm?._teamTrickHistory || []), ...(tm?._oppTrickHistory || [])].flatMap((t) => t.cards)),
    trump: of([scene.tableCardSprite]),
  };
}

/** A scene settled on its table: no deal waiting for the whisk, nothing whisking away. */
export const settled = (scene) => scene.director.waiting === 0 && !(scene.trickManager?.spriteCounts().whisking > 0);

/**
 * Replay a viewer's log; just before each entry, when the table is settled
 * and shows a back, note the backs with GameState's hand number.
 * @returns {Array<{handNo, stage, all, fans, deck, stacks, trump}>}
 */
export function replayNotingBacks(page, log, { from = 0 } = {}) {
  const seen = [];
  replayLog(page, log, {
    from,
    before: () => {
      if (!settled(page.scene)) return;
      const b = backs(page.scene);
      if (b.all.length) seen.push({ handNo: page.gameState.handNo, stage: page.gameState.stage, ...b });
    },
  });
  return seen;
}

/**
 * Replay a viewer's log sampling the table every `slice` ms from each
 * handComplete until the next deal is on the table (settled again): the
 * finished hand's tricks whisking into its trump, which flips face down.
 * The next hand's gameStart usually arrives in the same tick as the
 * handComplete (GameState.handNo moves on at once), so this is where a back
 * drawn from GameState's hand would take the next hand's colour early.
 * @returns {Array<{finished, handNo, all, trump, stacks, whisking}>}
 */
export function replayNotingWhiskBacks(page, log, { slice = 25 } = {}) {
  const seen = [];
  let finished = null; // the hand being whisked away, from its handComplete
  const sample = () => {
    if (finished == null) return;
    if (settled(page.scene)) { finished = null; return; }
    const b = backs(page.scene);
    const whisking = page.scene.trickManager?.spriteCounts().whisking || 0;
    seen.push({ finished, handNo: page.gameState.handNo, whisking, ...b });
  };
  let lastT = log[0]?.t ?? 0;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    for (let left = e.t - lastT; left > 0; left -= slice) {
      advance(Math.min(slice, left));
      sample();
    }
    lastT = e.t;
    if (e.dir !== 's2c') continue;
    if (e.event === 'handComplete') finished = page.gameState.handNo;
    page.socket.fire(e.event, JSON.parse(JSON.stringify(e.data)));
    sample();
  }
  return seen;
}
