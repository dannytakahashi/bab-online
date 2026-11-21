/**
 * The Tutorial button's slot follows my role on the real page and scene
 * (owner 2026-11-21: one more round control in my seat's row, only while I
 * play my own seat). The recorded live table events-bots-s12, seat 1,
 * stopped on my open turn: my row is 4 buttons wide with the button after
 * the sound toggle; /lazy (a bot plays my seat) relays the table out exactly
 * as before the button existed (no slot, no button); /active brings both
 * back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let log;
let seqGate;
let computeTableLayout;

const ME = 'ios_ann';

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  const rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: ME, socketId: 'ios-h1' });
  ({ getSeqGate: seqGate } = await import('../state/SeqGate.js'));
  ({ computeTableLayout } = await import('../phaser/layout/computeTableLayout.js'));
  const k = log.findIndex((e, i) => e.event === 'updateTurn' && e.data.currentTurn === 1 &&
    log.slice(0, i).some((p) => p.event === 'doneBidding'));
  expect(k).toBeGreaterThan(0);
  replay.replayLog(page, log, { to: k + 1 });
  replay.advance(3000);
});

afterAll(() => vi.useRealTimers());

const seq = () => seqGate().lastSeq + 1;
const btn = () => document.getElementById('tutorial-toggle-btn');
const row = () => [...document.querySelectorAll('#table-hud > .hud-voice > button')].map((b) => b.id || b.className);
const without = (L) => computeTableLayout({ w: L.w, h: L.h, dpr: L.dpr, isSpectator: false, logW: L.logW });

describe('the Tutorial button\'s slot follows my role', () => {
  it('my own seat: a 4-button row, the button right after the sound toggle', () => {
    const L = page.scene.getLayout();
    expect(L.voice.tutorial).toBe(true);
    expect(L.voice.rect.w).toBeCloseTo(4 * L.voice.button + 3 * L.voice.gap, 5);
    expect(row().slice(0, 2)).toEqual(['sound-toggle-btn', 'tutorial-toggle-btn']);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
  });

  it('/lazy: today\'s table exactly (no slot), and no button', () => {
    page.socket.fire('playerLazyMode', { position: 1, botUsername: '🤖 Zach', botPic: 7, originalUsername: ME, seq: seq() });
    replay.advance(500);
    const L = page.scene.getLayout();
    expect(L.voice.tutorial).toBeUndefined();
    expect(L).toEqual(without(L));
    expect(btn()).toBeNull();
    expect(row()).not.toContain('tutorial-toggle-btn');
  });

  it('/active: the slot and the button come back', () => {
    page.socket.fire('playerActiveMode', { position: 1, username: ME, pic: 3, seq: seq() });
    replay.advance(500);
    expect(page.scene.getLayout().voice.tutorial).toBe(true);
    expect(row().slice(0, 2)).toEqual(['sound-toggle-btn', 'tutorial-toggle-btn']);
  });
});
