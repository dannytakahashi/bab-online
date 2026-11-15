/**
 * Which sound a table event makes (owner 2026-11-15). handlers/
 * gameHandlers.js calls these AFTER GameState applied the event, so the
 * state is the table with it:
 *
 *   gameStart     deal, when the cards go down (main.js showCards ->
 *                 dealShown: after the first hand's fade or the whisk)
 *   cardPlayed    card (a random variant), mine and bots' included; an
 *                 over-trump (rules/overTrump.js) layers overtrump just after
 *   updateTurn    turn, a reminder: only when MY turn to bid or play (not a
 *                 spectator, not a lazy seat the bot plays) is still open
 *                 TURN_IDLE_MS after it began (owner 2026-11-15: a chime on
 *                 every turn was too noisy); my own bid or card, the turn
 *                 moving on, a deal, a snapshot or the game end cancels it.
 *                 A bid turn before this deal's trump is face up counts from
 *                 the flip (main.js onFlipped -> trumpShown): the server
 *                 sends the next hand's updateTurn with handComplete, before
 *                 the cards and the bid panel are there
 *   trickComplete trick-ours when my team took it, else trick
 *   handComplete  made / set: my team's tricks against its bid total
 *   gameEnd       gameend, GAME_END_AFTER_HAND_S after the last hand's
 *                 made / set (the server sends both in one tick)
 *
 * A spectator hears the table (deal, cards, over-trump, trick, hand end,
 * game end) but no turn cue. It has no team, so its trick is the neutral
 * one and its hand end a quieter made (the score is in, no verdict); a
 * lazy watcher keeps its seat's team. Nothing plays while the event is not live: the seq
 * gate replaying or flushing buffered events (SeqGate.replaying). A
 * snapshot (rejoin, restore, resync, spectate; state/tableSync.js) plays
 * nothing and calls synced(), so the turn it shows is not an edge. The
 * SoundManager adds the mute, the hidden tab and the throttle.
 */

import { getSoundManager } from './SoundManager.js';
import { getGameState, PHASE } from '../state/GameState.js';
import { getSeqGate } from '../state/SeqGate.js';
import { isOverTrump } from '../rules/overTrump.js';
import { bidTotalsFor } from '../rules/bids.js';

/** The over-trump accent: just after the card's sound, a little quieter. */
export const OVER_TRUMP_DELAY_S = 0.09;
export const OVER_TRUMP_GAIN = 0.8;
/** The turn chime is a reminder: it sounds only if my turn is still open this long after it began. */
export const TURN_IDLE_MS = 5000;
/** The flourish after the last hand's made / set, not on top of it. */
export const GAME_END_AFTER_HAND_S = 0.5;
/** A spectator's hand end: made, quieter (no team to have made it). */
export const SPECTATOR_HAND_END_GAIN = 0.6;

export class TableSounds {
  /**
   * @param {Object} [deps]
   * @param {Function} [deps.sound] - () => SoundManager
   * @param {Function} [deps.state] - () => GameState
   * @param {Function} [deps.replaying] - () => boolean, true while events are not live
   * @param {Function} [deps.now] - ms clock
   * @param {Object} [deps.timers] - {set(fn, ms), clear(handle)} for the turn reminder
   */
  constructor({
    sound = getSoundManager, state = getGameState, replaying = () => getSeqGate().replaying, now = () => Date.now(),
    timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  } = {}) {
    this._sound = sound;
    this._state = state;
    this._replaying = replaying;
    this._now = now;
    this._timers = timers;
    this._turnTimer = null;
    this.reset();
  }

  /** Start (or restart) the turn reminder: it sounds if my turn is still open TURN_IDLE_MS from now. */
  _armTurnReminder() {
    this._cancelTurnReminder();
    this._turnTimer = this._timers.set(() => {
      this._turnTimer = null;
      if (!this._wasMyTurn || !this._myTurnNow() || !this._iAct() || !this.live) return;
      this._play('turn');
    }, TURN_IDLE_MS);
  }

  _cancelTurnReminder() {
    if (this._turnTimer !== null) {
      try { this._timers.clear(this._turnTimer); } catch { /* a stub clock */ }
      this._turnTimer = null;
    }
  }

  /** A turn reminder is waiting (tests). */
  get turnReminderPending() {
    return this._turnTimer !== null;
  }

  reset() {
    this._cancelTurnReminder?.();
    this._wasMyTurn = false;
    this._pendingDeal = null;
    // a deal whose trump is not face up yet: a bid turn waits for it
    this._awaitTrump = false;
    this._pendingTurn = false;
    this._handEndAt = null;
  }

  get live() {
    try {
      return !this._replaying();
    } catch {
      return false;
    }
  }

  _play(name, opts) {
    try {
      return this._sound().play(name, opts);
    } catch {
      return false;
    }
  }

  /** A seat whose bid / play is mine to make (not a spectator, not a lazy seat). */
  _iAct() {
    const s = this._state();
    return !!s.position && !s.isSpectator && !s.isLazy;
  }

