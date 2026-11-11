/**
 * Game pacing: the ONLY home of the server's presentation delays (how long
 * the table is held so people can see what happened, and how long bots
 * "think"). Safety timers (reconnect grace, abandon, draw watchdog) live in
 * SeatState.js and are not pacing.
 *
 * Consumers read `pacing(game).X` at call time; never destructure at import
 * (tests and the ambient overlay swap the active values).
 *
 * Profiles (env BAB_PACING):
 *   standard (default)  the tuned values below
 *   legacy              the values before the retune (owner rollback knob),
 *                       ambient pre-game timing included (no overlay)
 *   fast                dev only: every value at its floor (ignored, with a
 *                       warning, when NODE_ENV=production)
 *   zero                tests only (throws outside Jest / NODE_ENV=test)
 *
 * Bot think ranges are [min, span] pairs: delay = min + r * span, with one
 * Math.random() per action (BotPlayer.getActionDelay).
 *
 * Resume semantics: a hold (GameState.hold / scheduleResume) sets
 * game.resume = {kind, at}; the wire carries the remaining time as a
 * relative `resumeInMs` (contract/README.md), never an absolute time.
 *
 * Retuning: every non-zero profile must respect SHIPPED_IOS_FLOORS (the App
 * Store iOS build, 1.1.0 build 2, has no resumeInMs handling; pacing.test.js
 * enforces it). standard and legacy also still meet IOS_1_0_FLOORS (1.0.0,
 * cc9059f), because UPGRADE_GATE=off lets that build play again; going below
 * those needs the gate on (server/socket/upgradeGate.js). Measured budget: server/socket/__tests__/pacingBudget.test.js
 * (BAB_PACING_REPORT=1 prints the components). A 1-human/3-bot game with
 * the human acting instantly: legacy ~595 s, standard ~321 s (54%).
 *
 * Sensitivities (effect on that total; 91 tricks, ~173 bot follows,
 * ~29 bot last-card follows, ~59 leads after a trick, ~10 opening leads,
 * ~43 bot bids per game):
 *   +100 ms TRICK_VIEW_MS                     +9.1 s
 *   +100 ms mean BOT_PLAY (follow)            +17.3 s
 *   +100 ms mean BOT_FORCED_PLAY (last card)  +2.9 s
 *   +100 ms mean lead (BOT_LEAD_AFTER_TRICK)  +5.9 s
 *   +100 ms mean bid (BOT_BID/BOT_FIRST_BID)  +4.3 s
 *   TRICK_VIEW_MS 1000                        about -48% vs legacy
 *
 * Fairness: a bot's think range may depend on PUBLIC state only (see
 * BotController.actionKind). A quicker range for "exactly one legal card"
 * was tried and removed: it told the table the bot had just gone void.
 */

'use strict';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** The values before the retune (df59149). */
const LEGACY = {
    LOBBY_START_MS: 1500,
    PREDRAW_COUNTDOWN_MS: 2000,
    BOT_DRAW_STAGGER_MS: 800,
    BOT_DRAW: [500, 500],
    DRAW_REVEAL_MS: 1000,
    SEATING_TO_TEAMS_MS: 1000,
    TEAMS_MS: 3000,
    FIRST_HAND_TURN_MS: 1000,
    BOT_FIRST_BID: [1000, 1000],
    BOT_BID: [1000, 1000],
    BOT_LEAD_AFTER_BIDDING: [800, 700],
    BOT_PLAY: [800, 700],
    BOT_FORCED_PLAY: [800, 700],
    BOT_LEAD_AFTER_TRICK: [800, 700],
    TRICK_VIEW_MS: 2000,
    HAND_END_MS: 2000,
    GAME_END_MS: 2000,
    BOT_TRUMP_QUIP_MS: 5000,
    BOT_CHAT: [500, 500],
    ROUND_ANNOUNCE_MS: 1500,
    TABLE_COUNTDOWN_MS: 2000,
    AMBIENT_CHECK_MS: 15000,
    AMBIENT_RESTART_MS: 30000,
};

/**
 * The tuned family pacing. Every gap a human sees: a bot card lands before
 * the next one leaves (web fly-in 300 ms, iOS 250 ms), the full trick stays
 * visible ~0.8 s before it is collected, the 1.0.0 iOS app's collect
 * (0.4 s) and guarded clearTrick (0.7 s) finish before the next hand.
 * Values unchanged by the 1.1.0 floors (owner, 2026-11-11: no pacing change
 * yet); the iOS comments below describe 1.0.0 (setupGameUI, clearTrick),
 * whose floors these still meet for UPGRADE_GATE=off. What 1.1.0 alone
 * would allow: SHIPPED_IOS_FLOORS.
 */
