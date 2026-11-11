/**
 * The real handlers' spectator chat (contract/fixtures/web/spectator-chat.json,
 * recorded by server/socket/__tests__/spectatorChat.test.js: a fan who chats
 * as it joins, before the coalesced list; a second spectator; a player; a
 * seat-view lazy owner; a watching owner) replayed in order into a real
 * table page at seat 1 (events-bots-s14's rejoin): after each event, where
 * the bubbles are. The room's events keep their order; only the seq (the
 * page's next) and the gameId (the page's game) are the page's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const ROOT = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');
const RECORDING = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/web/spectator-chat.json'), 'utf8'));

let page;
let replay;
let rec;
let gate;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  gate = (await import('../state/SeqGate.js')).getSeqGate();
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
  page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data)));
  replay.advance(100);
});

afterAll(() => vi.useRealTimers());

const badgeText = () => [...document.querySelectorAll('#table-hud > .hud-spectator-bubble > .chat-bubble')].map((b) => b.textContent);
const seatText = (key) => document.querySelector(`#table-hud > .hud-seat[data-seat="${key}"] .chat-bubble:not(.bid)`)?.textContent ?? null;
const badgeShown = () => {
  const b = document.querySelector('#table-hud > .hud-spectators');
  return !!b && !b.hidden;
};

function fire({ event, data }) {
  const payload = JSON.parse(JSON.stringify(data));
  if (event === 'spectatorsUpdated') page.socket.fire(event, { gameId: rec.gameId, ...payload });
  else page.socket.fire(event, { ...payload, seq: gate.lastSeq + 1 });
  replay.advance(50);
}

describe('the recorded spectator chat, replayed at seat 1', () => {
  it('each message lands where it belongs, one badge bubble at a time', () => {
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [], count: 0 });
    const room = RECORDING.room;
    expect(room.map((e) => e.event)).toEqual(['chatMessage', 'spectatorsUpdated', 'spectatorsUpdated', 'chatMessage', 'chatMessage', 'chatMessage', 'chatMessage']);

    // the fan, before the list: by the (still hidden) badge's laid-out spot
    fire(room[0]);
    expect(badgeShown()).toBe(false);
    expect(badgeText()).toEqual(['fan: hello']);
    expect(document.querySelector('#table-hud > .hud-spectator-bubble').hidden).toBe(false);
    // the list lands: the badge under it
    fire(room[1]);
    expect(badgeShown()).toBe(true);
    expect(badgeText()).toEqual(['fan: hello']);
    fire(room[2]);
    // the second spectator replaces it
    fire(room[3]);
    expect(badgeText()).toEqual(['kim: me too']);
    // seat 1 is me; seat 2 (a seat-view lazy owner) is my left opponent: over the seats
    fire(room[4]);
    expect(seatText('self')).toBe('gl');
    fire(room[5]);
    expect(seatText('opp1')).toBe('brb');
    expect(badgeText()).toEqual(['kim: me too']);
    // the watching owner: spectator-shaped, by the badge with its name
    fire(room[6]);
    expect(badgeText()).toEqual(['user4: watching my bot']);
    // every line is in the log too
    const log = [...document.querySelectorAll('#gameFeedMessages .log-row__text')].map((n) => n.textContent).join('\n');
    for (const t of ['fan: hello', 'kim: me too', 'user1: gl', 'user2: brb', 'user4: watching my bot']) expect(log).toContain(t);
    // and it goes as a seat's does
    replay.advance(6000);
    expect(badgeText()).toEqual([]);
  });
});
