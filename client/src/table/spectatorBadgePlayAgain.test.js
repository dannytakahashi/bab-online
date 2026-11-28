/**
 * Who is watching after a play-again return (owner play test 2026-11-17: a
 * family lobby of 5; the seats of the next game saw no spectator eye until
 * a reload). The real page is fed what the server sent two of the sockets
 * (contract/fixtures/web/play-again-eye.json, recorded by server/socket/
 * __tests__/playAgain.test.js "who is watching at the next game";
 * UPDATE_WEB_FIXTURES=1 rewrites it):
 * game 1 with E watching, Return to Lobby on the score modal, game 2 with
 * A watching. The extra's spectatorsUpdated reaches the seats once, on the
 * lobby screen, before startDraw; the table's entry must draw it from the
 * state (main.js, the TABLE screen's enter hook).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const ROOT = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');
const rec = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/web/play-again-eye.json'), 'utf8'));

const slot = () => document.querySelector('#table-hud > .hud-spectators');
const badge = () => (slot() ? { shown: !slot().hidden, count: slot().querySelector('.spectator-badge__count').textContent } : null);
const listed = () => [...(slot()?.querySelectorAll('.spectator-popover__name') || [])].map((el) => el.textContent);

/**
 * Feed `who`'s stream to a fresh page, clicking Return to Lobby at the
 * marker. Returns the badge seen right after each event of `at`, per game.
 */
async function replayViewer(who, at) {
  vi.resetModules();
  document.body.innerHTML = '';
  const replay = await import('../testing/replay.js');
  const page = await replay.realTablePage({ username: rec.ids[who].username, socketId: rec.ids[who].id });
  const seen = [];
  let game = 1;
  let lastT = rec.logs[who][0].t;
  try {
    for (const e of rec.logs[who]) {
      if (e.t > lastT) replay.advance(e.t - lastT);
      lastT = e.t;
      if (e.dir === 'c2s') {
        if (e.event === 'RETURN') {
          const btn = [...document.querySelectorAll('#finalScoreOverlay .kit-modal__actions button')].find((b) => /lobby/i.test(b.textContent));
          expect(btn, 'the score modal offers Return to Lobby').toBeTruthy();
          btn.click();
          replay.advance(100);
          seen.push({ game, event: 'RETURN', screen: page.session.screen, badge: badge() });
          game = 2;
        }
        continue;
      }
      page.socket.fire(e.event, e.data === undefined ? undefined : JSON.parse(JSON.stringify(e.data)));
      if (at.includes(e.event)) seen.push({ game, event: e.event, screen: page.session.screen, badge: badge(), listed: listed() });
    }
    replay.advance(3000);
    seen.push({ game, event: 'end', screen: page.session.screen, badge: badge(), listed: listed(), specX: document.getElementById('table-hud')?.style.getPropertyValue('--spec-x') });
  } finally {
    vi.useRealTimers();
  }
  return seen;
}

const AT = ['spectatorsUpdated', 'startDraw', 'createUI', 'gameStart'];
const shown1 = { shown: true, count: '1' };

describe('the spectator eye after a play-again return', () => {
  it('a seat in both games (B): the extra\'s list, sent on the lobby screen, is drawn from startDraw on in each game', async () => {
    const seen = await replayViewer('B', AT);
    const a = rec.ids.A.username;
    const e = rec.ids.E.username;
    for (const game of [1, 2]) {
      const rows = seen.filter((s) => s.game === game);
      // the list lands before the table, on the lobby screen
      const update = rows.find((s) => s.event === 'spectatorsUpdated');
      expect(update.screen).toBe('lobby');
      expect(update.badge).toBeNull();
      for (const ev of ['startDraw', 'createUI', 'gameStart']) {
        const row = rows.find((s) => s.event === ev);
        expect(row.screen, `game ${game} ${ev}`).toBe('table');
        expect(row.badge, `game ${game} ${ev}`).toEqual(shown1);
        expect(row.listed).toEqual([game === 1 ? e : a]);
      }
    }
    // Return to Lobby takes game 1's badge down; game 2 shows its own list
    expect(seen.find((s) => s.event === 'RETURN')).toMatchObject({ screen: 'lobby', badge: null });
    const end = seen.at(-1);
    expect(end).toMatchObject({ game: 2, screen: 'table', badge: shown1, listed: [a] });
    // placed by the table's layout, not left at the HUD's default spot
    expect(end.specX).toMatch(/px$/);
  });

  it('the extra of game 1 (E) sees itself watching; seated in game 2 it sees the new extra (the owner\'s report)', async () => {
    const seen = await replayViewer('E', ['spectatorJoined', ...AT]);
    const a = rec.ids.A.username;
    const e = rec.ids.E.username;
    const joined = seen.find((s) => s.game === 1 && s.event === 'spectatorJoined');
    expect(joined).toMatchObject({ screen: 'table', badge: shown1, listed: [`${e} (you)`] });
    for (const ev of ['startDraw', 'gameStart']) {
      expect(seen.find((s) => s.game === 1 && s.event === ev).badge, `game 1 ${ev}`).toEqual(shown1);
    }
    for (const ev of ['startDraw', 'createUI', 'gameStart']) {
      const row = seen.find((s) => s.game === 2 && s.event === ev);
      expect(row.screen, `game 2 ${ev}`).toBe('table');
      expect(row.badge, `game 2 ${ev}`).toEqual(shown1);
      expect(row.listed).toEqual([a]);
    }
    expect(seen.at(-1)).toMatchObject({ game: 2, screen: 'table', badge: shown1, listed: [a] });
  });
});