const STANDARD = {
    ...LEGACY,
    // No game exists yet; clients only show the ready state
    LOBBY_START_MS: 1000,
    // Bot draws land at 0.8-1.1, 1.3-1.6, 1.8-2.1 s (web flip 250+250 ms;
    // iOS flips each slot on its own per-index delay)
    BOT_DRAW_STAGGER_MS: 500,
    BOT_DRAW: [300, 300],
    // positionUpdate is data only; with SEATING the full draw stays visible
    // >= 0.9 s on iOS (4th slot face up at +1.4 s, teams overlay fades in at
    // teamsAnnounced + 0.8 s)
    SEATING_TO_TEAMS_MS: 500,
    // Bot think time (min, span): natural jitter, quick when forced
    BOT_FIRST_BID: [900, 400],          // gameStart runs iOS setupGameUI
    BOT_BID: [550, 400],                // iOS bubble fades in 0.2 s
    BOT_LEAD_AFTER_BIDDING: [700, 300], // doneBidding: iOS 0.3 s overlay transition
    // A follow (any follow but the hand's last card). Must not depend on
    // hidden state: a quicker range for "one legal card" would reveal a
    // void (BotController.actionKind).
    BOT_PLAY: [350, 400],
    // The hand's last card (public: everyone sees one card left); min 350
    // leaves 50 ms over the web 300 ms fly-in for delivery jitter
    BOT_FORCED_PLAY: [350, 100],
    // After trickComplete: lands after the 1.0.0 iOS guarded clearTrick
    // (0.7 s), i.e. 0.3 s of jitter margin over its 0.4 s collect (web 0.5 s;
    // 1.1.0 needs only its 0.4 s collect)
    BOT_LEAD_AFTER_TRICK: [700, 200],
    // The completed trick before it is collected (both shipped clients
    // collect on trickComplete); the 4th card lands at 0.25/0.3 s
    TRICK_VIEW_MS: 1100,
    // Last trick -> next hand: 1.0.0 iOS collect 0.4 s + guarded clearTrick
    // 0.7 s (1.1.0: the 0.4 s collect)
    HAND_END_MS: 1000,
    // Last trick of the game -> gameEnd (GameEndView covers the table)
    GAME_END_MS: 1500,
    // Sharon's trump quip lands while the hand's bidding is still on
    BOT_TRUMP_QUIP_MS: 2500,
    // Ambient game (server/demo/ambientBots.js): the poll is O(1); the
    // unlisted gap between two games is about 5-10 s (was 50-65 s)
    AMBIENT_CHECK_MS: 5000,
    AMBIENT_RESTART_MS: 5000,
};

/**
 * Overlay for an ambient (demo) game before the deal while nobody watches
 * it: it is unlisted (GameManager.getInProgressGames skips the 'waiting' /
 * 'drawing' wire phases, i.e. CREATED through TEAMS_ANNOUNCED) and has no
 * humans, so nobody can see these stages. It is listed ~0.1 s after start
 * instead of ~7-9 s. The bot draw still draws its RNG (seeded runs keep
 * their stream). Exempt from SHIPPED_IOS_FLOORS and IOS_1_0_FLOORS.
 */
const AMBIENT_PREGAME = Object.freeze({
    BOT_DRAW_STAGGER_MS: 0,
    BOT_DRAW: Object.freeze([50, 0]),
    DRAW_REVEAL_MS: 0,
    SEATING_TO_TEAMS_MS: 0,
    TEAMS_MS: 0,
});
const PREGAME_STAGES = new Set(['CREATED', 'DRAWING', 'DRAW_RESOLVING', 'TEAMS_ANNOUNCED']);

/**
 * Dev only: every value SHIPPED_IOS_FLOORS covers at its floor (the lead
 * after a trick at the web collect's 500 ms, pacing.test.js), the rest short.
 */
const FAST = {
    ...STANDARD,
    LOBBY_START_MS: 500,
    PREDRAW_COUNTDOWN_MS: 1000,
    BOT_DRAW_STAGGER_MS: 300,
    BOT_DRAW: [200, 0],
    DRAW_REVEAL_MS: 700,
    SEATING_TO_TEAMS_MS: 500,
    TEAMS_MS: 2300,
    FIRST_HAND_TURN_MS: 500,
    BOT_FIRST_BID: [500, 0],
    BOT_BID: [500, 0],
    BOT_LEAD_AFTER_BIDDING: [300, 0],
    BOT_PLAY: [300, 0],
    BOT_FORCED_PLAY: [300, 0],
    BOT_LEAD_AFTER_TRICK: [500, 0],
    TRICK_VIEW_MS: 900,
    HAND_END_MS: 400,
    GAME_END_MS: 1000,
};

