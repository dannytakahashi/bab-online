/**
 * The draw's words (owner 2026-11-25): a casual table's "Draw for Deal",
 * where the two highest cards are partners, and a tournament table's draw
 * for first deal, whose teams the round's plan already set (startDraw.teams
 * / snapshot draw.teams; the draw decides only the seats and who deals
 * first). The iOS DrawCopy.swift mirrors these strings and its test reads
 * this file, so change them here and there together.
 *
 * Teams are named by their players, never "Team 1" / "T1" / "Your Team"
 * (owner rule): the viewer's own team first as "You & <partner>", a
 * spectator's in plan order with full names; a bot keeps its persona name.
 */

/** The casual draw's words (the iOS DrawPhaseView's, with "Click" for "Tap"). */
export const CASUAL = Object.freeze({
  title: 'Draw for Deal',
  rules: 'The two highest cards are partners; the highest deals.',
});

/** A tournament table's draw: the teams are set, the draw is for first deal. */
export const PLANNED = Object.freeze({
  title: 'Draw for First Deal',
  rules: 'Partners are set for this round. The highest card deals first.',
});

/** The prompt under the deck. */
export const PROMPT = 'Click a card to draw';

/** The draw's title: `planned` (the table has teams) or the casual one. */
export function title(planned) {
  return planned ? PLANNED.title : CASUAL.title;
}

/** The rule under the title. */
export function rules(planned) {
  return planned ? PLANNED.rules : CASUAL.rules;
}

const nameOf = (p) => String(p?.username ?? '').trim() || 'Player';

/**
 * The teams in display order: the viewer's team first with the viewer
 * first in it (`me` matches a non-bot player's username); otherwise plan
 * order.
 * @param {Array<Array<{username: string, isBot?: boolean}>>} teams - 2 x 2
 * @param {string|null} me
 * @returns {{teams: Array<Array<{name: string, mine: boolean}>>, mine: boolean}}
 */
export function orderTeams(teams, me = null) {
  const isMe = (p) => !!me && !p?.isBot && nameOf(p) === me;
  const list = (Array.isArray(teams) ? teams : []).map((t) => (Array.isArray(t) ? t : []));
  const at = list.findIndex((t) => t.some(isMe));
  const ordered = at > 0 ? [list[at], ...list.filter((_, i) => i !== at)] : list;
  return {
    mine: at >= 0,
    teams: ordered.map((t) => {
      const people = t.map((p) => ({ name: nameOf(p), mine: isMe(p) }));
      return people.some((p) => p.mine) ? [...people.filter((p) => p.mine), ...people.filter((p) => !p.mine)] : people;
    }),
  };
}

/**
 * One line: "You & Hannah vs Danny & Clara" (the viewer's team first), or
 * "Hannah & Danny vs Clara & 🤖 Mary" for a spectator. '' without teams.
 */
export function teamsLine(teams, me = null) {
  const { teams: ordered } = orderTeams(teams, me);
  if (ordered.length !== 2) return '';
  return ordered.map((t) => t.map((p) => (p.mine ? 'You' : p.name)).join(' & ')).join(' vs ');
}

/**
 * What a screen reader says for the line: "Partners: you and Hannah versus
 * Danny and Clara". '' without teams.
 */
export function teamsSpoken(teams, me = null) {
  const { teams: ordered } = orderTeams(teams, me);
  if (ordered.length !== 2) return '';
  return `Partners: ${ordered.map((t) => t.map((p) => (p.mine ? 'you' : p.name)).join(' and ')).join(' versus ')}`;
}

// The planned teams' wire check lives with the state (state/drawTeams.js)
export { validTeams } from '../state/drawTeams.js';
