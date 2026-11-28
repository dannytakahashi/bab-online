/**
 * Get Your Bid's screens (owner 2026-11-24): the mode is "an option when
 * creating a new lobby"; the lobby says so and seats three; the game log's
 * header "needs to show 3 scores rather than 2"; the bid sheet must "make
 * it obvious that the forbidden bid is indeed forbidden" (and has no
 * bores); HSI is not shown; the score modal lists the three players.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showMainRoom, removeMainRoom, showCreateGameDialog } from './screens/MainRoom.js';
import { showGameLobby, removeGameLobby } from './screens/GameLobby.js';
import { createGameLog } from './components/GameLog.js';
import { showFinalScoreOverlay, removeFinalScoreOverlay } from './components/ScoreModal.js';
import { BidManager } from '../phaser/managers/BidManager.js';
import { getGameState, resetGameState } from '../state/GameState.js';
import { soloHeaderRows } from '../state/gyb.js';
import { resetMyAction } from '../state/MyAction.js';
import { readClientFile } from '../testing/files.js';

const fakeSocket = () => {
  const sent = [];
  return { sent, emit: (event, data) => { sent.push([event, data]); return true; }, on() {}, off() {} };
};
const PD = { positions: [1, 2, 3], usernames: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }], pics: [1, 2, 3], isBot: [false, false, false] };

/** A dealt Get Your Bid table seen from `me` (the dealer bids last). */
function deal(me, { dealer, handSize = 12 } = {}) {
  resetGameState();
  const s = getGameState();
  s.username = PD.usernames[me - 1].username;
  s.setMode('gyb');
  s.applyPositionUpdate(PD);
  s.applyDeal({ gameId: 'g1', position: me, dealer, currentHand: handSize, trump: { rank: '7', suit: 'spades' }, hand: [], score1: 0, score2: 0, hsiValues: {}, gyb: { scores: [0, 0, 0] } });
  return s;
}

afterEach(() => {
  removeMainRoom();
  removeGameLobby();
  removeFinalScoreOverlay();
  document.body.replaceChildren();
  resetGameState();
});

describe('creating a game', () => {
  it('New Game asks which game: the base game sends createLobby {}, Get Your Bid {mode: gyb}', () => {
    const socket = fakeSocket();
    showMainRoom({ lobbies: [], inProgressGames: [], tournaments: [], messages: [], onlineUsers: [] }, socket, 'ann');
    document.getElementById('createGameBtn').click();
    expect(socket.sent).toEqual([]);
    const dialog = document.getElementById('createGameDialog');
    expect(dialog.textContent).toContain('Back Alley Bridge');
    expect(dialog.textContent).toContain('Get Your Bid');
    expect(dialog.textContent).toContain('3 players, no teams');
    document.getElementById('createGameGyb').click();
    expect(socket.sent).toEqual([['createLobby', { mode: 'gyb' }]]);
    expect(document.getElementById('createGameDialog')).toBeNull();

    document.getElementById('createGameBtn').click();
    document.getElementById('createGameClassic').click();
    expect(socket.sent[1]).toEqual(['createLobby', {}]);
  });

  it('Cancel creates nothing', () => {
    const socket = fakeSocket();
    const modal = showCreateGameDialog(socket);
    [...document.querySelectorAll('#createGameDialog button')].find((b) => b.textContent === 'Cancel').click();
    expect(socket.sent).toEqual([]);
    expect(document.getElementById('createGameDialog')).toBeNull();
    expect(modal).toBeTruthy();
  });

  it('the lists mark a Get Your Bid lobby and table, with three names and scores', () => {
    showMainRoom({
      lobbies: [
        { id: 'aaaaaaaa', name: 'Three of us', playerCount: 1, maxPlayers: 4, players: [{ username: 'ann', ready: false }], createdAt: 1, memberCount: 1, capacity: 8, memberUsernames: ['ann'], mode: 'gyb', seats: 3 },
        { id: 'bbbbbbbb', name: 'Classic', playerCount: 1, maxPlayers: 4, players: [{ username: 'dan', ready: false }], createdAt: 2 },
      ],
      inProgressGames: [{
        gameId: 'g1', currentHand: 8, score: { team1: 0, team2: 0 }, spectatorCount: 0, mode: 'gyb', scores: [26, 16, 12],
        players: [{ position: 1, username: 'ann' }, { position: 2, username: 'bob' }, { position: 3, username: 'cat' }],
      }],
      tournaments: [], messages: [], onlineUsers: [],
    }, fakeSocket(), 'zed');
    const cards = [...document.querySelectorAll('#mainRoomLobbyList .room-card')];
    expect(cards[0].dataset.mode).toBe('gyb');
    expect(cards[0].querySelector('.room-card__mode').textContent).toBe('Get Your Bid');
    expect(cards[1].dataset.mode).toBeUndefined();
    expect(cards[1].querySelector('.room-card__mode')).toBeNull();
    expect(cards[2].querySelector('.room-card__name').textContent).toBe('ann vs bob vs cat');
    expect(cards[2].querySelector('.room-card__meta').textContent).toBe('ann: 26 | bob: 16 | cat: 12');
    expect([...cards[2].querySelectorAll('.room-card__meta span')].map((x) => x.className)).toEqual(['team-a', 'team-b', 'team-c']);
  });
});

