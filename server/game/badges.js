/**
 * Badges (achievements; owner 2026-11-24 / 25): the catalog, the per-game
 * tracker and the rules that turn a finished game into each seat's badges.
 * Pure: no I/O, no game mutation outside the tracker handed in. The DB side
 * (who already has what, the lifetime badges, the private badgesAwarded
 * event) is server/socket/badgeAwards.js.
 *
 * Owner rules:
 *   - a badge a player has not earned is never shown or named anywhere
 *     ("they should be a surprise"): the catalog stays on the server and
 *     only earned entries go on the wire (publicBadge);
 *   - bot games earn nothing, by the leaderboard's rule: only a seat whose
 *     stats go to the human bucket (profileHandlers.seatBucket 'stats');
 *   - a Get Your Bid game earns nothing (it records no stats at all);
 *   - 500 points also earn the 400 badge; Go Big or Go Home needs only the
 *     bid; Spectator's five zero bids are in a row within one game (kept
 *     hands: an all-zero redeal's bids are not counted); Heavy Hitter is
 *     the team's score for one hand;
 *   - (owner 2026-11-25) a badge credited from a seat's own bids, plays or
 *     held cards counts only what the seat did while its controller was
 *     HUMAN: a lazy, AFK or resign bot's bids and plays earn its owner
 *     nothing. The tracker marks each seat's bid of the hand (`hb`) and
 *     card of the trick (`hp`) human or not when it is made
 *     (GameState.applyBid / applyPlay -> noteBid / notePlay), and only a
 *     human-made one counts toward Go Big or Go Home, Spectator (a
 *     bot-made bid ends the run of zeros), Hammer Time (the hand's bid
 *     was the human's), Double Rainbow (the seat's own hand was the
 *     human's), Bet Big Win Big / Lost the Farm (the 4B was a human's
 *     bid) and the over-trumped count behind Child Labor (the beaten
 *     card was a human's). The badges about the result (the scores,
 *     sets, leads, a hand's points, the tricks of a won game) are the
 *     team's and stay as they are.
 *
 * The tracker (game.badgeTrack, saved by the game codec like seatBags:
 * optional both ways, null for a game restored from a doc without it) only
 * records "it happened", so a game that lost it under-awards and never
 * awards wrongly. Three badges are lifetime totals and are decided in
 * badgeAwards.js after the game's stats are written: Century (100 human
 * games), Chemistry (20 human games with the same partner) and Child Labor
 * (over-trumped 50 times, counted from this tracker's `ot`).
 */

'use strict';

const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
    'LO': 15, 'HI': 16
};

/** Every badge: id (also the art's file name, client/assets/badges/<id>.svg), name, what it was for. */
const BADGES = Object.freeze([
    { id: 'five-hundred', name: '500', description: 'Scored 500 points in a game.' },
    { id: 'four-hundred', name: '400', description: 'Scored 400 points in a game.' },
    { id: 'comeback-kid', name: 'Comeback Kid', description: 'Won a game after trailing by more than 100 points.' },
    { id: 'choke-artist', name: 'Choke Artist', description: 'Lost a game after leading by 100 points.' },
    { id: 'heavy-hitter', name: 'Heavy Hitter', description: 'Scored 90 points in a single hand.' },
    { id: 'bet-big-win-big', name: 'Bet Big Win Big', description: 'Won a quadruple bore.' },
    { id: 'lost-the-farm', name: 'Lost the Farm', description: 'Lost a quadruple bore.' },
    { id: 'in-the-red', name: 'In the Red', description: 'Had a score below -99 during a game.' },
    { id: 'felted', name: 'Felted', description: 'Ended a game with a negative score.' },
    { id: 'hurt-people-mode', name: 'Hurt People Mode', description: 'Set the opponents 5 or more times in a game.' },
    { id: 'double-rainbow', name: 'Double Rainbow', description: 'Had a rainbow in the same hand as your partner.' },
    { id: 'backpack', name: 'Backpack', description: 'Won a game taking more than twice as many tricks as your partner.' },
    { id: 'ball-and-chain', name: 'Ball and Chain', description: 'Won a game taking fewer than half the tricks your partner did.' },
    { id: 'century', name: 'Century', description: 'Played 100 human games.' },
    { id: 'child-labor', name: 'Child Labor', description: 'Got over-trumped 50 times.' },
    { id: 'go-big-or-go-home', name: 'Go Big or Go Home', description: 'Bid 6 or more on a single hand.' },
    { id: 'spectator', name: 'Spectator', description: 'Bid zero five times in a row.' },
    { id: 'chemistry', name: 'Chemistry', description: 'Played 20 games with the same partner.' },
    { id: 'exact-tie', name: 'Exact Tie', description: 'Ended a game in a tie.' },
    { id: 'hammer-time', name: 'Hammer Time', description: 'Held the HI joker 5 times in a game.' }
].map(Object.freeze));

