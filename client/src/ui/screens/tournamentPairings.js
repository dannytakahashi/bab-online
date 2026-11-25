/**
 * The tournament screen's pairings (owner 2026-11-25: partners are shown
 * openly): the latest round's tables ("Round 2 pairings", my table first)
 * and, for a member, "Partners so far" (each round's partner: a name, "a
 * bot", or "sat out"); a spectator gets every round's tables instead. From
 * the tournament events' `pairings` (server TournamentState.pairingsWire:
 * [{roundNumber, tables: [{gameId, teams: [[username | null] x 2] x 2]}]},
 * null for a bot). Not a whole-tournament chart: the server plans each
 * round from who is there, so only rounds already planned are shown.
 *
 * Teams are named by their players, never by number (owner rule); the
 * viewer's own team comes first as "You & ...". iOS mirrors the words
 * (TournamentPairingRules).
 */

import { el } from '../kit/index.js';

const A_BOT = 'a bot';

/** Every round entry that is well formed, in round order. */
export function cleanPairings(pairings) {
  if (!Array.isArray(pairings)) return [];
  const ok = (team) => Array.isArray(team) && team.length === 2 && team.every((u) => u === null || (typeof u === 'string' && u));
  return pairings
    .filter((r) => r && Number.isInteger(r.roundNumber) && r.roundNumber >= 1 && Array.isArray(r.tables))
    .map((r) => ({
      roundNumber: r.roundNumber,
      tables: r.tables.filter((t) => t && Array.isArray(t.teams) && t.teams.length === 2 && t.teams.every(ok))
        .map((t) => ({ gameId: typeof t.gameId === 'string' ? t.gameId : null, teams: t.teams.map((team) => [...team]) })),
    }))
    .sort((a, b) => a.roundNumber - b.roundNumber);
}

/** My table in a round (or null): the one with my name on a team. */
function tableOf(round, me) {
  return (me && round.tables.find((t) => t.teams.some((team) => team.includes(me)))) || null;
}

/** One team in words: "You & Hannah", "Ed & a bot", "two bots". */
function teamWords(team, me) {
  const mine = !!me && team.includes(me);
  if (mine) {
    const other = team[0] === me ? team[1] : team[0];
    return `You & ${other === null ? A_BOT : other}`;
  }
  if (team.every((u) => u === null)) return 'two bots';
  return team.map((u) => (u === null ? A_BOT : u)).join(' & ');
}

/**
 * A table in words, my team first: "You & Hannah vs Danny & Clara",
 * "Ed & a bot vs Fay & a bot", "You & a bot vs two bots".
 */
export function pairingLine(teams, me = null) {
  const list = Array.isArray(teams) ? teams : [];
  const at = me ? list.findIndex((t) => t.includes(me)) : -1;
  const ordered = at > 0 ? [list[at], ...list.filter((_, i) => i !== at)] : list;
  return ordered.map((t) => teamWords(t, me)).join(' vs ');
}

/** The same table for a screen reader ("and", "versus"). */
export function pairingSpoken(teams, me = null) {
  return pairingLine(teams, me).replace(/ & /g, ' and ').replace(/ vs /g, ' versus ').replace(/^You /, 'you ');
}

/**
 * My partner in each round so far: [{roundNumber, partner}] with partner a
 * username, 'a bot', or 'sat out' (no table of the round names me: I sat
 * out, or my table never started).
 */
export function partnersSoFar(pairings, me) {
  return cleanPairings(pairings).map((round) => {
    const table = tableOf(round, me);
    if (!table) return { roundNumber: round.roundNumber, partner: 'sat out' };
    const team = table.teams.find((t) => t.includes(me));
    const other = team[0] === me ? team[1] : team[0];
    return { roundNumber: round.roundNumber, partner: other === null ? A_BOT : other };
  });
}

/** The latest round's tables, mine first. */
export function latestRound(pairings, me = null) {
  const rounds = cleanPairings(pairings);
  const round = rounds[rounds.length - 1];
  if (!round) return null;
  const mine = tableOf(round, me);
  return { roundNumber: round.roundNumber, tables: mine ? [mine, ...round.tables.filter((t) => t !== mine)] : round.tables, mine };
}

/** Is there anything to show (a table with two members anywhere)? */
export function hasPairings(pairings) {
  return cleanPairings(pairings).some((r) => r.tables.some((t) => t.teams.flat().filter(Boolean).length >= 2));
}

function tableRow(teams, me, mine, n) {
  const row = el('li', { className: `tournament-pairings__row${mine ? ' is-mine' : ''}`, attrs: { 'data-row': String(n), 'aria-label': pairingSpoken(teams, me) } });
  row.textContent = pairingLine(teams, me);
  return row;
}

/**
 * Draw the pairings into `container` (replacing what it had); hidden when
 * there is nothing to show.
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {Array} opts.pairings - the latest `pairings` the server sent
 * @param {string|null} opts.me - my username
 * @param {boolean} [opts.spectator] - every round's tables, no "Partners so far"
 */
export function renderPairings(container, { pairings, me = null, spectator = false } = {}) {
  if (!container) return;
  container.replaceChildren();
  const show = hasPairings(pairings);
  container.hidden = !show;
  if (!show) return;
  const who = spectator ? null : me;
  const rounds = cleanPairings(pairings);
  let n = 0;
  if (spectator) {
    for (const round of [...rounds].reverse()) {
      if (!round.tables.length) continue;
      container.appendChild(el('h3', { className: 'section-title section-title--sm', text: `Round ${round.roundNumber} pairings` }));
      const list = el('ul', { className: 'tournament-pairings__list', attrs: { 'data-round': String(round.roundNumber) } });
      for (const t of round.tables) list.appendChild(tableRow(t.teams, null, false, n++));
      container.appendChild(list);
    }
    return;
  }
  const latest = latestRound(pairings, who);
  if (latest && latest.tables.length) {
    container.appendChild(el('h3', { className: 'section-title section-title--sm', attrs: { id: 'tournamentPairingsRound' }, text: `Round ${latest.roundNumber} pairings` }));
    const list = el('ul', { className: 'tournament-pairings__list', attrs: { 'data-round': String(latest.roundNumber) } });
    for (const t of latest.tables) list.appendChild(tableRow(t.teams, who, t === latest.mine, n++));
    container.appendChild(list);
  }
  const partners = partnersSoFar(pairings, who);
  if (who && partners.length) {
    container.appendChild(el('h3', { className: 'section-title section-title--sm', attrs: { id: 'tournamentPartnersSoFar' }, text: 'Partners so far' }));
    const list = el('ul', { className: 'tournament-pairings__partners' });
    for (const p of partners) {
      list.appendChild(el('li', { className: 'tournament-pairings__partner', text: `Round ${p.roundNumber} · ${p.partner}` }));
    }
    container.appendChild(list);
  }
}