describe('the lobby', () => {
  const lobby = (extra = {}) => ({
    lobbyId: 'L1', players: [{ socketId: 's1', username: 'ann', ready: false }], messages: [],
    members: [{ socketId: 's1', username: 'ann', ready: false, playing: true }], host: 'ann', settings: { spectatorsCanTalk: true }, capacity: 8, ...extra,
  });

  it('a Get Your Bid lobby says so and seats three', () => {
    showGameLobby(lobby({ mode: 'gyb' }), fakeSocket(), 'ann');
    expect(document.getElementById('lobbyMode').textContent).toContain('Get Your Bid');
    expect(document.querySelector('#gameLobbyContainer .section-label').textContent).toBe('Ready 0/3');
    expect(document.querySelectorAll('#gameLobbyContainer .seat-row--empty')).toHaveLength(2);
    expect(document.getElementById('lobbyReadyBtn').textContent).toBe('Waiting for 2 more...');
    expect(document.getElementById('lobbyVoiceHint').textContent).toMatch(/^The first 3 to tap Ready play/);
  });

  it('any other lobby is the base game: four seats, no mode line', () => {
    showGameLobby(lobby(), fakeSocket(), 'ann');
    expect(document.getElementById('lobbyMode')).toBeNull();
    expect(document.querySelector('#gameLobbyContainer .section-label').textContent).toBe('Ready 0/4');
    expect(document.querySelectorAll('#gameLobbyContainer .seat-row--empty')).toHaveLength(3);
  });
});

describe('the game log header', () => {
  it('three cells, one per player in its own colour, mine first; the base header comes back with two', () => {
    const s = deal(3, { dealer: 3 });
    s.applyBid({ position: 1, bid: '5' });
    s.gyb.scores = [26, 16, 12];
    const log = createGameLog();
    document.body.appendChild(log.container);
    log.updateSoloScore(soloHeaderRows(s));
    const score = log.container.querySelector('#gameLogScore');
    expect(score.classList.contains('is-solo')).toBe(true);
    const cells = [...score.querySelectorAll('.log-score__team')];
    expect(cells.map((cell) => [...cell.children].map((x) => x.textContent))).toEqual([
      ['cat', '12', 'Bid - | Won 0'],
      ['ann', '26', 'Bid 5 | Won 0'],
      ['bob', '16', 'Bid - | Won 0'],
    ]);
    expect(cells.map((cell) => ['a', 'b', 'c'].find((l) => cell.classList.contains(`is-team-${l}`)))).toEqual(['c', 'a', 'b']);
    expect(cells.map((cell) => cell.classList.contains('is-me'))).toEqual([true, false, false]);
    // the hand indicator is the last child: its own row under the three
    expect(score.lastElementChild.id).toBe('handIndicator');

    log.updateFullScore('ann/cat', 'bob/dan', 10, 20);
    expect(score.classList.contains('is-solo')).toBe(false);
    expect(score.querySelectorAll('.log-score__team')).toHaveLength(2);
    log.destroy();
  });

  it('the bid chips are coloured by seat, mine first', () => {
    const s = deal(3, { dealer: 3 });
    const log = createGameLog();
    document.body.appendChild(log.container);
    log.showTrickIndicator(12);
    s.applyBid({ position: 1, bid: '5' });
    s.applyBid({ position: 2, bid: '4' });
    log.updateTrickIndicator();
    const chips = [...log.container.querySelectorAll('.log-chip')];
    expect(chips).toHaveLength(12);
    const letter = (chip) => ['a', 'b', 'c'].find((l) => chip.classList.contains(`is-team-${l}`)) || '-';
    expect(chips.map(letter).join('')).toBe('aaaaabbbb---');
    log.destroy();
  });

  it('no /help and no tutorial among the chat commands', () => {
    deal(3, { dealer: 3 });
    const log = createGameLog();
    document.body.appendChild(log.container);
    const input = log.container.querySelector('#chatInput');
    input.value = '/';
    input.dispatchEvent(new Event('input'));
    const commands = [...log.container.querySelectorAll('.slash-item__cmd')].map((x) => x.textContent);
    expect(commands).toEqual(['/lazy', '/active', '/leave']);
    log.destroy();
  });
});

