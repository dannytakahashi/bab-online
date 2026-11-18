/**
 * The draw for deal always opens on the bare felt (owner play test
 * 2026-11-17: the table behind a second game's draw). Whatever table DOM a
 * page still had when the room's startDraw came (the play zone's rail, the
 * log's column with no log in it), a seat's draw shows none of it: the
 * play zone and the log come with the deal (createUI / gameStart).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setTableChrome } from '../ui/tableHud.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;

const drawHud = () => document.querySelector('#table-hud > .hud-draw');
const logColumnOn = () => !!document.getElementById('game-container')?.classList.contains('in-game');

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  page = await replay.realTablePage({ username: 'oli' });
});

afterAll(() => vi.useRealTimers());

describe('a seat\'s startDraw with table DOM still up', () => {
  it('the play zone and the empty log column go; the draw is mine to pick', () => {
    page.scene.layoutManager.createDomBackgrounds({ skipHandArea: false });
    setTableChrome(true);
    expect(document.getElementById('playZoneDom')).toBeTruthy();
    expect(document.getElementById('gameFeed')).toBeNull();
    expect(logColumnOn()).toBe(true);

    page.socket.fire('startDraw', { start: true });
    replay.advance(50);
    expect(page.session.role).toBe('player');
    expect(drawHud()).toBeTruthy();
    expect(drawHud().classList.contains('is-spectator')).toBe(false);
    expect(document.getElementById('playZoneDom')).toBeNull();
    expect(logColumnOn()).toBe(false);
  });
});
