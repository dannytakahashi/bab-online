/**
 * Badges (server/game/badges.js): the catalog against the art files, the
 * over-trump rule against the shared case table, the per-game tracker and
 * the rules that turn a finished game into each seat's badges.
 */

const fs = require('fs');
const path = require('path');
const badges = require('../badges');
const table = require('../../../contract/rules/legality-cases.json');

const SUITS = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs', j: 'joker' };
/** "10h" / "HIj" -> {suit, rank}, as the case table writes cards. */
const card = (code) => ({ rank: code.slice(0, -1), suit: SUITS[code.slice(-1)] });

/** A finished game as gameBadges reads it. */
function game({ score = [0, 0], sets = [0, 0], tricks = [10, 10, 10, 10], track = badges.newTrack() } = {}) {
    return {
        score: { team1: score[0], team2: score[1] },
        handStats: { totalHands: 13, team1Sets: sets[0], team2Sets: sets[1] },
        playerStats: Object.fromEntries(tricks.map((t, i) => [i + 1, { totalTricks: t }])),
        badgeTrack: track
    };
}

describe('the catalog', () => {
    test('twenty badges, each id once, each with a name and a sentence', () => {
        expect(badges.BADGES).toHaveLength(20);
        expect(new Set(badges.BADGE_IDS).size).toBe(20);
        for (const b of badges.BADGES) {
            expect(b.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            expect(b.name.length).toBeGreaterThan(0);
            expect(b.description).toMatch(/\.$/);
        }
    });

    test('every badge has its art file and no art is left over (scripts/build-badges.py)', () => {
        const dir = path.join(__dirname, '../../../client/assets/badges');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => f.replace(/\.svg$/, '')).sort();
        expect(files).toEqual([...badges.BADGE_IDS].sort());
        for (const id of files) expect(fs.readFileSync(path.join(dir, `${id}.svg`), 'utf8')).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 96 96"/);
    });

    test('publicBadges: earned only, oldest first, each once, unknown ids dropped', () => {
        const out = badges.publicBadges([
            { id: 'felted', at: new Date('2026-11-20T10:00:00Z') },
            { id: 'five-hundred', at: new Date('2026-11-01T10:00:00Z') },
            { id: 'felted', at: new Date('2026-11-21T10:00:00Z') },
            { id: 'not-a-badge', at: new Date() },
            null
        ]);
        expect(out.map((b) => b.id)).toEqual(['five-hundred', 'felted']);
        expect(out[0]).toEqual({ id: 'five-hundred', name: '500', description: 'Scored 500 points in a game.', at: '2026-11-01T10:00:00.000Z' });
        expect(badges.publicBadges(undefined)).toEqual([]);
        expect(badges.publicBadge('nope')).toBeNull();
    });
});

describe('overTrumps against contract/rules/legality-cases.json', () => {
    test.each(table.tricks.map((r) => [r.name, r]))('%s', (_name, row) => {
        const plays = row.trick.split(' ').map((t) => t.split(':'));
        const lead = Number(plays[0][0]);
        const found = badges.overTrumps(lead, plays.map(([, c]) => card(c)), card(row.trump));
        const last = found.find((o) => o.index === plays.length - 1);
        expect(Boolean(last)).toBe(row.overTrump);
        if (last) {
            expect(last.by).toBe(Number(plays[plays.length - 1][0]));
            // the victim is an opponent who held the trick with a trump
            expect(last.victim % 2).not.toBe(last.by % 2);
        }
    });

    test('an over-trump of an over-trump counts both victims', () => {
        const track = badges.newTrack();
        badges.noteTrick(track, { lead: 1, cards: ['Kh', '5s', '9s', 'Js'].map(card), trump: card('7s') });
        expect([1, 2, 3, 4].map((p) => track.byPos[p].ot)).toEqual([0, 1, 1, 0]);
    });
});

