/**
 * The tournament lobby's choices and their confirm words (owner
 * 2026-11-26): a port of iOS's TournamentLobbyMenu (items, confirmMessage,
 * the Copy sentences) with "closes" read as "ends", and the dialogs' titles
 * and buttons in iOS's words.
 */
import { describe, it, expect } from 'vitest';
import { CHOICE, CHOICE_EVENT, tournamentChoices, stillOffers, confirmWords, confirmMessage, otherMembers, CONFIRM_COPY } from './tournamentConfirm.js';

const C = CONFIRM_COPY;

describe('what the lobby offers (iOS TournamentLobbyMenu.items)', () => {
  it.each([
    // phase, host, spectator, choices
    ['lobby', false, false, [CHOICE.LEAVE]],
    ['lobby', true, false, [CHOICE.LEAVE, CHOICE.END]],
    ['round_active', true, false, [CHOICE.LEAVE, CHOICE.END]],
    ['between_rounds', true, false, [CHOICE.LEAVE, CHOICE.END]],
    // the cut: Leave in the cut's view, never End (as the web drew it before)
    ['cut', true, false, [CHOICE.LEAVE]],
    ['cut', false, false, [CHOICE.LEAVE]],
    ['cut', false, true, [CHOICE.STOP_WATCHING]],
    ['round_active', false, true, [CHOICE.STOP_WATCHING]],
    // over: only Return to Main Room
    ['complete', true, false, []],
    ['complete', false, true, []],
  ])('%s, host %s, spectator %s', (phase, isHost, isSpectator, expected) => {
    expect(tournamentChoices({ phase, isHost, isSpectator })).toEqual(expected);
  });

  it('stillOffers drops End once the role or the phase moves on', () => {
    expect(stillOffers(CHOICE.END, { phase: 'lobby', isHost: true })).toBe(true);
    expect(stillOffers(CHOICE.END, { phase: 'lobby', isHost: false })).toBe(false);
    expect(stillOffers(CHOICE.END, { phase: 'cut', isHost: true })).toBe(false);
    expect(stillOffers(CHOICE.LEAVE, { phase: 'complete' })).toBe(false);
    expect(stillOffers(CHOICE.LEAVE, { phase: 'lobby', isSpectator: true })).toBe(false);
  });

  it('what each sends: End is still cancelTournament on the wire', () => {
    expect(CHOICE_EVENT).toEqual({ leave: 'leaveTournament', end: 'cancelTournament', stopWatching: 'leaveTournament' });
  });
});

describe('the dialogs\' words (exactly iOS\'s; never a bare Cancel)', () => {
  it('titles, confirm and keep buttons', () => {
    expect(confirmWords(CHOICE.LEAVE)).toEqual({ title: 'Leave tournament?', confirm: 'Leave Tournament', keep: 'Stay' });
    expect(confirmWords(CHOICE.END)).toEqual({ title: 'End tournament?', confirm: 'End Tournament', keep: 'Keep Tournament' });
    expect(confirmWords(CHOICE.STOP_WATCHING)).toEqual({ title: 'Stop watching?', confirm: 'Stop Watching', keep: 'Keep Watching' });
    for (const c of Object.values(CHOICE)) {
      expect(confirmWords(c).keep).not.toBe('Cancel');
      expect(confirmWords(c).confirm).not.toBe('Cancel');
    }
  });

  it('the sentences: iOS\'s Copy with every "closes" now "ends"', () => {
    expect(C.endsAlone).toBe('The tournament ends, since nobody else has joined.');
    expect(C.endsNobodyConnected).toBe('The tournament ends, since nobody else is connected.');
    expect(C.rejoinWhileWaiting).toBe("You can join again while it's waiting to start.");
    expect(C.noWayBack).toBe("You can't come back to this tournament, and you won't be among the winners.");
    expect(C.outOfTheCut).toBe("You'll be out of cut for a buck.");
    expect(C.newHost).toBe('Another player becomes the host.');
    for (const text of Object.values(C)) expect(text).not.toMatch(/closes/);
  });
});

