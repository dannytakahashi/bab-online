/**
 * Test harness: which card backs a real scene shows (the back alternates
 * red and blue by hand: cards/cardFaces.js backFrameForHand), for the
 * table/backColour*.test.js files.
 */
import { replayLog } from './replay.js';

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
