/**
 * My seat and the seat owners without playerAssigned (V1_REMOVALS #7) and
 * without socket ids (#6 gameStart.players, #14 positionUpdate.sockets).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GameState } from './GameState.js';

const seating = ({ sockets = true } = {}) => {
  const d = {
    positions: [1, 2, 3, 4],
    usernames: [{ username: 'ann', socketId: 's-ann' }, { username: 'bob', socketId: 's-bob' }, { username: 'me', socketId: 's-me' }, { username: 'dan', socketId: 's-dan' }],
    pics: [1, 2, 3, 4],
  };
  if (sockets) d.sockets = ['s-ann', 's-bob', 's-me', 's-dan'];
  else d.usernames = d.usernames.map(({ username }) => ({ username }));
  return d;
};

const deal = ({ players = true } = {}) => {
  const d = {
    gameId: 'g1', position: 3, hand: [{ suit: 'spades', rank: 'A' }], trump: { suit: 'clubs', rank: '5' },
    dealer: 1, currentHand: 1, score1: 0, score2: 0,
    playerInfo: [1, 2, 3, 4].map((p, i) => ({ position: p, username: ['ann', 'bob', 'me', 'dan'][i], pic: p })),
  };
  if (players) d.players = ['s-ann', 's-bob', 's-me', 's-dan'];
  return d;
};

describe('positionUpdate: my seat by my username', () => {
  let state;
  beforeEach(() => {
    state = new GameState();
    state.username = 'me';
  });

  it('no playerAssigned and no socket ids: seat 3, partner and opponents named', () => {
    state.applyPositionUpdate(seating({ sockets: false }), { socketId: 's-me' });
    expect(state.position).toBe(3);
    expect(state.partnerName).toBe('ann');
    expect(state.opp1Name).toBe('dan');
    expect(state.opp2Name).toBe('bob');
    expect(state.seatOwners).toEqual({ 1: 'ann', 2: 'bob', 3: 'me', 4: 'dan' });
  });

  it('a stale position from the last game is replaced', () => {
    state.position = 1;
    state.applyPositionUpdate(seating({ sockets: false }));
    expect(state.position).toBe(3);
  });

  it('no username known: the socket id finds the seat (today\'s wire)', () => {
    state.username = null;
    state.applyPositionUpdate(seating(), { socketId: 's-me' });
    expect(state.position).toBe(3);
  });

  it('not seated (watching): the position stays', () => {
    state.username = 'zed';
    state.position = 1;
    state.applyPositionUpdate(seating(), { socketId: 's-zed' });
    expect(state.position).toBe(1);
  });

  it('yourPosition wins when present', () => {
    state.applyPositionUpdate({ ...seating(), yourPosition: 2 });
    expect(state.position).toBe(2);
  });
});

describe('gameStart without players (V1_REMOVALS #6)', () => {
  it('keeps the seat socket ids positionUpdate gave (the voice glow\'s fallback)', () => {
    const state = new GameState();
    state.username = 'me';
    state.applyPositionUpdate(seating(), { socketId: 's-me' });
    state.applyDeal(deal({ players: false }));
    expect(state.playerData.socket).toEqual(['s-ann', 's-bob', 's-me', 's-dan']);
    expect(state.position).toBe(3);
  });

  it('with players, they win (today\'s wire)', () => {
    const state = new GameState();
    state.applyPositionUpdate(seating());
    state.applyDeal({ ...deal(), players: ['n-ann', 'n-bob', 'n-me', 'n-dan'] });
    expect(state.playerData.socket).toEqual(['n-ann', 'n-bob', 'n-me', 'n-dan']);
  });

  it('a lazy seat keeps its owner: playerInfo shows the bot, seatOwners the human', () => {
    const state = new GameState();
    state.username = 'me';
    state.applyPositionUpdate(seating({ sockets: false }));
    const d = deal({ players: false });
    d.playerInfo[1].username = 'Bot Mary';
    state.applyDeal(d);
    expect(state.playerData.username[1]).toEqual({ username: 'Bot Mary' });
    expect(state.seatOwners[2]).toBe('bob');
  });
});

describe('snapshots carry the seat owners', () => {
  it('ownerUsername, else username', () => {
    const state = new GameState();
    state.applySnapshot({
      v: 2, gameId: 'g1', stage: 'PLAYING', viewer: { role: 'seat', position: 3 },
      seats: [
        { position: 1, username: 'ann', ownerUsername: 'ann' },
        { position: 2, username: 'Bot Mary', ownerUsername: 'bob' },
        { position: 3, username: 'me', ownerUsername: 'me' },
        { position: 4, username: 'Bot Bob', ownerUsername: null },
      ],
      bids: { byPosition: [null, null, null, null] }, tricks: { team1: 0, team2: 0 },
    });
    expect(state.seatOwners).toEqual({ 1: 'ann', 2: 'bob', 3: 'me', 4: 'Bot Bob' });
  });
});
