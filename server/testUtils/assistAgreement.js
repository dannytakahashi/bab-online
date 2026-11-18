/**
 * The /help agreement check (plan §3.5): seeded Mary-vs-Mary games on a
 * real GameState (assist/sim/stateGame.js), and at every bot decision
 * advise(seatView(game, pos)) must equal the bid or card the bot actually
 * chose, and cardMemory.fromHistory (inside seatView) must equal the bot's
 * own memory snapshot. Split over several test files (agreement*.test.js)
 * so Jest runs the 200 games on several workers.
 */

'use strict';

const { playStateGame } = require('../game/assist/sim/stateGame');
const { seatView } = require('../game/assist/seatView');
const { advise } = require('../game/assist/advise');

/**
 * @param {number[]} seeds
 * @returns {{games, decisions, bids, plays, searched, mismatches: Array, memoryMismatches: number}}
 */
function runAgreement(seeds) {
    const out = { games: 0, decisions: 0, bids: 0, plays: 0, searched: 0, mismatches: [], memoryMismatches: 0 };
    for (const seed of seeds) {
        let pending = null;
        playStateGame({
            seed,
            onTurn(game, pos, bot, kind) {
                const view = seatView(game, pos);
                pending = { view, decision: advise(view) };
                if (kind === 'play' && JSON.stringify(view.memory) !== JSON.stringify(bot.getMemorySnapshot())) out.memoryMismatches++;
            },
            onDecision(game, pos, bot, kind, played, botChoice) {
                out.decisions++;
                const d = pending.decision;
                if (kind === 'bid') {
                    out.bids++;
                    if (!d || d.bid !== String(botChoice)) out.mismatches.push({ seed, pos, kind, bot: botChoice, advice: d && d.bid });
                } else {
                    out.plays++;
                    if (d && d.source === 'search') out.searched++;
                    const same = d && d.card && botChoice && d.card.suit === botChoice.suit && d.card.rank === botChoice.rank;
                    if (!same) out.mismatches.push({ seed, pos, kind, bot: botChoice, advice: d && d.card });
                }
            }
        });
        out.games++;
    }
    return out;
}

module.exports = { runAgreement };
