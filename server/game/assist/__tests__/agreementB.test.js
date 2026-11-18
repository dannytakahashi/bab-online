/**
 * /help agreement, part B of 4 (seeds 51-100): at every decision of
 * 50 seeded Mary-vs-Mary games on a real GameState, advise(seatView(game,
 * pos)) equals the bot's own bid or card, and the seat view's memory equals
 * the bot's. 200 games over agreementA-D.test.js (one Jest worker each).
 */

const { runAgreement } = require('../../../testUtils/assistAgreement');

const SEEDS = Array.from({ length: 50 }, (_, i) => 51 + i);

test('advise agrees with the Mary bot at every decision (seeds 51-100)', () => {
    const r = runAgreement(SEEDS);
    expect(r.games).toBe(50);
    expect(r.mismatches).toEqual([]);
    expect(r.memoryMismatches).toBe(0);
    // Not vacuous: bids, rule plays and searched plays all checked
    expect(r.bids).toBeGreaterThan(50 * 52);
    expect(r.plays).toBe(50 * 4 * 91);
    expect(r.searched).toBeGreaterThan(50 * 100);
}, 900000);
