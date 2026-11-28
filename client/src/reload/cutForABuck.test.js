/**
 * Cut for a buck on the page (main.js, the real entry module with the
 * socket faked): the cut starting on the tournament lobby (its intro, no
 * Ready / Begin / Cancel), a draw, the winner and the final lobby in place
 * of the results modal; the last table's score screen with its strip and
 * "Join cut for a buck"; a reload mid-cut (a static render from
 * tournamentJoined.cut); the complete phase on a return.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, tournamentPayload, seatDeal } from '../testing/fakePage.js';
import { clientHello } from '../utils/avatar.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let socketCount = 1;
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const NAMES = ['me', 'bob', 'cat'];

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = () => null;
  page = await loadPage({ connected: false });
  socket = page.socket;
});

afterEach(() => {
  vi.useRealTimers();
});

async function signIn(name = 'me') {
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(`sock-${++socketCount}`);
  socket.fire('signInResponse', { success: true, username: name, sessionToken: `tok-${name}`, blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  socket.clearEmits();
}

function joined(extra = {}) {
  return {
    ...tournamentPayload({ creator: 'me' }),
    name: 'Friday',
    players: NAMES.map((username) => ({ socketId: `s-${username}`, username, pic: 2, ready: true, connected: true, isCreator: username === 'me' })),
    scoreboard: [
      { username: 'bob', totalScore: 320, roundScores: [320] },
      { username: 'me', totalScore: 300, roundScores: [300] },
      { username: 'cat', totalScore: 120, roundScores: [120] },
    ],
    currentRound: 1,
    totalRounds: 1,
    ...extra,
  };
}
const start = () => ({ candidates: NAMES, startsInMs: 15000, deckCount: 54 });
const round = (n = 1, alive = NAMES) => ({ round: n, participants: NAMES, alive, deckCount: 54, reshuffled: false, closesInMs: 15000 });

describe('Cut for a buck on the page', () => {
  beforeEach(async () => {
    await signIn('me');
  });

  it('this bundle says cutForABuck in clientHello', () => {
    expect(clientHello('1.0.0', 'b').caps).toContain('cutForABuck');
    expect(clientHello('1.0.0', 'b', false).caps).toContain('cutForABuck');
  });

  it('on the lobby: the cut takes the standings (intro, no host controls), a draw, the winner, then the final lobby', async () => {
    socket.fire('tournamentJoined', joined({ phase: 'between_rounds' }));
    await settle();
    expect(document.getElementById('tournamentCancelBtn')).not.toBeNull();
    socket.fire('cutForABuckStart', start());
    await settle();
    const cut = document.getElementById('cutForABuck');
    expect(cut).not.toBeNull();
    expect(cut.classList.contains('is-intro')).toBe(true);
    expect(document.getElementById('tournamentRoundIndicator').textContent).toBe('Cut for a buck');
    expect(document.getElementById('tournamentCancelBtn')).toBeNull();
    expect(document.getElementById('tournamentReadyBtn')).toBeNull();
    expect(document.getElementById('tournamentBeginBtn')).toBeNull();
    // the chat and the header stay
    expect(document.getElementById('tournamentChatArea')).not.toBeNull();
    expect(document.getElementById('cutStatus').textContent).toMatch(/^Cut for a buck starts in \d+$/);

    socket.fire('cutForABuckRound', round());
    await settle();
    expect(document.getElementById('cutForABuck')).toBe(cut);
    socket.clearEmits();

    socket.fire('cutForABuckDrew', { round: 1, username: 'bob', slot: 4, auto: false });
    socket.fire('cutForABuckReveal', { round: 1, draws: [{ username: 'me', slot: 1, card: { suit: 'hearts', rank: 'A' } }, { username: 'bob', slot: 4, card: { suit: 'clubs', rank: '3' } }, { username: 'cat', slot: 9, card: { suit: 'spades', rank: '3' } }], eliminated: ['bob', 'cat'], redraw: false, alive: ['me'], nextInMs: 6000 });
    socket.fire('cutForABuckWinner', { winner: 'me', participants: NAMES, rounds: 1 });
    socket.fire('tournamentMessage', { username: 'System', message: 'me won cut for a buck.', system: true, type: 'system' });
    await settle();
    expect(document.getElementById('tournamentChatArea').textContent).toContain('me won cut for a buck.');

    socket.fire('tournamentComplete', { scoreboard: joined().scoreboard, winners: ['bob'], cutForABuck: { winner: 'me', participants: NAMES, rounds: 1 } });
    await settle();
    expect(document.getElementById('cutForABuck')).toBeNull();
    expect(document.getElementById('tournamentResultsOverlay')).toBeNull();
    expect(document.getElementById('tournamentFinalTitle').textContent).toBe('bob wins the tournament!');
    expect(document.getElementById('tournamentFinalCut').textContent).toBe('You won cut for a buck');
    const chips = (u) => [...document.querySelectorAll(`.final-results__player[data-username="${u}"] .kit-chip`)].map((c) => c.textContent);
    expect(chips('bob')).toEqual(['Winner']);
    expect(chips('me')).toEqual(['Won the cut']);
    expect(document.getElementById('tournamentRoundIndicator').textContent).toBe('Final results');
    expect(document.querySelector('.final-results__note').textContent).toBe('This lobby stays open for about 10 minutes');
    expect(document.querySelectorAll('#tournamentFinalResults th').length).toBe(4); // #, Player, R1, Total
    expect(page.session.screen).toBe('tournamentLobby');

    socket.clearEmits();
    document.getElementById('tournamentReturnBtn').click();
    await settle();
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.session.screen).toBe('mainRoom');
    expect(page.gameState.tournamentId).toBeNull();
  });

  it('a draw from the page: cutForABuckDraw {round, slot}', async () => {
    socket.fire('tournamentJoined', joined({ phase: 'cut', cut: { stage: 'drawing', inMs: 12000, round: 2, participants: NAMES, alive: NAMES, out: [], table: [], drawn: [], deckCount: 51 } }));
    await settle();
    socket.clearEmits();
    document.getElementById('cutDeck').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(socket.emitted('cutForABuckDraw')).toEqual([{ round: 2, slot: null }]);
  });

  it('the last table\'s score screen: the strip and "Join cut for a buck" (the same returnToTournament)', async () => {
    socket.fire('tournamentJoined', joined({ phase: 'round_active' }));
    await settle();
    socket.fire('tournamentGameAssignment', { gameId: 'g9', tournamentId: 't1', roundNumber: 1 });
    socket.fire('allPlayersReady', { gameId: 'g9' });
    socket.fire('startDraw', { start: true });
    socket.fire('createUI', {});
    socket.fire('gameStart', seatDeal({ gameId: 'g9' }));
    await settle();
    socket.fire('gameEnd', { score: { team1: 300, team2: 120 }, playerStats: {}, tournamentId: 't1' });
    await settle();
    expect(page.session.screen).toBe('gameEnd');
    const button = () => document.querySelector('#finalScoreOverlay .kit-modal__actions button') || document.querySelector('#finalScoreOverlay .kit-modal__actions button');
    expect(button().textContent).toBe('Return to Tournament');
    expect(document.getElementById('cutStrip').hidden).toBe(true);

    socket.fire('cutForABuckStart', start());
    await settle();
    expect(document.getElementById('cutStrip').hidden).toBe(false);
    expect(document.getElementById('cutStrip').textContent).toMatch(/^Cut for a buck starts in 1[45]$/);
    expect(button().textContent).toBe('Join cut for a buck');
    // the score screen stays (no forced navigation)
    expect(page.session.screen).toBe('gameEnd');

    socket.fire('cutForABuckRound', round());
    await settle();
    expect(document.getElementById('cutStrip').textContent).toBe("Cut for a buck has started. We'll draw for you until you join.");

    socket.clearEmits();
    button().click();
    await settle();
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    socket.fire('tournamentJoined', joined({ phase: 'cut', cut: { stage: 'drawing', inMs: 9000, round: 1, participants: NAMES, alive: NAMES, out: [], table: [], drawn: [{ username: 'me', slot: 3 }], deckCount: 54 } }));
    await settle();
    expect(page.session.screen).toBe('tournamentLobby');
    const cut = document.getElementById('cutForABuck');
    expect(cut).not.toBeNull();
    // arriving mid-round: a static render, no intro; I was drawn for
    expect(cut.classList.contains('is-intro')).toBe(false);
    expect(document.querySelector('.cut-seat[data-username="me"]').getAttribute('aria-label')).toBe('you, drawn');
  });

  it('back during the gather: the intro plays', async () => {
    socket.fire('tournamentJoined', joined({ phase: 'cut', cut: { stage: 'gather', inMs: 11000, round: 0, candidates: NAMES, alive: [], out: [], table: [], drawn: [], deckCount: 54 } }));
    await settle();
    expect(document.getElementById('cutForABuck').classList.contains('is-intro')).toBe(true);
  });

  it('a reload mid-cut: the tournament re-entry lands in the cut as it stands', async () => {
    socket.fire('tournamentJoined', joined({ phase: 'cut', cut: { stage: 'reveal', inMs: 2000, round: 3, participants: NAMES, alive: ['me', 'bob'], out: [{ username: 'cat', round: 3 }], table: [{ username: 'cat', cards: [{ suit: 'clubs', rank: '2' }] }, { username: 'me', cards: [{ suit: 'hearts', rank: '9' }] }, { username: 'bob', cards: [{ suit: 'clubs', rank: '9' }] }], drawn: [], deckCount: 40, lastReveal: { round: 3, draws: [{ username: 'me', slot: 0, card: { suit: 'hearts', rank: '9' } }, { username: 'bob', slot: 1, card: { suit: 'clubs', rank: '9' } }, { username: 'cat', slot: 2, card: { suit: 'clubs', rank: '2' } }], eliminated: ['cat'], redraw: false } } }));
    await settle();
    expect(document.getElementById('cutStatus').textContent).toBe("You're safe with a 9");
    expect(document.getElementById('cutStatusSub').textContent).toBe('cat is out with a 2');
    expect(document.querySelector('.cut-seat[data-username="cat"]').classList.contains('is-out')).toBe(true);
    // the reload
    socket.reconnect(`sock-${++socketCount}`);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [], activeTournamentId: 't1' });
    await settle();
    expect(socket.emitted('joinTournament').at(-1)).toEqual({ tournamentId: 't1' });
    socket.fire('tournamentJoined', joined({ phase: 'cut', cut: { stage: 'drawing', inMs: 14000, round: 4, participants: NAMES, alive: ['me', 'bob'], out: [{ username: 'cat', round: 3 }], table: [], drawn: [], deckCount: 37 } }));
    await settle();
    expect(document.getElementById('cutRoundLine').textContent).toBe('Round 4 · 2 of 3 left');
    expect(document.getElementById('cutStatus').textContent).toBe('Click the deck to draw');
    expect(document.getElementById('cutDeckCaption').textContent).toBe('37 cards left');
  });

  it('back to a finished tournament: its final results, no modal', async () => {
    socket.fire('tournamentJoined', joined({ phase: 'complete', winners: ['bob'], cutForABuck: null }));
    await settle();
    expect(document.getElementById('tournamentResultsOverlay')).toBeNull();
    expect(document.getElementById('tournamentFinalTitle').textContent).toBe('bob wins the tournament!');
    expect(document.getElementById('tournamentFinalCut')).toBeNull();
    expect(document.getElementById('tournamentReturnBtn').textContent).toBe('Return to Main Room');
    expect(document.getElementById('tournamentReadyBtn')).toBeNull();
  });

  it('the main room\'s card during a cut: "Cut for a buck!"', async () => {
    socket.fire('mainRoomJoined', mainRoomPayload({ tournaments: [{ id: 't9', name: 'Friday', phase: 'round_active', cut: true, currentRound: 2, totalRounds: 2, playerCount: 5 }] }));
    await settle();
    expect(document.querySelector('#mainRoomContainer').textContent).toContain('Cut for a buck!');
  });
});
