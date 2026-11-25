/**
 * The page's one Cut for a buck state (state/cutForABuck.js), kept apart
 * from the tournament lobby's DOM: the events come in on any screen (the
 * score screen of the last table above all: the cut starts a moment after
 * its gameEnd) and the lobby reads it when it renders. Cleared when the
 * tournament ends or the page leaves it.
 */
import { cutReduce, cutFromWire } from '../../state/cutForABuck.js';

let state = null;
let tournamentId = null;
const listeners = new Set();

function emit(type) {
  for (const fn of [...listeners]) {
    try {
      fn(state, type);
    } catch (err) {
      console.warn('[Cut] listener failed:', err?.message || err);
    }
  }
}

/** The state now (null: no cut). */
export function getCutState() {
  return state;
}

/** The tournament the state belongs to. */
export function getCutTournamentId() {
  return tournamentId;
}

/** A cut event: 'start' | 'round' | 'drew' | 'left' | 'reveal' | 'winner'. */
export function applyCutEvent(type, data, { tournament = null, now = Date.now() } = {}) {
  if (tournament && tournament !== tournamentId) {
    tournamentId = tournament;
    if (type !== 'start') state = null;
  }
  state = cutReduce(state, type, data, now);
  emit(type);
  return state;
}

/** tournamentJoined: its cut (phase 'cut'), or none (any other phase). */
export function restoreCut(tournament, wire, { now = Date.now() } = {}) {
  tournamentId = tournament || null;
  state = wire ? cutFromWire(wire, now) : null;
  emit('restore');
  return state;
}

/** The tournament ended or the page left it. */
export function clearCut() {
  if (!state && !tournamentId) return;
  state = null;
  tournamentId = null;
  emit('clear');
}

/** fn(state, type) after every change; returns an unsubscribe. */
export function onCutChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
