/**
 * Which sound a table event makes (owner 2026-11-15). handlers/
 * gameHandlers.js calls these AFTER GameState applied the event, so the
 * state is the table with it:
 *
 *   gameStart     deal, when the cards go down (main.js showCards ->
 *                 dealShown: after the first hand's fade or the whisk)
 *   cardPlayed    card (a random variant), mine and bots' included; an
 *                 over-trump (rules/overTrump.js) layers overtrump just after
 *   updateTurn    turn, only on the edge into MY turn to bid or play (not a
 *                 spectator, not a lazy seat the bot plays)
 *   trickComplete trick-ours when my team took it, else trick
 *   handComplete  made / set: my team's tricks against its bid total
 *   gameEnd       gameend
 *
 * A spectator hears the table (deal, cards, over-trump, trick, game end)
 * but no turn cue and no made / set: it has no team (a lazy watcher keeps
 * its seat's team). Nothing plays while the event is not live: the seq
 * gate replaying or flushing buffered events (SeqGate.replaying). A
 * snapshot (rejoin, restore, resync, spectate; state/tableSync.js) plays
 * nothing and calls synced(), so the turn it shows is not an edge. The
 * SoundManager adds the mute, the hidden tab and the throttle.
 */

import { getSoundManager } from './SoundManager.js';
import { getGameState } from '../state/GameState.js';
import { getSeqGate } from '../state/SeqGate.js';
import { isOverTrump } from '../rules/overTrump.js';
import { bidTotalsFor } from '../rules/bids.js';

/** The over-trump accent: just after the card's sound, a little quieter. */
export const OVER_TRUMP_DELAY_S = 0.09;
export const OVER_TRUMP_GAIN = 0.8;

export class TableSounds {
  /**
   * @param {Object} [deps]
   * @param {Function} [deps.sound] - () => SoundManager
   * @param {Function} [deps.state] - () => GameState
   * @param {Function} [deps.replaying] - () => boolean, true while events are not live
   */
  constructor({ sound = getSoundManager, state = getGameState, replaying = () => getSeqGate().replaying } = {}) {
    this._sound = sound;
    this._state = state;
    this._replaying = replaying;
    this.reset();
  }

  reset() {
    this._wasMyTurn = false;
    this._pendingDeal = null;
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
  }

  /** gameStart (GameState applied the deal): the sound waits for the cards. */
  deal() {
    this._wasMyTurn = false;
    this._pendingDeal = this.live ? this._state().dealSeq : null;
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
    if (data?.position && data.position === this._state().position) this._wasMyTurn = false;
  }

  /** updateTurn (doneBidding's lead is announced by the updateTurn after it). */
  turn() {
    const mine = this._myTurnNow();
    const edge = mine && !this._wasMyTurn;
    this._wasMyTurn = mine;
    if (!edge || !this._iAct() || !this.live) return false;
    return this._play('turn');
  }

  /** cardPlayed */
  cardPlayed(data) {
    const s = this._state();
    if (data?.position && data.position === s.position) this._wasMyTurn = false;
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
    if (parity === null) return false;
    const s = this._state();
    const teamOne = parity === 1;
    const reported = teamOne ? data?.team1Tricks : data?.team2Tricks;
    const tricks = Number.isInteger(reported) ? reported : s.teamTricks;
    const bid = bidTotalsFor(s.bids, s.position, s.currentHand).team;
    return this._play(tricks >= bid ? 'made' : 'set');
  }

  /** gameEnd */
  gameEnd() {
    this._wasMyTurn = false;
    this._pendingDeal = null;
    if (!this.live) return false;
    return this._play('gameend');
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
