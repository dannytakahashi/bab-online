/**
 * A seat picture slot of null (V1_REMOVALS #19 A): a custom picture the
 * server has no URL for (hostile or undecodable stored value, rendition
 * still pending, a full derive queue, AVATAR_PIPELINE=off, no sharp) shows
 * the neutral CUSTOM_FALLBACK, never stock avatar #1 (a real animal, so
 * somebody else's face) and never the picture the seat showed before (the
 * bot's after /active).
 *
 * The recorded live table events-bots-s12, seat 1, the real page and scene,
 * stopped on my open turn.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CUSTOM_FALLBACK, avatarSrc } from '../utils/avatar.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let log;
let seqGate;

const ME = 'ios_ann';
const STOCK_1 = avatarSrc(1);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  const rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: ME, socketId: 'ios-h1' });
  ({ getSeqGate: seqGate } = await import('../state/SeqGate.js'));
  const k = log.findIndex((e, i) => e.event === 'updateTurn' && e.data.currentTurn === 1 &&
    log.slice(0, i).some((p) => p.event === 'doneBidding'));
  expect(k).toBeGreaterThan(0);
  replay.replayLog(page, log, { to: k + 1 });
  replay.advance(3000);
});

afterAll(() => vi.useRealTimers());

const seq = () => seqGate().lastSeq + 1;
const myImg = () => document.querySelector('#player-avatar-container img');
const oppDom = (slot) => page.scene.opponentManager._avatarDoms[slot];
const oppImg = (slot) => oppDom(slot)?.querySelector('img');

describe('a null seat picture shows the neutral picture', () => {
  it('my own box after /active with pic null (no avatarUrl): not the bot\'s picture', () => {
    page.socket.fire('playerLazyMode', { position: 1, botUsername: '🤖 Zach', botPic: 7, originalUsername: ME, seq: seq() });
    expect(myImg().getAttribute('src')).toBe(avatarSrc(7));
    page.socket.fire('playerActiveMode', { position: 1, username: ME, pic: null, seq: seq() });
    expect(myImg().getAttribute('src')).toBe(CUSTOM_FALLBACK);
    // a full re-render agrees
    page.scene.render();
    expect(myImg().getAttribute('src')).toBe(CUSTOM_FALLBACK);
  });

  it('an opponent back from /lazy with pic null: neutral, not stock #1', () => {
    const owner = page.gameState.getPlayerNameByPosition(2);
    page.socket.fire('playerLazyMode', { position: 2, botUsername: 'Lazy Bot', botPic: 7, originalUsername: owner, seq: seq() });
    expect(oppImg('opp1').getAttribute('src')).toBe(avatarSrc(7));
    page.socket.fire('playerActiveMode', { position: 2, username: owner, pic: null, seq: seq() });
    expect(oppImg('opp1').getAttribute('src')).toBe(CUSTOM_FALLBACK);
    expect(oppImg('opp1').getAttribute('src')).not.toBe(STOCK_1);
  });

  it('a re-render of the avatars from playerData with a null slot (positionUpdate / gameStart shape)', () => {
    const pd = page.gameState.playerData;
    const i = pd.position.indexOf(4);
    const pics = [...pd.pics];
    pics[i] = null;
    page.gameState.setPlayerData({ ...pd, pics });
    page.scene.opponentManager.displayAvatars(page.gameState.playerData);
    expect(oppImg('opp2').getAttribute('src')).toBe(CUSTOM_FALLBACK);
    expect(oppDom('opp2').dataset.src).toBe(CUSTOM_FALLBACK);
  });

  it('avatars built fresh from a null slot (first sight)', () => {
    for (const slot of ['partner', 'opp1', 'opp2']) oppDom(slot)?.remove();
    page.scene.opponentManager._avatarDoms = {};
    document.getElementById('player-avatar-container')?.remove();
    page.scene._playerInfo = null;
    const pd = page.gameState.playerData;
    const pics = pd.pics.map(() => null);
    page.gameState.setPlayerData({ ...pd, pics });
    page.scene.opponentManager.displayAvatars(page.gameState.playerData);
    page.scene.createPlayerInfoBox(page.gameState.playerData, page.gameState.position);
    for (const slot of ['partner', 'opp1', 'opp2']) expect(oppImg(slot).getAttribute('src')).toBe(CUSTOM_FALLBACK);
    expect(myImg().getAttribute('src')).toBe(CUSTOM_FALLBACK);
  });

  it('a stock number still shows its animal', () => {
    page.socket.fire('playerActiveMode', { position: 2, username: page.gameState.getPlayerNameByPosition(2), pic: 9, seq: seq() });
    expect(oppImg('opp1').getAttribute('src')).toBe(avatarSrc(9));
  });
});