/**
 * What the App Store iOS build needs to render correctly: 1.1.0 build 2
 * (live since 2026-11-11; iOS source at f05d264, unchanged on main since).
 * It decodes resumeInMs (Networking/Wire/WirePayloads.swift: TeamsAnnounced,
 * CardPlayed, TrickComplete) but never reads it, and runs every animation on
 * receipt, so the server's gaps are still what it gets. Unlike 1.0.0 it
 * rejects nothing silently: ActionCoordinator rolls a refused bid/play back
 * from actionRejected's snapshot (State/Table/ActionCoordinator.swift). The
 * scene renders the reduced model idempotently (SpriteKit/GameSKScene.swift
 * apply(model:animations:)); a trick's sprites are keyed by deal and trick
 * (TrickKey) and a collect flies them in the transient layer
 * (SKTrickManager.collect / TrickAreaNode.takeForCollect), so a later card or
 * deal never snaps them away; the hand is not playable while one is in flight
 * (SKCardManager: trickManager.isCollecting). Ranges are checked on their min.
 * The 1.0.0 floors (IOS_1_0_FLOORS) are kept below for the kill switch.
 */
const SHIPPED_IOS_FLOORS = Object.freeze({
    // DrawPhaseView.swift (same timings as 1.0.0): slot i flips after
    // i*0.3+0.1 s for 0.4 s (4th face up at +1.4 s); keep the full draw on
    // screen before the teams
    'DRAW_REVEAL_MS+SEATING_TO_TEAMS_MS': 1200,
    // DrawPhaseView.swift: the teams overlay starts fading in at
    // teamsAnnounced + 0.8 s (0.5 s fade); gameStart removes it
    TEAMS_MS: 2300,
    // gameStart renders the new hand at once (TableReducer.gameStart, no
    // setupGameUI deal); the first bid's bubble pops in 0.2 s
    // (LiveAnimator.pop) and a bore badge fades in 0.3 s
    // (SKEffectsManager.showBoreBadge). 1.0.0: 800 (setupGameUI)
    BOT_FIRST_BID: 500,
    // the same bubble pop + bore badge for every later bid
    BOT_BID: 500,
    // doneBidding: the bid sheet leaves with GameContainerView's 0.3 s
    // transition (showsBidOverlay); 1.0.0: 600 (setupGameUI + 0.3 s)
    BOT_LEAD_AFTER_BIDDING: 300,
    // LayoutConstants.playCardDuration 0.25 s fly-in (web 300 ms)
    BOT_PLAY: 300,
    BOT_FORCED_PLAY: 300,
    // trickComplete -> .trickCollected: the trick flies to the winner in
    // collectTrickDuration 0.4 s in the transient layer; a lead after it
    // lands on an empty trick area. 1.0.0's guarded asyncAfter(0.7)
    // clearTrick is gone; that build needed 700. The web collect (500 ms)
    // has its own check in pacing.test.js
    BOT_LEAD_AFTER_TRICK: 400,
    // trickComplete starts the collect on receipt: the full trick must have
    // been visible after the 4th card's 0.25 s fly-in (unchanged)
    TRICK_VIEW_MS: 900,
    // the hand's last collect (0.4 s, transient layer) lands before the next
    // gameStart renders the new hand (.handCleared needs no clear;
    // GameSKScene.apply). 1.0.0: 800 (clearTrick at 0.7 s)
    HAND_END_MS: 400,
    // the final collect and count stay visible before GameEndView (unchanged)
    GAME_END_MS: 1000,
});

/**
 * What the OLD App Store build (cc9059f; 1.0.0 build 1) needs. It ignores
 * resumeInMs, rejects nothing itself (no actionRejected listener: a refused
 * play loses the card) and runs every animation on receipt. That build is
 * now gated (upgradeGate.js), but UPGRADE_GATE=off lets it play again, so
 * standard and legacy still meet these (pacing.test.js). Lower standard
 * below them only with the gate on for good.
 */
const IOS_1_0_FLOORS = Object.freeze({
    'DRAW_REVEAL_MS+SEATING_TO_TEAMS_MS': 1200,
    TEAMS_MS: 2300,
    // GameSocketHandler.handleGameStart -> setupGameUI deals the hand
    BOT_FIRST_BID: 800,
    // BidBubble: fades in 0.2 s, bore badge 0.3 s
    BOT_BID: 500,
    // doneBidding: setupGameUI + 0.3 s bidding-overlay transition
    BOT_LEAD_AFTER_BIDDING: 600,
    BOT_PLAY: 300,
    BOT_FORCED_PLAY: 300,
    // GameSocketHandler trickComplete: collect (collectTrickDuration 0.4 s)
    // then asyncAfter(0.4 + 0.3) { guard playedCardIndex == 0; clearTrick() }.
    // A lead at >= 0.7 s arrives after both; one between 0.4 and 0.7 s takes
    // handleCardPlayed's index-0 safety clearTrick (handled), and one that
    // jitter squeezes under 0.4 s snaps the collecting sprites away
    BOT_LEAD_AFTER_TRICK: 700,
    TRICK_VIEW_MS: 900,
    // trickComplete schedules clearTrick at collectTrickDuration + 0.3 =
    // 0.7 s (guarded by playedCardIndex == 0): the next gameStart after it
    HAND_END_MS: 800,
    GAME_END_MS: 1000,
});