const BY_ID = new Map(BADGES.map((b) => [b.id, b]));
const BADGE_IDS = Object.freeze(BADGES.map((b) => b.id));
const isBadgeId = (id) => typeof id === 'string' && BY_ID.has(id);

/** Thresholds (the owner's numbers). */
const LIMITS = Object.freeze({
    fiveHundred: 500,
    fourHundred: 400,
    comebackTrail: 100,    // trailed by MORE than this
    chokeLead: 100,        // led by this or more
    heavyHand: 90,
    inTheRed: -99,         // a score BELOW this
    oppSets: 5,
    bigBid: 6,
    zeroRun: 5,
    hiJokers: 5,
    centuryGames: 100,
    chemistryGames: 20,
    overTrumped: 50
});

const POSITIONS = Object.freeze([1, 2, 3, 4]);
const teamKey = (pos) => (pos % 2 === 1 ? 'team1' : 'team2');
const otherTeam = (team) => (team === 'team1' ? 'team2' : 'team1');
const partnerOf = (pos) => (pos > 2 ? pos - 2 : pos + 2);
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const count = (v) => Math.max(0, int(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * One seat's counts. `hb` / `hp`: the seat's bid of this hand / card of
 * this trick was made by a HUMAN controller (1) or not (0; also a tracker
 * restored from a doc without them, so it under-awards, never wrongly).
 */
function newSeatTrack() {
    return { ot: 0, zeros: 0, zeroBest: 0, bigBid: 0, hi: 0, dbl: 0, hb: 0, hp: 0 };
}

/** A new game's tracker (GameState starts with one). */
function newTrack() {
    return {
        low: { team1: 0, team2: 0 },        // the lowest score reached
        lead: { team1: 0, team2: 0 },       // the largest lead held (own - other)
        bestHand: { team1: 0, team2: 0 },   // the most points from one hand
        quadWon: { team1: 0, team2: 0 },    // 4B bid and made
        quadLost: { team1: 0, team2: 0 },   // 4B bid and set
        byPos: { 1: newSeatTrack(), 2: newSeatTrack(), 3: newSeatTrack(), 4: newSeatTrack() }
    };
}

/**
 * A tracker as saved / restored: the same shape with safe integers, or null
 * for anything that is not one (a doc from a process without badges).
 */
function normalizeTrack(v) {
    if (!isPlainObject(v) || !isPlainObject(v.byPos)) return null;
    const pair = (o, fix) => ({ team1: fix(o?.team1), team2: fix(o?.team2) });
    const out = {
        low: pair(v.low, (n) => Math.min(0, int(n))),
        lead: pair(v.lead, int),
        bestHand: pair(v.bestHand, int),
        quadWon: pair(v.quadWon, count),
        quadLost: pair(v.quadLost, count),
        byPos: {}
    };
    for (const pos of POSITIONS) {
        const s = isPlainObject(v.byPos[pos]) ? v.byPos[pos] : {};
        out.byPos[pos] = {
            ot: count(s.ot), zeros: count(s.zeros), zeroBest: count(s.zeroBest),
            bigBid: count(s.bigBid), hi: count(s.hi), dbl: count(s.dbl),
            hb: s.hb === 1 ? 1 : 0, hp: s.hp === 1 ? 1 : 0
        };
    }
    return out;
}

const isBore = (bid) => typeof bid === 'string' && /B$/.test(bid);
const isTrumpCard = (card, trump) => !!card && !!trump && (card.suit === 'joker' || card.suit === trump.suit);

/**
 * The over-trumps of one trick (the owner's 2026-11-11 OT rule, CLAUDE.md
 * Cross-client rules; web client/src/rules/overTrump.js): a trump or joker,
 * on a lead that is not trump, that takes the trick from an OPPONENT whose
 * winning card was a trump or joker. The winner so far is rules.js
 * determineWinner's order. The shared case table runs against it
 * (server/game/__tests__/badges.test.js).
 * @param {number} lead - the leading position (1-4)
 * @param {Array<{suit, rank}>} cards - the trick in play order, the lead first (may be partial)
 * @param {{suit, rank}} trump
 * @returns {Array<{by: number, victim: number, index: number}>} one per over-trump, in play order
 */
function overTrumps(lead, cards, trump) {
    const out = [];
    if (!Array.isArray(cards) || cards.length === 0 || !trump) return out;
    const suitOf = (c) => (c.suit === 'joker' ? trump.suit : c.suit);
    const posAt = (k) => ((lead - 1 + k) % 4) + 1;
    const leadSuit = suitOf(cards[0]);
    const leadIsTrump = isTrumpCard(cards[0], trump);
    let winner = 0;
    for (let k = 1; k < cards.length; k++) {
        const current = cards[k];
        const winning = cards[winner];
        if (!current || !winning) return out;
        const currentIsTrump = isTrumpCard(current, trump);
        const winningIsTrump = isTrumpCard(winning, trump);
        let takes = false;
        if (currentIsTrump && !winningIsTrump) takes = true;
        else if (currentIsTrump && winningIsTrump) takes = RANK_VALUES[current.rank] > RANK_VALUES[winning.rank];
        else if (suitOf(current) === leadSuit && suitOf(winning) === leadSuit) takes = RANK_VALUES[current.rank] > RANK_VALUES[winning.rank];
        if (!takes) continue;
        const by = posAt(k);
        const victim = posAt(winner);
        if (!leadIsTrump && currentIsTrump && winningIsTrump && by % 2 !== victim % 2) out.push({ by, victim, index: k });
        winner = k;
    }
    return out;
}

/**
 * A bid went in (GameState.applyBid, every bid path: the player's socket
 * and every bot): was the seat's controller HUMAN when it was made.
 * @param {Object|null} track
 * @param {number} pos
 * @param {boolean} human
 */
function noteBid(track, pos, human) {
    const seat = track?.byPos?.[pos];
    if (seat) seat.hb = human ? 1 : 0;
}

/** A card went on the table (GameState.applyPlay): played by a HUMAN controller or not. */
function notePlay(track, pos, human) {
    const seat = track?.byPos?.[pos];
    if (seat) seat.hp = human ? 1 : 0;
}

/**
 * A hand the bids keep (handlePostBid, BIDDING -> PLAYING; never an
 * all-zero redeal): each seat's bid and who holds the HI joker, counted
 * only for a seat whose bid a human made (noteBid; a bot-made bid also
 * ends the seat's run of zeros).
 * @param {Object|null} track
 * @param {{playerBids: string[], handSize: number, hiJokerPosition: number|null}} hand - bids by position - 1
 */
function noteHandKept(track, { playerBids, handSize, hiJokerPosition }) {
    if (!track || !Array.isArray(playerBids)) return;
    for (const pos of POSITIONS) {
        const seat = track.byPos[pos];
        const bid = playerBids[pos - 1];
        if (seat.hb !== 1) {
            seat.zeros = 0;
            continue;
        }
        // A bore bids the whole hand (client rules/bids.js: a bore = the hand)
        const tricks = isBore(bid) ? int(handSize) : (parseInt(bid, 10) || 0);
        if (tricks >= LIMITS.bigBid) seat.bigBid = 1;
        if (String(bid) === '0') {
            seat.zeros++;
            if (seat.zeros > seat.zeroBest) seat.zeroBest = seat.zeros;
        } else {
            seat.zeros = 0;
        }
        if (pos === hiJokerPosition) seat.hi++;
    }
}

/**
 * A resolved trick (resumeTrick): the seats over-trumped in it, each only
 * when its beaten card was a human's play (notePlay).
 */
function noteTrick(track, { lead, cards, trump }) {
    if (!track) return;
    for (const { victim } of overTrumps(lead, cards, trump)) {
        if (track.byPos[victim]?.hp === 1) track.byPos[victim].ot++;
    }
}

/**
 * A scored hand (scoreClassicHand, after game.score moved).
 * @param {Object|null} track
 * @param {Object} hand
 * @param {{team1: number, team2: number}} hand.score - the scores after the hand
 * @param {{team1: number, team2: number}} hand.delta - the hand's points
 * @param {string[]} hand.playerBids - by position - 1
 * @param {{team1: number, team2: number}} hand.bids - the capped team bids
 * @param {{team1: number, team2: number}} hand.tricks
 * @param {{team1: number, team2: number}} hand.rainbows
 */
function noteHandScored(track, { score, delta, playerBids, bids, tricks, rainbows }) {
    if (!track) return;
    for (const team of ['team1', 'team2']) {
        const own = int(score?.[team]);
        const other = int(score?.[otherTeam(team)]);
        if (own < track.low[team]) track.low[team] = own;
        if (own - other > track.lead[team]) track.lead[team] = own - other;
        if (int(delta?.[team]) > track.bestHand[team]) track.bestHand[team] = int(delta[team]);
        const seats = team === 'team1' ? [1, 3] : [2, 4];
        // A 4B counts for the team only when a human bid it (noteBid)
        if (Array.isArray(playerBids) && seats.some((pos) => playerBids[pos - 1] === '4B' && track.byPos[pos].hb === 1)) {
            if (int(tricks?.[team]) >= int(bids?.[team])) track.quadWon[team] = 1;
            else track.quadLost[team] = 1;
        }
        // Double Rainbow: for each seat whose own hand was the human's
        if (int(rainbows?.[team]) >= 2) for (const pos of seats) if (track.byPos[pos].hb === 1) track.byPos[pos].dbl = 1;
    }
}

/**
 * Each seat's badges from one finished game (the per-game ones; the three
 * lifetime badges are badgeAwards.js's).
 * @param {Object} game - score {team1, team2}, handStats {team1Sets, team2Sets},
 *   playerStats {<pos>: {totalTricks}}, badgeTrack (or null)
 * @returns {{1: string[], 2: string[], 3: string[], 4: string[]}}
 */
function gameBadges(game) {
    const track = normalizeTrack(game?.badgeTrack);
    const score = { team1: int(game?.score?.team1), team2: int(game?.score?.team2) };
    const out = {};
    for (const pos of POSITIONS) {
        const team = teamKey(pos);
        const opp = otherTeam(team);
        const own = score[team];
        const won = own > score[opp];
        const lost = own < score[opp];
        const ids = [];
        if (own >= LIMITS.fiveHundred) ids.push('five-hundred');
        if (own >= LIMITS.fourHundred) ids.push('four-hundred');
        if (own < 0) ids.push('felted');
        if (own === score[opp]) ids.push('exact-tie');
        if (count(game?.handStats?.[`${opp}Sets`]) >= LIMITS.oppSets) ids.push('hurt-people-mode');
        const mine = count(game?.playerStats?.[pos]?.totalTricks);
        const partners = count(game?.playerStats?.[partnerOf(pos)]?.totalTricks);
        if (won && mine > 2 * partners) ids.push('backpack');
        if (won && 2 * mine < partners) ids.push('ball-and-chain');
        if (track) {
            const seat = track.byPos[pos];
            if (won && track.lead[opp] > LIMITS.comebackTrail) ids.push('comeback-kid');
            if (lost && track.lead[team] >= LIMITS.chokeLead) ids.push('choke-artist');
            if (track.bestHand[team] >= LIMITS.heavyHand) ids.push('heavy-hitter');
            if (track.quadWon[team]) ids.push('bet-big-win-big');
            if (track.quadLost[team]) ids.push('lost-the-farm');
            if (track.low[team] < LIMITS.inTheRed) ids.push('in-the-red');
            if (seat.dbl) ids.push('double-rainbow');
            if (seat.bigBid) ids.push('go-big-or-go-home');
            if (seat.zeroBest >= LIMITS.zeroRun) ids.push('spectator');
            if (seat.hi >= LIMITS.hiJokers) ids.push('hammer-time');
        }
        out[pos] = ids;
    }
    return out;
}

/** Each seat's over-trumped count of the game ({} without a tracker). */
function overTrumpedByPos(game) {
    const track = normalizeTrack(game?.badgeTrack);
    const out = {};
    if (!track) return out;
    for (const pos of POSITIONS) if (track.byPos[pos].ot > 0) out[pos] = track.byPos[pos].ot;
    return out;
}

/**
 * Does seat `position` of a stored game record count for badges: its stats
 * went to the human bucket (profileHandlers.seatBucket: not a 'botStats'
 * game, not a seat whose bucketByPosition is 'botStats'). A record from
 * before statsDeltas counts when it is not withBots. Chemistry
 * (badgeAwards.gamesTogether, the same rule as a query) and the backfill
 * read it, so an opponent's /help win never takes a game from a pair.
 * @param {{statsDeltas?: Object, withBots?: boolean}} record
 * @param {number|string} position
 */
function recordSeatCounts(record, position) {
    const sd = record?.statsDeltas;
    if (!isPlainObject(sd)) return record?.withBots !== true;
    if (sd.bucket === 'botStats') return false;
    return !(isPlainObject(sd.bucketByPosition) && sd.bucketByPosition[position] === 'botStats');
}

/** The wire form of an earned badge: {id, name, description} (+ `at` as ISO when given). */
function publicBadge(id, at) {
    const b = BY_ID.get(id);
    if (!b) return null;
    const out = { id: b.id, name: b.name, description: b.description };
    const when = at instanceof Date ? at : (typeof at === 'string' || typeof at === 'number' ? new Date(at) : null);
    if (when && !Number.isNaN(when.getTime())) out.at = when.toISOString();
    return out;
}

/**
 * A user's earned badges for the wire, oldest first, each id once and only
 * ids this server knows.
 * @param {Array<{id: string, at?: Date}>|undefined} stored - users.badges
 */
function publicBadges(stored) {
    if (!Array.isArray(stored)) return [];
    const seen = new Set();
    const rows = [];
    for (const entry of stored) {
        const id = entry?.id;
        if (!isBadgeId(id) || seen.has(id)) continue;
        seen.add(id);
        rows.push({ badge: publicBadge(id, entry.at), order: BADGE_IDS.indexOf(id), time: entry.at instanceof Date ? entry.at.getTime() : 0 });
    }
    rows.sort((a, b) => a.time - b.time || a.order - b.order);
    return rows.map((r) => r.badge);
}

module.exports = {
    BADGES,
    BADGE_IDS,
    LIMITS,
    isBadgeId,
    partnerOf,
    newTrack,
    normalizeTrack,
    overTrumps,
    noteBid,
    notePlay,
    noteHandKept,
    noteTrick,
    noteHandScored,
    gameBadges,
    overTrumpedByPos,
    recordSeatCounts,
    publicBadge,
    publicBadges
};