describe('the bid sheet', () => {
  let bm;
  beforeEach(() => { resetMyAction(); });
  afterEach(() => {
    bm?.hideBidUI(false);
    document.getElementById('bidContainer')?.remove();
    vi.restoreAllMocks();
  });
  const labels = () => [...document.querySelectorAll('#bidContainer .bid-button')].map((b) => b.textContent);

  it('numbers only: no bores at a Get Your Bid table', () => {
    deal(3, { dealer: 3, handSize: 6 });
    bm = new BidManager({});
    bm.showBidUI(6, () => {});
    expect(labels()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(document.querySelector('#bidContainer .bid-bores')).toBeNull();
    expect(document.querySelector('.bid-sheet__forbidden').textContent).toBe('');
  });

  it('the last bidder sees the Forbidden Bid: named, struck out, disabled, never sent', () => {
    const s = deal(3, { dealer: 3 });
    bm = new BidManager({});
    const chosen = [];
    bm.showBidUI(12, (bid) => { chosen.push(bid); return true; });
    s.applyBid({ position: 1, bid: '5' });
    bm.updateBoreButtonStates();
    expect(document.querySelector('#bidContainer .is-forbidden')).toBeNull();
    s.applyBid({ position: 2, bid: '4' });
    s.applyTurn({ currentTurn: 3 });
    bm.updateBoreButtonStates();

    const line = document.querySelector('.bid-sheet__forbidden');
    expect(line.textContent).toBe('Forbidden Bid: 3');
    expect(line.classList.contains('is-on')).toBe(true);
    const forbidden = [...document.querySelectorAll('#bidContainer .is-forbidden')];
    expect(forbidden.map((b) => b.textContent)).toEqual(['3']);
    expect(forbidden[0].disabled).toBe(true);
    expect(forbidden[0].getAttribute('aria-label')).toBe('3, the Forbidden Bid');
    forbidden[0].click();
    forbidden[0].disabled = false; // even if something re-enabled it
    forbidden[0].click();
    expect(chosen).toEqual([]);
    // every other number is open
    const two = [...document.querySelectorAll('#bidContainer .bid-button')].find((b) => b.textContent === '2');
    expect(two.disabled).toBe(false);
    two.click();
    expect(chosen).toEqual(['2']);
  });

  it('a seat that is not last sees none, and a hand of 4 has none', () => {
    const s = deal(2, { dealer: 3 });
    bm = new BidManager({});
    bm.showBidUI(12, () => {});
    s.applyBid({ position: 1, bid: '5' });
    bm.updateBoreButtonStates();
    expect(document.querySelector('#bidContainer .is-forbidden')).toBeNull();
    bm.hideBidUI(false);

    const small = deal(3, { dealer: 3, handSize: 4 });
    bm = new BidManager({});
    bm.showBidUI(4, () => {});
    small.applyBid({ position: 1, bid: '2' });
    small.applyBid({ position: 2, bid: '1' });
    bm.updateBoreButtonStates();
    expect(document.querySelector('#bidContainer .is-forbidden')).toBeNull();
    expect(document.querySelector('.bid-sheet__forbidden').textContent).toBe('');
  });

  it('the trick chips show each seat\'s bid in its own colour, mine first', () => {
    const s = deal(3, { dealer: 3 });
    bm = new BidManager({});
    bm.showBidUI(12, () => {});
    s.applyBid({ position: 1, bid: '5' });
    s.applyBid({ position: 2, bid: '4' });
    s.applyBid({ position: 3, bid: '2' });
    bm.updateBoreButtonStates();
    const letter = (chip) => ['a', 'b', 'c'].find((l) => chip.classList.contains(`is-team-${l}`)) || '-';
    expect(bm.trickIndicators.map(letter).join('')).toBe('ccaaaaabbbb-');
  });

  it('table.css draws the Forbidden Bid at full strength in the danger colour, struck through', () => {
    const css = readClientFile('styles/table.css');
    const i = css.indexOf('.bid-button.is-forbidden,');
    expect(i).toBeGreaterThan(-1);
    const rule = css.slice(i, css.indexOf('}', i));
    expect(rule).toContain('opacity: 1');
    expect(rule).toContain('var(--danger-text)');
    expect(rule).toContain('text-decoration: line-through');
    expect(css).toContain('.bid-chip.is-team-c { background: var(--gold); }');
  });
});

describe('the score modal', () => {
  const end = { scores: [90, 120, 80], winners: [2], made: [5, 9, 4], hands: 13 };
  const playerData = { position: [1, 2, 3], username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }] };
  const rows = () => [...document.querySelectorAll('#finalScoreOverlay .result-stats__row:not(.result-stats__head)')].map((r) => [...r.children].map((x) => x.textContent));

  it('the three players best first, the winner by name, my result as the title', () => {
    showFinalScoreOverlay({ solo: { end, playerData, myPosition: 2 }, onReturnToLobby: () => {} });
    const modal = document.getElementById('finalScoreOverlay');
    expect(modal.querySelector('.kit-modal__title').textContent).toBe('VICTORY');
    expect(modal.querySelector('.result-score').textContent).toBe('bob wins!');
    expect(rows()).toEqual([['bob', '120', '9 of 13'], ['ann', '90', '5 of 13'], ['cat', '80', '4 of 13']]);
    expect(modal.textContent).not.toMatch(/HSI|Faults/);
    removeFinalScoreOverlay();

    showFinalScoreOverlay({ solo: { end, playerData, myPosition: 1 }, onReturnToLobby: () => {} });
    expect(document.querySelector('#finalScoreOverlay .kit-modal__title').textContent).toBe('DEFEAT');
    removeFinalScoreOverlay();

    showFinalScoreOverlay({ solo: { end: { ...end, scores: [120, 120, 80], winners: [1, 2] }, playerData, myPosition: 1 }, onReturnToLobby: () => {} });
    expect(document.querySelector('#finalScoreOverlay .kit-modal__title').textContent).toBe('TIE GAME');
    expect(document.querySelector('#finalScoreOverlay .result-score').textContent).toBe('ann and bob tie!');
    removeFinalScoreOverlay();

    showFinalScoreOverlay({ solo: { end, playerData, myPosition: null }, isSpectator: true, onReturnToLobby: () => {} });
    expect(document.querySelector('#finalScoreOverlay .kit-modal__title').textContent).toBe('GAME OVER');
  });

  it('Return to Lobby runs the callback', () => {
    const onReturnToLobby = vi.fn();
    showFinalScoreOverlay({ solo: { end, playerData, myPosition: 2 }, onReturnToLobby });
    [...document.querySelectorAll('#finalScoreOverlay .kit-modal__actions button')].find((b) => b.textContent === 'Return to Lobby').click();
    expect(onReturnToLobby).toHaveBeenCalledTimes(1);
  });
});