const ZERO = Object.fromEntries(Object.entries(LEGACY).map(([k, v]) => [k, Array.isArray(v) ? [0, 0] : 0]));
// The ambient poll must stay a real interval (0 would spin)
ZERO.AMBIENT_CHECK_MS = 1;

const PROFILES = {
    standard: STANDARD,
    legacy: LEGACY,
    fast: FAST,
    zero: ZERO,
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Under Jest (also NODE_ENV=production test runs) or NODE_ENV=test
const isTest = () => process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
const freeze = (p) => Object.freeze(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? Object.freeze([...v]) : v])));

function profileNameFromEnv() {
    const name = process.env.BAB_PACING || 'standard';
    if (name === 'zero' && !isTest()) throw new Error('BAB_PACING=zero is test-only');
    if (name === 'fast' && process.env.NODE_ENV === 'production') {
        // eslint-disable-next-line no-console
        console.warn('BAB_PACING=fast is ignored in production; using standard');
        return 'standard';
    }
    if (!PROFILES[name]) {
        // eslint-disable-next-line no-console
        console.warn(`Unknown BAB_PACING=${name}; using standard`);
        return 'standard';
    }
    return name;
}

let active = null;
let activeName = null;
let activePregame = null;

// The ambient pre-game overlay is part of the retune: legacy keeps
// df59149's ambient pre-deal timing exactly, and zero has nothing to shorten
const NO_PREGAME_OVERLAY = new Set(['legacy', 'zero']);

/**
 * The active pacing values (frozen).
 * @param {Object} [game] - an ambient (isDemo) game before the deal with no
 *   spectator gets AMBIENT_PREGAME on top (legacy and zero excepted)
 */
function pacing(game) {
    if (!active) {
        activeName = profileNameFromEnv();
        active = freeze(PROFILES[activeName]);
        activePregame = null;
    }
    if (game && game.isDemo && PREGAME_STAGES.has(game.stage) && !(game.spectators && game.spectators.size > 0) &&
        !NO_PREGAME_OVERLAY.has(activeName) && active.TRICK_VIEW_MS > 0) {
        if (!activePregame) activePregame = freeze({ ...active, ...AMBIENT_PREGAME });
        return activePregame;
    }
    return active;
}

/** Test-only: switch to a named profile, or the active one with overrides. */
function setPacingForTests(nameOrOverrides) {
    if (!isTest()) throw new Error('setPacingForTests is test-only');
    if (typeof nameOrOverrides === 'string') {
        if (!PROFILES[nameOrOverrides]) throw new Error(`Unknown pacing profile ${nameOrOverrides}`);
        active = freeze(PROFILES[nameOrOverrides]);
        activeName = nameOrOverrides;
    } else {
        active = freeze({ ...pacing(), ...nameOrOverrides });
    }
    activePregame = null;
    return active;
}

/** Test-only: back to the env-selected profile (server/testUtils/pacingReset.js). */
function resetPacing() {
    if (!isTest()) throw new Error('resetPacing is test-only');
    active = null;
    activeName = null;
    activePregame = null;
    tracer = null;
}

/** delay = min + r * span for a [min, span] range. */
function fromRange(range, r) {
    return range[0] + r * range[1];
}

// ---------------------------------------------------------------------------
// Trace hook (server/socket/__tests__/pacingBudget.test.js): every hold and
// every bot schedule reports (kind, ms). A null check in production.
// ---------------------------------------------------------------------------

let tracer = null;

function trace(kind, ms, game = null) {
    if (tracer) tracer(kind, ms, game);
}

function setTracer(fn) {
    if (!isTest()) throw new Error('setTracer is test-only');
    tracer = fn;
}

pacing.PROFILES = PROFILES;
pacing.SHIPPED_IOS_FLOORS = SHIPPED_IOS_FLOORS;
pacing.IOS_1_0_FLOORS = IOS_1_0_FLOORS;
pacing.AMBIENT_PREGAME = AMBIENT_PREGAME;
pacing.setPacingForTests = setPacingForTests;
pacing.resetPacing = resetPacing;
pacing.fromRange = fromRange;
pacing.trace = trace;
pacing.setTracer = setTracer;

module.exports = pacing;
