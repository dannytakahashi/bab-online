/**
 * The real page (main.js) reports client errors (telemetry/clientErrors.js):
 * an uncaught error on the window, a seq gap at the table and an illegal
 * screen move each send ONE clientError on the connected socket, with the
 * build and the current screen; a reconnected socket gets what was reported
 * while it was down.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tick } from '../testing/fakePage.js';
import { FLUSH_DELAY_MS } from '../telemetry/clientErrors.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

describe('client error reports from the page', () => {
  it('an uncaught error on the window goes out once, with the build and the screen', async () => {
    const err = new TypeError('boom');
    window.dispatchEvent(new ErrorEvent('error', { error: err, message: 'boom', filename: 'https://babonline.invalid/dist/assets/main-x.js', lineno: 1, colno: 5 }));
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('second'), message: 'second', filename: 'main-x.js' }));
    await tick();
    const reports = socket.emitted('clientError');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'error', message: 'TypeError: boom', where: 'main-x.js:1:5', build: expect.any(String) });
    expect(typeof reports[0].page).toBe('string');
  });

  it('a seq gap at the table is reported once (SeqGate)', async () => {
    const { getSeqGate } = await import('../state/SeqGate.js');
    const gate = getSeqGate();
    gate.admit('bidReceived', { seq: 1 }, () => {});
    gate.admit('bidReceived', { seq: 5 }, () => {});
    gate.admit('bidReceived', { seq: 9 }, () => {});
    const gaps = socket.emitted('clientError').filter((r) => r.kind === 'seqGap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].message).toMatch(/expected \d+, got \d+/);
  });

  it('reports made while disconnected go out after the reconnect (after the restore)', async () => {
    vi.useFakeTimers();
    try {
      socket.connected = false;
      const { getClientSession } = await import('../state/ClientSession.js');
      const session = getClientSession();
      const strict = session._strict;
      session._strict = false; // the page's production behaviour: log, report, fail closed
      try {
        session.transition('NOT_A_SCREEN');
      } finally {
        session._strict = strict;
      }
      expect(socket.emitted('clientError').filter((r) => r.kind === 'screen')).toEqual([]);
      socket.reconnect('sock-2');
      vi.advanceTimersByTime(FLUSH_DELAY_MS);
      const screen = socket.emitted('clientError').filter((r) => r.kind === 'screen');
      expect(screen).toHaveLength(1);
      expect(screen[0].message).toMatch(/unknown screen/);
    } finally {
      vi.useRealTimers();
    }
  });
});