  /** My team's seat parity, null for a spectator (a lazy watcher keeps its seat). */
  _myParity() {
    const s = this._state();
    if (!s.position) return null;
    if (s.isSpectator && !s.isLazy) return null;
    return s.position % 2;
  }

  _myTurnNow() {
    const s = this._state();
    return !!s.position && s.currentTurn === s.position;
  }

  /** A snapshot replaced the table: what it shows is the baseline, not news. */
  synced() {
    this._wasMyTurn = this._myTurnNow();
    this._pendingDeal = null;
    // a render draws the trump as it is: nothing to wait for
    this._awaitTrump = false;
    this._pendingTurn = false;
    this._cancelTurnReminder();
  }

  /** gameStart (GameState applied the deal): the sound waits for the cards. */
  deal() {
    this._wasMyTurn = false;
    this._pendingDeal = this.live ? this._state().dealSeq : null;
    this._awaitTrump = true;
    this._pendingTurn = false;
    this._cancelTurnReminder();
  }

  /** This deal's trump is face up (the bid panel opens now): a bid turn that waited starts its reminder. */
  trumpShown() {
    const pending = this._pendingTurn;
    this._awaitTrump = false;
    this._pendingTurn = false;
    if (!pending || !this._wasMyTurn || !this._myTurnNow() || !this._iAct() || !this.live) return false;
    this._armTurnReminder();
    return true;
  }

  /** The deal's cards go down on the table (main.js showCards). */
  dealShown() {
    const seq = this._pendingDeal;
    this._pendingDeal = null;
    if (seq === null || seq !== this._state().dealSeq) return false;
    return this._play('deal');
  }

  /** bidReceived: my own bid ends my turn. */
  bid(data) {
    if (data?.position && data.position === this._state().position) {
      this._wasMyTurn = false;
      this._pendingTurn = false;
      this._cancelTurnReminder();
    }
  }

  /** updateTurn (doneBidding's lead is announced by the updateTurn after it). */
  turn() {
    const mine = this._myTurnNow();
    const edge = mine && !this._wasMyTurn;
    this._wasMyTurn = mine;
    if (!mine) {
      this._pendingTurn = false;
      this._cancelTurnReminder();
    }
    if (!edge || !this._iAct() || !this.live) return false;
    if (this._awaitTrump && this._state().phase === PHASE.BIDDING) {
      this._pendingTurn = true;
      return false;
    }
    // a reminder, not a cue: returns true when one is armed (it may never sound)
    this._armTurnReminder();
    return true;
  }

  /** cardPlayed */
  cardPlayed(data) {
    const s = this._state();
    if (data?.position && data.position === s.position) {
      this._wasMyTurn = false;
      this._cancelTurnReminder();
    }
    if (!this.live) return [];
    const played = [];
    if (this._play('card')) played.push('card');
    if (isOverTrump(s.currentTrick, s.trump) && this._play('overtrump', { delay: OVER_TRUMP_DELAY_S, gain: OVER_TRUMP_GAIN })) {
      played.push('overtrump');
    }
    return played;
  }

  /** trickComplete */
  trick(data) {
    if (!this.live || !Number.isInteger(data?.winner)) return false;
    const parity = this._myParity();
    const ours = parity !== null && data.winner % 2 === parity;
    return this._play(ours ? 'trick-ours' : 'trick');
  }

  /**
   * handComplete, BEFORE GameState.resetForNewHand (it reads the hand's
   * bids): made when my team's tricks reach its bid total (a bore = the
   * hand; rules/bids.js), as the server scores it.
   */
  handComplete(data) {
    if (!this.live) return false;
    const parity = this._myParity();
    let played;
    if (parity === null) {
      played = this._play('made', { gain: SPECTATOR_HAND_END_GAIN });
    } else {
      const s = this._state();
      const teamOne = parity === 1;
      const reported = teamOne ? data?.team1Tricks : data?.team2Tricks;
      const tricks = Number.isInteger(reported) ? reported : s.teamTricks;
      const bid = bidTotalsFor(s.bids, s.position, s.currentHand).team;
      played = this._play(tricks >= bid ? 'made' : 'set');
    }
    if (played) this._handEndAt = this._now();
    return played;
  }

  /** gameEnd: after the last hand's made / set when that has just started. */
  gameEnd() {
    this._wasMyTurn = false;
    this._cancelTurnReminder();
    this._pendingDeal = null;
    this._awaitTrump = false;
    this._pendingTurn = false;
    const since = this._handEndAt === null ? Infinity : (this._now() - this._handEndAt) / 1000;
    this._handEndAt = null;
    if (!this.live) return false;
    const delay = since < GAME_END_AFTER_HAND_S ? GAME_END_AFTER_HAND_S - since : 0;
    return this._play('gameend', delay > 0 ? { delay } : undefined);
  }
}

let instance = null;

export function getTableSounds() {
  if (!instance) instance = new TableSounds();
  return instance;
}

/** For tests. */
export function resetTableSounds(options) {
  instance = new TableSounds(options);
  return instance;
}