describe('the tracker', () => {
    test('normalizeTrack: a tracker round-trips, anything else is null', () => {
        const track = badges.newTrack();
        track.low.team1 = -120;
        track.byPos[3].ot = 4;
        expect(badges.normalizeTrack(JSON.parse(JSON.stringify(track)))).toEqual(track);
        expect(badges.normalizeTrack(null)).toBeNull();
        expect(badges.normalizeTrack({})).toBeNull();
        expect(badges.normalizeTrack([])).toBeNull();
    });

    test('a kept hand: big bids, a bore as the whole hand, zero runs, the HI joker', () => {
        const track = badges.newTrack();
        badges.noteHandKept(track, { playerBids: ['6', '5', 'B', '0'], handSize: 8, hiJokerPosition: 2 });
        expect([1, 2, 3, 4].map((p) => track.byPos[p].bigBid)).toEqual([1, 0, 1, 0]);
        expect(track.byPos[2].hi).toBe(1);
        expect(track.byPos[4].zeros).toBe(1);
        // a bore on a short hand is not a big bid
        const short = badges.newTrack();
        badges.noteHandKept(short, { playerBids: ['B', '0', '0', '0'], handSize: 4, hiJokerPosition: null });
        expect(short.byPos[1].bigBid).toBe(0);
    });

    test('five zero bids in a row, broken by any other bid', () => {
        const track = badges.newTrack();
        const hand = (bid) => badges.noteHandKept(track, { playerBids: [bid, '1', '1', '1'], handSize: 5, hiJokerPosition: null });
        for (let i = 0; i < 4; i++) hand('0');
        hand('1');
        for (let i = 0; i < 4; i++) hand('0');
        expect(badges.gameBadges(game({ track }))[1]).not.toContain('spectator');
        hand('0');
        expect(track.byPos[1].zeroBest).toBe(5);
        expect(badges.gameBadges(game({ track }))[1]).toContain('spectator');
        expect(badges.gameBadges(game({ track }))[2]).not.toContain('spectator');
    });

    test('a scored hand: lows, leads, the hand\'s points, a 4B made or set, a double rainbow', () => {
        const track = badges.newTrack();
        badges.noteHandScored(track, {
            score: { team1: -110, team2: 95 }, delta: { team1: -110, team2: 95 },
            playerBids: ['3B', '4B', '0', '0'], bids: { team1: 12, team2: 12 }, tricks: { team1: 0, team2: 12 }, rainbows: { team1: 0, team2: 2 }
        });
        expect(track.low).toEqual({ team1: -110, team2: 0 });
        expect(track.lead).toEqual({ team1: 0, team2: 205 });
        expect(track.bestHand).toEqual({ team1: 0, team2: 95 });
        expect(track.quadWon).toEqual({ team1: 0, team2: 1 });
        expect(track.quadLost).toEqual({ team1: 0, team2: 0 });
        expect([1, 2, 3, 4].map((p) => track.byPos[p].dbl)).toEqual([0, 1, 0, 1]);
        badges.noteHandScored(track, {
            score: { team1: -110, team2: -65 }, delta: { team1: 0, team2: -160 },
            playerBids: ['0', '4B', '0', '0'], bids: { team1: 0, team2: 10 }, tricks: { team1: 1, team2: 9 }, rainbows: { team1: 1, team2: 1 }
        });
        expect(track.quadLost).toEqual({ team1: 0, team2: 1 });
        // nothing throws without a tracker
        expect(() => badges.noteHandScored(null, {})).not.toThrow();
        expect(() => badges.noteHandKept(null, {})).not.toThrow();
        expect(() => badges.noteTrick(null, {})).not.toThrow();
    });
});

