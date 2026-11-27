/**
 * The tournament lobby asks before Leave, Stop Watching and End Tournament
 * (owner 2026-11-26, iOS's words): the kit's modal, keep / confirm, focus on
 * the keep button, nothing sent without a confirm, the dialog dropped (as if
 * kept) when its choice stops applying while it is open, its message
 * following the lobby, and the confirm checking again before it sends.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import {
  showTournamentLobby, removeTournamentLobby, updateTournamentPlayers, setTournamentPhase,
  syncTournamentCut, showTournamentFinal, tournamentConfirmChoice,
} from './TournamentLobby.js';
import { applyCutEvent, clearCut } from '../cut/cutStore.js';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

function fakeSocket() {
  const sent = [];
  return { emit: vi.fn((event, data) => sent.push([event, data])), sent, emitted: (e) => sent.filter(([n]) => n === e).map(([, d]) => d) };
}

const member = (username, extra = {}) => ({ username, ready: false, isCreator: false, connected: true, ...extra });
const payload = ({ phase = 'lobby', host = 'me', players = null, isSpectator = false, currentRound = 0 } = {}) => ({
  tournamentId: 't1', name: 'Friday', creatorUsername: host, phase, currentRound, totalRounds: 4, isSpectator,
  players: players || [member('me', { isCreator: host === 'me' }), member('bo', { isCreator: host === 'bo' }), member('cy')],
  messages: [], scoreboard: [], activeGames: [],
});

const $ = (id) => document.getElementById(id);
const dialog = () => document.querySelector('#tournamentConfirmDialog [role="dialog"]');
const title = () => dialog()?.querySelector('.kit-modal__title')?.textContent;
const message = () => $('tournamentConfirmMessage')?.textContent;
const actionLabels = () => [...dialog().querySelectorAll('.kit-modal__actions button')].map((b) => b.textContent);
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

afterEach(() => {
  removeTournamentLobby();
  clearCut();
  document.body.replaceChildren();
});

describe('Leave asks first', () => {
  it('a member: "Leave tournament?", Stay keeps (nothing sent, focus back on Leave), Leave Tournament sends', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ host: 'bo' }), socket, 'me');
    const leave = $('tournamentLeaveBtn');
    expect(leave.textContent).toBe('Leave');
    leave.focus();
    leave.click();
    expect(socket.sent).toEqual([]);
    expect(title()).toBe('Leave tournament?');
    expect(message()).toBe("You can join again while it's waiting to start.");
    expect(actionLabels()).toEqual(['Stay', 'Leave Tournament']);
    // destructive: the keep button has focus; the confirm is the danger one
    expect(document.activeElement).toBe($('tournamentConfirmKeep'));
    expect($('tournamentConfirmOk').classList.contains('kit-btn--danger')).toBe(true);
    expect(dialog().getAttribute('aria-describedby')).toBe('tournamentConfirmMessage');

    $('tournamentConfirmKeep').click();
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);
    expect(document.activeElement).toBe(leave);

    leave.click();
    $('tournamentConfirmOk').click();
    expect(dialog()).toBeNull();
    expect(socket.emitted('leaveTournament')).toHaveLength(1);
    expect(socket.sent).toHaveLength(1);
  });

  it('Escape and the backdrop keep; the keyboard confirms (Tab to the confirm, Enter is its click)', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ host: 'bo' }), socket, 'me');
    $('tournamentLeaveBtn').click();
    key('Escape');
    expect(dialog()).toBeNull();
    $('tournamentLeaveBtn').click();
    $('tournamentConfirmDialog').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);

    // the Tab trap keeps focus on the two buttons: Shift+Tab from Stay is
    // the confirm, Tab from it is Stay again
    $('tournamentLeaveBtn').click();
    expect(document.activeElement).toBe($('tournamentConfirmKeep'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe($('tournamentConfirmOk'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe($('tournamentConfirmKeep'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(socket.sent).toEqual([]);
    // (Enter or Space on a focused button is its click)
    $('tournamentConfirmOk').click();
    expect(socket.emitted('leaveTournament')).toHaveLength(1);
  });

  it('the host alone in the lobby: the tournament ends; with others, another player becomes the host', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ players: [member('me', { isCreator: true })] }), socket, 'me');
    $('tournamentLeaveBtn').click();
    expect(message()).toBe('The tournament ends, since nobody else has joined.');
    // the words follow the lobby while open: someone joins
    updateTournamentPlayers([member('me', { isCreator: true }), member('bo')], 'me');
    expect(tournamentConfirmChoice()).toBe('leave');
    expect(message()).toBe("You can join again while it's waiting to start. Another player becomes the host.");
  });

  it('between rounds: the message follows the others dropping', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'between_rounds', currentRound: 1, host: 'bo' }), socket, 'me');
    $('tournamentLeaveBtn').click();
    expect(message()).toBe("You can't come back to this tournament, and you won't be among the winners.");
    updateTournamentPlayers([member('me'), member('bo', { isCreator: true, connected: false }), member('cy', { connected: false })], 'me');
    expect(message()).toBe('The tournament ends, since nobody else is connected.');
    // and the phase: the next round starts
    updateTournamentPlayers([member('me'), member('bo', { isCreator: true }), member('cy')], 'me');
    setTournamentPhase('round_active');
    expect(message()).toBe("You can't come back to this tournament, and you won't be among the winners.");
  });
});

describe('End Tournament asks first', () => {
  it('the host: "End tournament?", Keep Tournament keeps, End Tournament sends cancelTournament', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload(), socket, 'me');
    const end = $('tournamentCancelBtn');
    expect(end.textContent).toBe('End Tournament');
    expect(end.classList.contains('kit-btn--danger')).toBe(true);
    end.click();
    expect(socket.sent).toEqual([]);
    expect(title()).toBe('End tournament?');
    expect(message()).toBe('The tournament ends for everyone before it starts.');
    expect(actionLabels()).toEqual(['Keep Tournament', 'End Tournament']);
    expect(document.activeElement).toBe($('tournamentConfirmKeep'));
    $('tournamentConfirmKeep').click();
    expect(socket.sent).toEqual([]);
    expect(document.activeElement).toBe(end);
    end.click();
    $('tournamentConfirmOk').click();
    expect(socket.emitted('cancelTournament')).toEqual([undefined]);
    expect(socket.emitted('leaveTournament')).toEqual([]);
  });

  it('mid-round the message says games stop', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'round_active', currentRound: 1 }), socket, 'me');
    $('tournamentCancelBtn').click();
    expect(message()).toBe('The tournament ends for everyone, and any games still in play stop now.');
  });

  it('a host hand-off while it is open closes it, nothing sent; a late click on its confirm sends nothing', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload(), socket, 'me');
    $('tournamentCancelBtn').click();
    const ok = $('tournamentConfirmOk');
    // the server hands the role on (an idle host, 2026-11-15)
    updateTournamentPlayers([member('me'), member('bo', { isCreator: true }), member('cy')], 'me', 'bo');
    expect(dialog()).toBeNull();
    expect(tournamentConfirmChoice()).toBeNull();
    expect($('tournamentCancelBtn')).toBeNull();
    ok.click();
    expect(socket.sent).toEqual([]);
    // focus lands on Leave (End is gone), never the page
    expect(document.activeElement).toBe($('tournamentLeaveBtn'));
  });

  it('a hand-off leaves an open Leave up, its words now a member\'s', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload(), socket, 'me');
    $('tournamentLeaveBtn').click();
    expect(message()).toBe("You can join again while it's waiting to start. Another player becomes the host.");
    updateTournamentPlayers([member('me'), member('bo', { isCreator: true }), member('cy')], 'me', 'bo');
    expect(tournamentConfirmChoice()).toBe('leave');
    expect(message()).toBe("You can join again while it's waiting to start.");
  });

  it('the cut starting closes End (not offered in the cut); an open Leave stays, out of the cut', () => {
    const socket = fakeSocket();
    const players = [member('me', { isCreator: true, ready: true }), member('bo', { ready: true }), member('cy', { ready: true })];
    showTournamentLobby(payload({ phase: 'between_rounds', currentRound: 1, players }), socket, 'me');
    $('tournamentCancelBtn').click();
    applyCutEvent('start', { candidates: ['me', 'bo', 'cy'], startsInMs: 15000, deckCount: 54 }, { tournament: 't1' });
    setTournamentPhase('cut');
    syncTournamentCut('start');
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);

    // the cut's own Leave asks too
    $('cutLeaveBtn').click();
    expect(socket.sent).toEqual([]);
    expect(title()).toBe('Leave tournament?');
    expect(message()).toBe("You'll be out of cut for a buck. Another player becomes the host.");
    $('tournamentConfirmKeep').click();
    expect(socket.sent).toEqual([]);
    $('cutLeaveBtn').click();
    $('tournamentConfirmOk').click();
    expect(socket.emitted('leaveTournament')).toHaveLength(1);
  });

  it('an open Leave across the cut\'s start: kept open, its words now the cut\'s', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'between_rounds', currentRound: 1, host: 'bo' }), socket, 'me');
    $('tournamentLeaveBtn').click();
    applyCutEvent('start', { candidates: ['me', 'bo', 'cy'], startsInMs: 15000, deckCount: 54 }, { tournament: 't1' });
    setTournamentPhase('cut');
    syncTournamentCut('start');
    expect(tournamentConfirmChoice()).toBe('leave');
    expect(message()).toBe("You'll be out of cut for a buck.");
    // kept: focus goes to where Leave is now (the lobby's button left with the column)
    $('tournamentConfirmKeep').click();
    expect(document.activeElement).toBe($('cutLeaveBtn'));
  });

  it('the host role passing to me in the cut: the cut\'s Leave says another player becomes the host', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'between_rounds', currentRound: 1, host: 'bo' }), socket, 'me');
    applyCutEvent('start', { candidates: ['me', 'bo', 'cy'], startsInMs: 15000, deckCount: 54 }, { tournament: 't1' });
    setTournamentPhase('cut');
    syncTournamentCut('start');
    // bo leaves during the cut; the server hands me the role (tournamentPlayerLeft's newCreator)
    updateTournamentPlayers([member('me', { isCreator: true }), member('cy')], 'me', 'me');
    $('cutLeaveBtn').click();
    expect(message()).toBe("You'll be out of cut for a buck. Another player becomes the host.");
    // End is still not offered in the cut, and no host controls came back
    expect($('tournamentCancelBtn')).toBeNull();
    // the role passing on again while it is open: the words follow
    updateTournamentPlayers([member('me'), member('cy', { isCreator: true })], 'me', 'cy');
    expect(tournamentConfirmChoice()).toBe('leave');
    expect(message()).toBe("You'll be out of cut for a buck.");
  });

  it('a phase change alone changes the words: End opened in the lobby, then the round starts', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload(), socket, 'me');
    $('tournamentCancelBtn').click();
    expect(message()).toBe('The tournament ends for everyone before it starts.');
    setTournamentPhase('round_active');
    expect(tournamentConfirmChoice()).toBe('end');
    expect(message()).toBe('The tournament ends for everyone, and any games still in play stop now.');
  });

  it('the results showing close either dialog', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'between_rounds', currentRound: 1 }), socket, 'me');
    $('tournamentCancelBtn').click();
    showTournamentFinal({ scoreboard: [], winners: ['bo'] });
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);
    expect(document.activeElement).toBe($('tournamentReturnBtn'));
  });

  it('the screen going (the tournament cancelled by someone else, a table, a redraw) closes it, nothing sent', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ host: 'bo' }), socket, 'me');
    $('tournamentLeaveBtn').click();
    const ok = $('tournamentConfirmOk');
    removeTournamentLobby();
    expect(dialog()).toBeNull();
    ok.click();
    expect(socket.sent).toEqual([]);

    // a redraw (tournamentJoined again) is a new screen: the open dialog goes
    showTournamentLobby(payload(), socket, 'me');
    $('tournamentCancelBtn').click();
    showTournamentLobby(payload(), socket, 'me');
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);
  });
});

describe('a spectator: Stop Watching asks first', () => {
  it('"Stop watching?", Keep Watching keeps, Stop Watching sends leaveTournament', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'round_active', currentRound: 1, host: 'bo', isSpectator: true }), socket, 'me');
    const btn = $('tournamentLeaveBtn');
    expect(btn.textContent).toBe('Stop Watching');
    expect($('tournamentCancelBtn')).toBeNull();
    btn.click();
    expect(title()).toBe('Stop watching?');
    expect(message()).toBe('You go back to the main room.');
    expect(actionLabels()).toEqual(['Keep Watching', 'Stop Watching']);
    expect(document.activeElement).toBe($('tournamentConfirmKeep'));
    $('tournamentConfirmKeep').click();
    expect(socket.sent).toEqual([]);
    btn.click();
    $('tournamentConfirmOk').click();
    expect(socket.emitted('leaveTournament')).toHaveLength(1);
  });

  it('the cut\'s view says Stop Watching and asks too', () => {
    const socket = fakeSocket();
    showTournamentLobby(payload({ phase: 'between_rounds', currentRound: 1, host: 'bo', isSpectator: true }), socket, 'me');
    applyCutEvent('start', { candidates: ['bo', 'cy'], startsInMs: 15000, deckCount: 54 }, { tournament: 't1' });
    setTournamentPhase('cut');
    syncTournamentCut('start');
    expect($('cutLeaveBtn').textContent).toBe('Stop Watching');
    $('cutLeaveBtn').click();
    expect(title()).toBe('Stop watching?');
    expect(socket.sent).toEqual([]);
  });
});