describe('confirmMessage (iOS TournamentLobbyMenu.confirmMessage)', () => {
  // choice, phase, host, othersConnected, othersPresent, message
  it.each([
    [CHOICE.END, 'lobby', true, 2, 2, 'The tournament ends for everyone before it starts.'],
    [CHOICE.END, 'round_active', true, 2, 2, 'The tournament ends for everyone, and any games still in play stop now.'],
    [CHOICE.END, 'between_rounds', true, 0, 0, 'The tournament ends for everyone, and any games still in play stop now.'],
    // the lobby: alone, a member, the host
    [CHOICE.LEAVE, 'lobby', true, 0, 0, 'The tournament ends, since nobody else has joined.'],
    [CHOICE.LEAVE, 'lobby', false, 0, 0, 'The tournament ends, since nobody else has joined.'],
    [CHOICE.LEAVE, 'lobby', false, 2, 2, "You can join again while it's waiting to start."],
    [CHOICE.LEAVE, 'lobby', true, 2, 2, "You can join again while it's waiting to start. Another player becomes the host."],
    // a lobby restored after a deploy: its disconnected members hold it open (othersPresent)
    [CHOICE.LEAVE, 'lobby', true, 0, 2, "You can join again while it's waiting to start. Another player becomes the host."],
    // begun: no way back; between rounds with nobody else connected it ends
    [CHOICE.LEAVE, 'round_active', false, 2, 2, "You can't come back to this tournament, and you won't be among the winners."],
    [CHOICE.LEAVE, 'round_active', true, 2, 2, "You can't come back to this tournament, and you won't be among the winners. Another player becomes the host."],
    [CHOICE.LEAVE, 'round_active', true, 0, 2, "You can't come back to this tournament, and you won't be among the winners."],
    [CHOICE.LEAVE, 'between_rounds', true, 0, 2, 'The tournament ends, since nobody else is connected.'],
    [CHOICE.LEAVE, 'between_rounds', false, 0, 0, 'The tournament ends, since nobody else is connected.'],
    [CHOICE.LEAVE, 'between_rounds', false, 1, 1, "You can't come back to this tournament, and you won't be among the winners."],
    [CHOICE.LEAVE, 'between_rounds', true, 1, 3, "You can't come back to this tournament, and you won't be among the winners. Another player becomes the host."],
    // the cut
    [CHOICE.LEAVE, 'cut', false, 2, 2, "You'll be out of cut for a buck."],
    [CHOICE.LEAVE, 'cut', true, 2, 2, "You'll be out of cut for a buck. Another player becomes the host."],
    [CHOICE.LEAVE, 'cut', true, 0, 2, "You'll be out of cut for a buck."],
    // a spectator
    [CHOICE.STOP_WATCHING, 'lobby', false, 3, 3, 'You go back to the main room.'],
    [CHOICE.STOP_WATCHING, 'cut', false, 3, 3, 'You go back to the main room.'],
  ])('%s in %s (host %s, %i connected / %i present)', (choice, phase, isHost, othersConnected, othersPresent, expected) => {
    expect(confirmMessage(choice, { phase, isHost, othersConnected, othersPresent })).toBe(expected);
  });

  it('otherMembers counts everyone but me, connected or not', () => {
    const players = [
      { username: 'me', connected: true },
      { username: 'bo', connected: true },
      { username: 'cy', connected: false },
      { username: 'di' },
    ];
    expect(otherMembers(players, 'me')).toEqual({ othersConnected: 2, othersPresent: 3 });
    expect(otherMembers([{ username: 'me' }], 'me')).toEqual({ othersConnected: 0, othersPresent: 0 });
    expect(otherMembers(null, 'me')).toEqual({ othersConnected: 0, othersPresent: 0 });
  });
});
