/**
 * A reload (rejoinSuccess) after set hands, on the real page and scene,
 * from the recorded game events-bots-s14 (seat1-rejoin: a 1-human + 3-bot
 * game whose server already writes the fault lines, 2026-11-19): every
 * snapshot log item with `fault` is drawn red, once, right after its hand's
 * two team lines (bots named as the server names them); a live gameLogEntry
 * with fault adds one red row; a later replay draws the server's rows again
 * (no duplicate). The snapshot's viewer.assist gives the chat autocomplete
 * the exact /help count ("(2 of 3 free used)") instead of the
 * unknown-count text. The recording is a game with native bot seats, so
 * there /help shows no count at all ("Ask a bot for advice", owner
 * 2026-11-19); the count tests rewrite the bots' seats as human ones (the
 * same snapshot of a game without a native bot seat).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

/**
 * The recorded rejoin, with the viewer's /help count set to `assist` (null:
 * none, an older server; 'recorded': as the server sent it) and, unless
 * `bots`, its native bot seats rewritten as human seats.
 */
function rejoinWith({ assist = { uses: 2, freeUses: 3, assisted: false }, bots = false } = {}) {
  const rejoin = JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data));
  if (assist === null) delete rejoin.snapshot.viewer.assist;
  else if (assist !== 'recorded') rejoin.snapshot.viewer.assist = assist;
  if (!bots) {
    for (const st of rejoin.snapshot.seats) if (st.controller === 'bot') st.controller = 'human';
  }
  return rejoin;
}
const storedFaults = () => rec.logs['seat1-rejoin'][0].data.snapshot.log.filter((e) => e.fault).map((e) => e.message);

/** The socket drops and comes back, then the rejoin (as the page sees a reconnect). */
let n = 1;
function reconnectWith(data) {
  n++;
  page.socket.reconnect(`ios-h1-r${n}`);
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
  page.socket.fire('rejoinSuccess', data);
  replay.advance(100);
}

const redText = () => [...document.querySelectorAll('#gameFeedMessages .log-row.is-fault .log-row__text')].map((r) => r.textContent);
const helpText = () => {
  const input = document.getElementById('chatInput');
  input.value = '/he';
  input.dispatchEvent(new Event('input'));
  const item = [...document.querySelectorAll('.slash-item')].find((el) => el.querySelector('.slash-item__cmd')?.textContent === '/help');
  return item?.querySelector('.slash-item__desc').textContent;
};

describe('a reload after set hands', () => {
  it('the stored fault lines are red, each once, after their hand\'s team lines; /help says the exact count', () => {
    expect(storedFaults().length).toBeGreaterThan(1);
    expect(storedFaults().some((m) => m.startsWith('Fault: 🤖 '))).toBe(true);
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', rejoinWith());
    replay.advance(100);
    expect(redText()).toEqual(storedFaults());
    for (const row of document.querySelectorAll('#gameFeedMessages .log-row.is-fault')) {
      let prev = row.previousElementSibling;
      while (prev?.classList.contains('is-fault')) prev = prev.previousElementSibling;
      expect(prev?.previousElementSibling?.previousElementSibling?.textContent).toContain('--- HAND COMPLETE ---');
    }
    // the snapshot's viewer.assist: exact, not "after 3 free ..."
    expect(helpText()).toBe('Ask a bot for advice (2 of 3 free used)');
  });

  it('a live fault line adds one red row; a later replay shows the server\'s rows once', () => {
    page.socket.fire('gameLogEntry', { message: 'Fault: 🤖 Mary (bid 2, took 0)', type: 'system', fault: { position: 2, bid: 2, took: 0 } });
    replay.advance(50);
    expect(redText()).toEqual([...storedFaults(), 'Fault: 🤖 Mary (bid 2, took 0)']);
    reconnectWith(rejoinWith({ assist: { uses: 3, freeUses: 3, assisted: false } }));
    expect(redText()).toEqual(storedFaults());
    expect(helpText()).toBe('Ask a bot for advice (the next one makes this game bot-assisted)');
  });

  it('a snapshot without viewer.assist (an older server) keeps the count it had', () => {
    reconnectWith(rejoinWith({ assist: null }));
    expect(redText()).toEqual(storedFaults());
    expect(helpText()).toBe('Ask a bot for advice (the next one makes this game bot-assisted)');
  });

  it('the recorded game has native bot seats: /help names no count, from the snapshot, or the seats before the server has said', async () => {
    const recorded = rec.logs['seat1-rejoin'][0].data.snapshot;
    expect(recorded.seats.filter((st) => st.controller === 'bot')).toHaveLength(3);
    expect(recorded.viewer.assist).toMatchObject({ unlimited: true });
    expect(helpText()).toBe('Ask a bot for advice (the next one makes this game bot-assisted)');
    // a viewer.assist without unlimited is the server's word (the limit), whatever the seats
    // (as on iOS: AssistRules.isFreeHelpGame)
    reconnectWith(rejoinWith({ assist: { uses: 5, freeUses: 3, assisted: false }, bots: true }));
    expect(helpText()).toBe('Ask a bot for advice (this game is bot-assisted for you)');
    // the snapshot as the server sent it
    reconnectWith(rejoinWith({ assist: 'recorded', bots: true }));
    expect(helpText()).toBe('Ask a bot for advice');
    expect(redText()).toEqual(storedFaults());
    // the seats alone, before the server has said anything about /help (no viewer.assist, no count kept)
    const { forgetAssistUses } = await import('../state/assistHint.js');
    forgetAssistUses();
    reconnectWith(rejoinWith({ assist: null, bots: true }));
    expect(helpText()).toBe('Ask a bot for advice');
  });
});
