/**
 * Game modes (owner 2026-11-24).
 *
 *   classic  the base game: 4 seats, two teams (1 & 3 against 2 & 4)
 *   gyb      "Get Your Bid": 3 seats, no teams, a lobby option (never a
 *            tournament table). Rules: docs/RULES.md "Get Your Bid" and
 *            rules.js (gybHandScore, gybForbiddenBid).
 *
 * A lobby carries `lobby.mode` ('gyb', else absent) and the game it starts
 * `game.mode`. The web, and iOS from 1.2.7 (42): a socket must announce the
 * clientHello cap `getYourBid` to see, join or watch one (iOS builds before
 * 42 do not), so every
 * payload of a Get Your Bid table goes only to clients that know the mode.
 */

'use strict';

const MODE = Object.freeze({ CLASSIC: 'classic', GYB: 'gyb' });
/** clientHello cap of a client that can show a Get Your Bid lobby and table. */
const GYB_CAP = 'getYourBid';
const GYB_SEATS = 3;
const CLASSIC_SEATS = 4;

/** A wire or stored mode value as one of MODE (anything unknown is classic). */
const normalizeMode = (mode) => (mode === MODE.GYB ? MODE.GYB : MODE.CLASSIC);

/** Is this game or lobby (anything with `.mode`) a Get Your Bid one? */
const isGyb = (x) => !!x && x.mode === MODE.GYB;

/** Seats at the table of a game or lobby. */
const seatsOf = (x) => (isGyb(x) ? GYB_SEATS : CLASSIC_SEATS);

/** "Not available in Get Your Bid" refusals share one wording. */
const GYB_UNSUPPORTED = 'Get Your Bid is not available in this app yet. Play it at the website.';

module.exports = { MODE, GYB_CAP, GYB_SEATS, CLASSIC_SEATS, normalizeMode, isGyb, seatsOf, GYB_UNSUPPORTED };
