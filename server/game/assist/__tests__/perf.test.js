/**
 * /help cost (plan §4.2, H1b perf bench): a /help answer (seatView + advise
 * + explain + render) costs what the bot's own decision costs, because it
 * IS that decision plus a few microseconds of words. Over every decision of
 * seeded games, interleaved so both see the same machine state, the p99 of
 * /help must stay within the bot's p99 (plus a small allowance for timer
 * noise and the view/explain work), and so must the p50.
 */

const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain } = require('../explain');
const { render } = require('../copy');
const { playStateGame } = require('../sim/stateGame');
const { buildPlayContext } = require('../../bot/BotController');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

test('a /help answer costs what the bot\'s own decision costs', () => {
    const help = { bid: [], play: [] };
    const bot = { bid: [], play: [] };
    let warm = 0;
    for (let seed = 700; seed < 704; seed++) {
        playStateGame({
            seed,
            onTurn(game, pos, b, kind) {
                // Alternate which goes first, so neither always runs on a warm cache
                const order = warm++ % 2 ? ['bot', 'help'] : ['help', 'bot'];
                for (const who of order) {
                    const t0 = process.hrtime.bigint();
                    if (who === 'help') {
                        const v = seatView(game, pos);
                        const e = explain(advise(v), v);
                        render(e, { style: 'line', uses: 1, freeUses: 3 });
                        help[kind].push(ms(t0));
                    } else {
                        const hand = game.getHand(b.socketId);
                        if (kind === 'bid') {
                            b.decideBid(hand, game.trump, game.playerBids, game.currentHand,
                                { teamScore: 0, oppScore: 0, currentHandSize: game.currentHand });
                        } else {
                            b.decideCard(hand, game.playedCards, game.leadCard, game.leadPosition, game.trump,
                                game.isTrumpBroken, game.currentHand, buildPlayContext(game));
                        }
                        bot[kind].push(ms(t0));
                    }
                }
            }
        });
    }
    const all = (o) => [...o.bid, ...o.play].sort((a, b) => a - b);
    const h = all(help), b = all(bot);
    const report = {
        decisions: h.length,
        help: { p50: pct(h, 0.5), p99: pct(h, 0.99), max: h[h.length - 1] },
        bot: { p50: pct(b, 0.5), p99: pct(b, 0.99), max: b[b.length - 1] },
        bidHelpP99: pct(help.bid.sort((x, y) => x - y), 0.99)
    };
    expect(report.decisions).toBeGreaterThan(1500);
    // The same work plus the view and the words: within 25% and 2 ms of the bot
    expect(report.help.p99).toBeLessThanOrEqual(report.bot.p99 * 1.25 + 2);
    expect(report.help.p50).toBeLessThanOrEqual(report.bot.p50 * 1.25 + 0.5);
    // A bid answer is model arithmetic, no search: a loose bound that holds
    // under coverage instrumentation and a busy CI machine
    expect(report.bidHelpP99).toBeLessThan(15);
    if (process.env.ASSIST_PERF_REPORT) process.stdout.write(`${JSON.stringify(report)}\n`);
}, 300000);
