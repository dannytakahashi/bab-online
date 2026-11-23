/**
 * Which sound a table event makes (owner 2026-11-15). handlers/
 * gameHandlers.js calls these AFTER GameState applied the event, so the
 * state is the table with it:
 *
 *   playerDrew    draw (a card variant at DRAW_GAIN), once per new draw
 *                 order, mine and the bots'; draws that arrive together
 *                 (the 30 s auto-draws) come DRAW_SPACING_MS apart
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
 *   gameEnd       by my team's final score against the other's (owner
 *                 2026-11-22): gameend-win (a brass fanfare) above it,
 *                 gameend-lose (the sad trombone, "wah, wah, wah") below
 *                 it, gameend (the soft arpeggio) for a tie, no team (a
 *                 spectator) or no score; a lazy watcher keeps its seat's
 *                 team; GAME_END_AFTER_HAND_S
 *                 after the last hand's made / set (the server sends both
 *                 in one tick)
 *   bidClock      the bid clock's tune (owner 2026-11-18), for everyone at
 *                 the table (seats, lazy watchers, spectators): it follows
 *                 GameState.bidClock (_syncTune), END-aligned with the
 *                 clock's deadline (the offset into the file is the decoded
 *                 file's length minus the time left), not started with less
 *                 than TUNE_MIN_START_MS left, kept when within
 *                 TUNE_RESYNC_MS of where it should be (else it seeks).
 *                 Every event that clears the clock stops it (a fade), at
 *                 the TOP of its method, before any live gate (a replay
 *                 must not leave it playing); a timeout's stop lets its end
 *                 cue ring out detached from the clock (_ringing: the
 *                 bidReceived / updateTurn right after it do not cut it;
 *                 gameEnd, abort, leaving, a disconnect, reset and a new
 *                 clock do). It is the one sound a snapshot may START (it is
 *                 state, not news), and the tune is never gated on `live`
 *                 (bidClock is unsequenced: never replayed). Sound coming
 *                 back (unmute, the files decoded, the tab visible again:
 *                 installTableSoundSync) starts it at the current offset
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
import {
  bidClockNow, BID_CLOCK_SOUND, TUNE_RESYNC_MS, TUNE_MIN_START_MS, TUNE_RING_MAX_MS, TUNE_FADE_S,
} from '../state/bidClock.js';

/** The over-trump accent: just after the card's sound, a little quieter. */
export const OVER_TRUMP_DELAY_S = 0.09;
export const OVER_TRUMP_GAIN = 0.8;
/** The turn chime is a reminder: it sounds only if my turn is still open this long after it began. */
export const TURN_IDLE_MS = 5000;
/** The flourish after the last hand's made / set, not on top of it. */
export const GAME_END_AFTER_HAND_S = 0.5;
/** A spectator's hand end: made, quieter (no team to have made it). */
export const SPECTATOR_HAND_END_GAIN = 0.6;
/** A draw for deal's card: a card take, a little under a played card. */
export const DRAW_GAIN = 0.8;
/** Draws that arrive together are heard one by one, this far apart. */
export const DRAW_SPACING_MS = 150;

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
    this._drawTimer = null;
    this._drawsWaiting = 0;
    // the bid clock's tune: {handle, position, deadline} while it follows a clock
    this._tune = null;
    // a timed-out tune ringing out its last fraction (detached from the clock)
    this._ringing = null;
    this.reset();
  }

  // ---------- the bid clock's tune ----------

  _stopHandle(handle, fadeS = TUNE_FADE_S) {
    try {
      handle?.stop?.(fadeS);
    } catch {
      // a stub handle
    }
  }

  _cutRinging() {
    const r = this._ringing;
    this._ringing = null;
    if (r) this._stopHandle(r);
  }

  /**
   * Make the tune match GameState.bidClock: start it, keep it, seek it or
   * stop it.
   * @param {Object} [opts]
   * @param {boolean} [opts.letRing] - a stop for a timeout: let its end ring
   * @returns {boolean} whether a tune follows the clock now
   */
  _syncTune({ letRing = false } = {}) {
    let clock = null;
    try {
      clock = this._state().bidClock || null;
    } catch {
      clock = null;
    }
    const t = this._tune;
    const now = bidClockNow();
    if (!clock) {
      if (!t) return false;
      this._tune = null;
      const left = t.deadline - now;
      if (letRing && left <= TUNE_RING_MAX_MS && t.handle.playing) {
        this._cutRinging();
        this._ringing = t.handle;
      } else {
        this._stopHandle(t.handle);
      }
      return false;
    }
    const remaining = clock.deadline - now;
    let sound = null;
    let length = null;
    try {
      sound = this._sound();
      length = sound.duration?.(BID_CLOCK_SOUND) ?? null;
    } catch {
      sound = null;
    }
    if (length === null) length = clock.durationMs / 1000;
    const offset = Math.max(0, length - remaining / 1000);
    if (t && t.position === clock.position && t.handle.playing && Math.abs(t.deadline - clock.deadline) <= TUNE_RESYNC_MS) {
      // where it plays now against where it should (a context that was
      // suspended, a tab in the background, stands still)
      const at = t.handle.position;
      if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(at - offset) * 1000 <= TUNE_RESYNC_MS) return true;
    }
    if (t) {
      this._tune = null;
      this._stopHandle(t.handle);
    }
    // a new clock: the last one's ringing end goes
    this._cutRinging();
    if (remaining < TUNE_MIN_START_MS || !sound) return false;
    let handle = null;
    try {
      handle = sound.start?.(BID_CLOCK_SOUND, { offset }) || null;
    } catch {
      handle = null;
    }
    if (!handle) return false;
    this._tune = { handle, position: clock.position, deadline: clock.deadline };
    return true;
  }

  /** bidClock (GameState applied it): a timeout's stop lets the tune's end ring. */
  bidClock(data) {
    return this._syncTune({ letRing: data?.running === false && data?.reason === 'timeout' });
  }

  /**
   * The tune follows the clock again: a clearing event with no other sound
   * (doneBidding, destroyHands), or sound came back (installTableSoundSync).
   */
  syncTune() {
    return this._syncTune();
  }

  /** Stop the tune and any ringing end at once (gameEnd, abort, leaving, a disconnect, reset). */
  stopTune() {
    const t = this._tune;
    this._tune = null;
    if (t) this._stopHandle(t.handle);
    this._cutRinging();
  }

  /** A tune is playing for the clock (tests). */
  get tunePlaying() {
    return !!this._tune?.handle?.playing;
  }

  /** abortGame */
  abort() {
    this.stopTune();
  }

  /** leftGame */
  left() {
    this.stopTune();
  }

  /** My socket dropped (critic C4): the server may bid without me hearing of it. */
  disconnected() {
    this.stopTune();
  }

  /** One draw's card now; the next waiting one DRAW_SPACING_MS later. */
  _playDraw() {
    const played = this._play('draw', { gain: DRAW_GAIN });
    this._drawTimer = this._timers.set(() => {
      this._drawTimer = null;
      if (this._drawsWaiting > 0) {
        this._drawsWaiting--;
        this._playDraw();
      }
    }, DRAW_SPACING_MS);
    return played;
  }

  _cancelDraws() {
    if (this._drawTimer !== null) {
      try { this._timers.clear(this._drawTimer); } catch { /* a stub clock */ }
      this._drawTimer = null;
    }
    this._drawsWaiting = 0;
  }

  /** Draw sounds waiting their turn (tests). */
  get drawsWaiting() {
    return this._drawsWaiting;
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
    this._cancelDraws();
    this.stopTune();
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
    // the one sound a snapshot may start: the clock is state
    this._syncTune();
    this._wasMyTurn = this._myTurnNow();
    this._pendingDeal = null;
    // a render draws the trump as it is: nothing to wait for
    this._awaitTrump = false;
    this._pendingTurn = false;
    this._cancelTurnReminder();
    this._cancelDraws();
  }

  /**
   * playerDrew (GameState applied it): a card turned up in the draw for
   * deal. `added` is false for a draw order already shown (a re-send).
   * @returns {boolean} whether it sounded now or waits its turn
   */
  drew(added = true) {
    if (!added || !this.live) return false;
    if (this._drawTimer !== null) {
      this._drawsWaiting++;
      return true;
    }
    return this._playDraw();
  }

  /** gameStart (GameState applied the deal): the sound waits for the cards. */
  deal() {
    this._syncTune();
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
    this._syncTune();
    if (data?.position && data.position === this._state().position) {
      this._wasMyTurn = false;
      this._pendingTurn = false;
      this._cancelTurnReminder();
    }
  }

  /** updateTurn (doneBidding's lead is announced by the updateTurn after it). */
  turn() {
    this._syncTune();
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

  /**
   * gameEnd: after the last hand's made / set when that has just started.
   * gameend-win / gameend-lose for my team's win / loss (its final score
   * above / below the other's), else gameend (a tie, a spectator, no score).
   */
  gameEnd(data) {
    this.stopTune();
    this._wasMyTurn = false;
    this._cancelTurnReminder();
    this._pendingDeal = null;
    this._awaitTrump = false;
    this._pendingTurn = false;
    const since = this._handEndAt === null ? Infinity : (this._now() - this._handEndAt) / 1000;
    this._handEndAt = null;
    if (!this.live) return false;
    const delay = since < GAME_END_AFTER_HAND_S ? GAME_END_AFTER_HAND_S - since : 0;
    return this._play(this._gameEndSound(data), delay > 0 ? { delay } : undefined);
  }

  /** gameEnd's sound from my team's final score against the other's (gameEnd's score {team1, team2}). */
  _gameEndSound(data) {
    const parity = this._myParity();
    const t1 = data?.score?.team1, t2 = data?.score?.team2;
    if (parity === null || typeof t1 !== 'number' || typeof t2 !== 'number') return 'gameend';
    const [mine, theirs] = parity === 1 ? [t1, t2] : [t2, t1];
    if (mine === theirs) return 'gameend';
    return mine > theirs ? 'gameend-win' : 'gameend-lose';
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

/**
 * Sound coming back starts the tune at the current offset: unmute or a
 * volume change (onChange), the files decoded or the context running
 * (onReady), the tab visible again (a tune is never started in a hidden
 * tab; one already playing goes on). main.js startApp installs it once.
 * @returns {Function} uninstall
 */
export function installTableSoundSync({ sound = getSoundManager(), doc = globalThis.document, sounds = getTableSounds } = {}) {
  const sync = () => {
    try {
      sounds().syncTune();
    } catch {
      // never throws
    }
  };
  const offReady = sound?.onReady?.(sync);
  const offChange = sound?.onChange?.(sync);
  const onVisible = () => {
    if (!doc?.hidden) sync();
  };
  doc?.addEventListener?.('visibilitychange', onVisible);
  return () => {
    offReady?.();
    offChange?.();
    doc?.removeEventListener?.('visibilitychange', onVisible);
  };
}
