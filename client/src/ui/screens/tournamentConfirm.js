/**
 * The tournament lobby's destructive choices and their confirm dialogs'
 * words (owner 2026-11-26: the web asks before Leave and End Tournament, in
 * iOS's words: TournamentLobbyMenu in iOSClient/BABOnline/State/
 * TournamentLobbySlot.swift). Pure: TournamentLobby.js draws the dialog.
 *
 * One change was decided for both clients the same day: every "closes" in
 * iOS's messages reads "ends" ("The tournament ends, since nobody else has
 * joined."). The host's choice is "End Tournament" (the server event stays
 * cancelTournament). Never a bare "Cancel" button in these dialogs: the keep
 * button says what it keeps.
 */

/** The choices (iOS's items: leave, cancel = End Tournament, stopWatching). */
export const CHOICE = Object.freeze({ LEAVE: 'leave', END: 'end', STOP_WATCHING: 'stopWatching' });

/** What each choice sends once confirmed. */
export const CHOICE_EVENT = Object.freeze({
  [CHOICE.LEAVE]: 'leaveTournament',
  [CHOICE.END]: 'cancelTournament',
  [CHOICE.STOP_WATCHING]: 'leaveTournament',
});

/** The cut's phase (the server's TournamentState phase 'cut'). */
const CUT_PHASE = 'cut';

/**
 * The choices the lobby offers (iOS's TournamentLobbyMenu.items, which the
 * web already matched: Leave on the lobby's button row and in the cut's view,
 * End only for the host and never during the cut, nothing once complete).
 * @param {{phase: string, isHost: boolean, isSpectator: boolean}} s
 * @returns {string[]}
 */
export function tournamentChoices({ phase, isHost = false, isSpectator = false } = {}) {
  if (phase === 'complete') return [];
  if (isSpectator) return [CHOICE.STOP_WATCHING];
  const items = [CHOICE.LEAVE];
  if (isHost && phase !== CUT_PHASE) items.push(CHOICE.END);
  return items;
}

/** Does the lobby still offer the choice (a confirm for one it does not is dropped). */
export function stillOffers(choice, state) {
  return tournamentChoices(state).includes(choice);
}

/** The sentences (iOS's TournamentLobbyMenu.Copy, "closes" now "ends"). */
export const CONFIRM_COPY = Object.freeze({
  rejoinWhileWaiting: "You can join again while it's waiting to start.",
  endsAlone: 'The tournament ends, since nobody else has joined.',
  endsNobodyConnected: 'The tournament ends, since nobody else is connected.',
  noWayBack: "You can't come back to this tournament, and you won't be among the winners.",
  // lowercase mid-sentence (the owner's rule for the cut's name)
  outOfTheCut: "You'll be out of cut for a buck.",
  newHost: 'Another player becomes the host.',
  endBeforeStart: 'The tournament ends for everyone before it starts.',
  endInPlay: 'The tournament ends for everyone, and any games still in play stop now.',
  stopWatching: 'You go back to the main room.',
});

/** Each dialog's title and buttons (exactly iOS's words; the keep button is never "Cancel"). */
const DIALOG_WORDS = Object.freeze({
  [CHOICE.LEAVE]: { title: 'Leave tournament?', confirm: 'Leave Tournament', keep: 'Stay' },
  [CHOICE.END]: { title: 'End tournament?', confirm: 'End Tournament', keep: 'Keep Tournament' },
  [CHOICE.STOP_WATCHING]: { title: 'Stop watching?', confirm: 'Stop Watching', keep: 'Keep Watching' },
});

/** @returns {{title: string, confirm: string, keep: string}} */
export function confirmWords(choice) {
  return DIALOG_WORDS[choice];
}

/**
 * The other members, as iOS counts them: `othersConnected` the connected
 * members besides me, `othersPresent` every member besides me (in a lobby
 * restored after a deploy its members come back disconnected and hold it
 * open, so the lobby phase counts every row).
 * @param {Array<{username: string, connected?: boolean}>} players
 * @param {string} me
 */
export function otherMembers(players, me) {
  const others = (players || []).filter((p) => p && p.username !== me);
  return { othersConnected: others.filter((p) => p.connected !== false).length, othersPresent: others.length };
}

/**
 * What happens, in plain words, as the server does it (a port of iOS's
 * TournamentLobbyMenu.confirmMessage; its comments say why each case reads
 * as it does):
 * - the lobby phase: a member may join again while it waits to start; the
 *   host's role passes to another member; alone, the tournament is deleted;
 * - once begun a member who leaves is gone (no later rounds, no way back,
 *   never a winner); between rounds with nobody else connected the
 *   tournament is deleted;
 * - the cut: leaving takes me out of it.
 * @param {string} choice - CHOICE
 * @param {{phase: string, isHost: boolean, othersConnected: number, othersPresent: number}} s
 * @returns {string}
 */
export function confirmMessage(choice, { phase, isHost = false, othersConnected = 0, othersPresent = 0 } = {}) {
  const C = CONFIRM_COPY;
  switch (choice) {
    case CHOICE.END:
      return phase === 'lobby' ? C.endBeforeStart : C.endInPlay;
    case CHOICE.LEAVE:
      if (phase === 'lobby') {
        // alone in the lobby (the host, in practice: a lone member is handed the role)
        if (othersPresent === 0) return C.endsAlone;
        return isHost ? `${C.rejoinWhileWaiting} ${C.newHost}` : C.rejoinWhileWaiting;
      }
      if (phase === CUT_PHASE) {
        return isHost && othersConnected > 0 ? `${C.outOfTheCut} ${C.newHost}` : C.outOfTheCut;
      }
      if (phase === 'between_rounds' && othersConnected === 0) return C.endsNobodyConnected;
      return isHost && othersConnected > 0 ? `${C.noWayBack} ${C.newHost}` : C.noWayBack;
    case CHOICE.STOP_WATCHING:
      return C.stopWatching;
    default:
      return '';
  }
}