describe('gameBadges', () => {
    const of = (g, pos = 1) => badges.gameBadges(g)[pos];

    test('500 also earns 400; 400 alone; neither at 399', () => {
        expect(of(game({ score: [500, 100] }))).toEqual(expect.arrayContaining(['five-hundred', 'four-hundred']));
        expect(of(game({ score: [400, 100] }))).toContain('four-hundred');
        expect(of(game({ score: [400, 100] }))).not.toContain('five-hundred');
        expect(of(game({ score: [399, 100] }))).toEqual([]);
        // the other team's score is not yours
        expect(of(game({ score: [500, 100] }), 2)).toEqual([]);
    });

    test('Felted is a negative final score; Exact Tie goes to all four', () => {
        expect(of(game({ score: [-10, 200] }))).toEqual(['felted']);
        expect(of(game({ score: [0, 200] }))).toEqual([]);
        const tie = badges.gameBadges(game({ score: [150, 150] }));
        for (const pos of [1, 2, 3, 4]) expect(tie[pos]).toEqual(['exact-tie']);
    });

    test('Hurt People Mode: the OPPONENTS were set five times', () => {
        const g = game({ score: [200, 100], sets: [1, 5] });
        expect(of(g, 1)).toContain('hurt-people-mode');
        expect(of(g, 3)).toContain('hurt-people-mode');
        expect(of(g, 2)).not.toContain('hurt-people-mode');
        expect(of(game({ score: [200, 100], sets: [0, 4] }))).not.toContain('hurt-people-mode');
    });

    test('Backpack and Ball and Chain: winners only, more than twice / fewer than half', () => {
        const g = game({ score: [300, 100], tricks: [30, 20, 14, 20] });
        expect(of(g, 1)).toContain('backpack');
        expect(of(g, 3)).toContain('ball-and-chain');
        // exactly twice is neither
        const twice = game({ score: [300, 100], tricks: [28, 20, 14, 20] });
        expect(of(twice, 1)).not.toContain('backpack');
        expect(of(twice, 3)).not.toContain('ball-and-chain');
        // the losers get neither, whatever their split
        const lost = game({ score: [100, 300], tricks: [30, 20, 1, 20] });
        expect(of(lost, 1)).toEqual([]);
        expect(of(lost, 3)).toEqual([]);
    });

    test('Comeback Kid: trailed by MORE than 100 and won; Choke Artist: led by 100 and lost', () => {
        const track = badges.newTrack();
        track.lead.team2 = 101;
        const g = game({ score: [250, 200], track });
        expect(of(g, 1)).toContain('comeback-kid');
        expect(of(g, 2)).toContain('choke-artist');
        expect(of(g, 2)).not.toContain('comeback-kid');
        const exact = badges.newTrack();
        exact.lead.team2 = 100;
        const e = game({ score: [250, 200], track: exact });
        expect(of(e, 1)).not.toContain('comeback-kid');
        expect(of(e, 2)).toContain('choke-artist');
        // a tie is neither a win nor a loss
        expect(of(game({ score: [200, 200], track }), 2)).toEqual(['exact-tie']);
    });

    test('In the Red is below -99; Heavy Hitter is 90 in one hand; the 4B badges', () => {
        const track = badges.newTrack();
        track.low.team1 = -100;
        track.low.team2 = -99;
        track.bestHand.team1 = 90;
        track.bestHand.team2 = 89;
        track.quadWon.team1 = 1;
        track.quadLost.team2 = 1;
        const g = game({ score: [100, 50], track });
        expect(of(g, 1)).toEqual(expect.arrayContaining(['in-the-red', 'heavy-hitter', 'bet-big-win-big']));
        expect(of(g, 2)).toEqual(['lost-the-farm']);
    });

    test('the per-seat ones: Go Big, Hammer Time, Double Rainbow', () => {
        const track = badges.newTrack();
        track.byPos[4].bigBid = 1;
        track.byPos[4].hi = 5;
        track.byPos[4].dbl = 1;
        track.byPos[2].hi = 4;
        const g = game({ score: [100, 50], track });
        expect(of(g, 4)).toEqual(['double-rainbow', 'go-big-or-go-home', 'hammer-time']);
        expect(of(g, 2)).toEqual([]);
    });

    test('a game without a tracker still earns what its final state shows, and never throws', () => {
        const g = game({ score: [520, -20], sets: [0, 6], track: null });
        expect(of(g, 1)).toEqual(['five-hundred', 'four-hundred', 'hurt-people-mode']);
        expect(of(g, 2)).toEqual(['felted']);
        expect(badges.overTrumpedByPos(g)).toEqual({});
        expect(badges.gameBadges(null)[1]).toEqual(['exact-tie']);
    });

    test('the lifetime badges are never a game\'s own', () => {
        const all = Object.values(badges.gameBadges(game({ score: [600, -50], sets: [9, 9] }))).flat();
        for (const id of ['century', 'chemistry', 'child-labor']) expect(all).not.toContain(id);
    });
});
