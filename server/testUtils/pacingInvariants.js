/**
 * Resume/pacing invariants over every instrumented emit while watching
 * (test-only; server/game/pacing.js, GameState.hold / scheduleResume):
 *   - no updateTurn or doneBidding for a game between the card that
 *     completes a trick and its trickComplete (the table is held);
 *   - that card, and only that card, carries resumeInMs (once the wire has
 *     it: `requireResumeInMs`);
 *   - every updateTurn (room or private) goes out while the stage is
 *     BIDDING or PLAYING;
 *   - a trickComplete that opens another trick is followed by the room
 *     updateTurn in the same tick (same virtual ms, nothing in between);
 *   - a handComplete that is not the game's last is followed by the next
 *     deal's gameStart and its updateTurn in the same tick.
 * Event entries need `at` (gameDriver.makeIo / the chaos io record it).
 */

'use strict';

const contractCheck = require('./contractCheck');
const gameManager = require('../game/GameManager');
const { Phase } = require('../game/GamePhase');

function watchPacing({ requireResumeInMs = false } = {}) {
    const failures = [];
    const games = new Map(); // gameId -> {cards, held, expectTurnAt, expectDealAt}
    const st = (id) => {
        if (!games.has(id)) games.set(id, { cards: 0, held: false, expectTurnAt: null, expectDealAt: null });
        return games.get(id);
    };
    const fail = (why, extra) => {
        if (failures.length < 20) failures.push({ why, ...extra });
    };
    let checked = 0;

    const off = contractCheck.onEmit((entry, wire) => {
        const to = String(entry.to);
        const event = entry.event;
        let gameId = null;
        if (to.startsWith('game:')) gameId = to.slice(5);
        else if (event === 'gameStart' && wire && wire.gameId) gameId = wire.gameId;
        else if (event === 'updateTurn') {
            const sid = to.startsWith('self:') ? to.slice(5) : to;
            gameId = gameManager.getPlayerGame(sid)?.gameId || null;
        }
        if (!gameId) return;
        const s = st(gameId);
        const game = gameManager.getGameById(gameId);
        const at = entry.at;
        const isRoom = to.startsWith('game:');

        switch (event) {
            case 'cardPlayed': {
                if (s.expectTurnAt !== null) fail('cardPlayed before the post-trick updateTurn', { gameId, at });
                s.cards++;
                const has = wire && Object.prototype.hasOwnProperty.call(wire, 'resumeInMs');
                if (requireResumeInMs && has !== (s.cards === 4)) fail('resumeInMs on the wrong card', { gameId, cards: s.cards, has });
                if (s.cards === 4) s.held = true;
                checked++;
                break;
            }
            case 'trickComplete':
                if (!s.held) fail('trickComplete without a held trick', { gameId });
                s.held = false;
                s.cards = 0;
                // The last trick of the hand: HAND_RESOLVING follows, no updateTurn
                if (game && game.cardIndex !== game.currentHand * 4) s.expectTurnAt = at;
                break;
            case 'updateTurn':
                if (s.held) fail('updateTurn while a trick is held', { gameId, at });
                if (game && game.stage !== Phase.BIDDING && game.stage !== Phase.PLAYING) {
                    fail('updateTurn outside BIDDING/PLAYING', { gameId, stage: game.stage, to });
                }
                if (isRoom && s.expectTurnAt !== null) {
                    if (at !== s.expectTurnAt) fail('updateTurn not in the trickComplete/deal tick', { gameId, at, expected: s.expectTurnAt });
                    s.expectTurnAt = null;
                    checked++;
                }
                break;
            case 'doneBidding':
                if (s.held) fail('doneBidding while a trick is held', { gameId });
                break;
            case 'handComplete':
                if (s.expectTurnAt !== null) fail('handComplete while an updateTurn was due', { gameId });
                if (game && game.currentHand !== 13) s.expectDealAt = at;
                break;
            case 'gameStart':
                s.cards = 0;
                s.held = false;
                if (s.expectDealAt !== null) {
                    if (at !== s.expectDealAt) fail('gameStart not in the handComplete tick', { gameId, at, expected: s.expectDealAt });
                    s.expectTurnAt = s.expectDealAt;
                    s.expectDealAt = null;
                    checked++;
                }
                break;
            case 'destroyHands':
                s.cards = 0;
                break;
            case 'gameEnd':
            case 'abortGame':
                games.delete(gameId);
                break;
            default:
                break;
        }
    });
    return {
        stop() {
            off();
            return { checked, failures };
        },
    };
}

module.exports = { watchPacing };
