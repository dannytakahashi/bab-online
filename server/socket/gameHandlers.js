/**
 * Game play socket event handlers
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const { recordGameStats, buildGameEndRecord, getUserProfilePic } = require('./profileHandlers');
const { trackInFlight } = require('../utils/shutdown');
const {
    rotatePosition,
    isRainbow,
    determineWinner,
    findHighestBidder,
    calculateMultiplier,
    determineDrawPosition,
    calculateHSI,
    calculateScore,
    handFaults,
    seatBags,
    seatSpotOn,
    nextHandSize: handSizeAfter,
    BID_RANKS
} = require('../game/rules');
const { gameLogger } = require('../utils/logger');
const { emitError } = require('./serverError');
const { Phase, reportViolation } = require('../game/GamePhase');
const { botController } = require('../game/bot');
const { Controller, Presence } = require('../game/SeatState');
const { recordTableScores } = require('../game/tournamentScoring');
const seatLifecycle = require('./seatLifecycle');
const progressWatchdog = require('./progressWatchdog');
const bidClock = require('./bidClock');
const restoreGame = require('../game/persist/restoreGame');
const { emitLobbiesUpdated } = require('./gameLifecycle');
const playAgain = require('./playAgain');
const assistHandlers = require('./assistHandlers');
const { snapshotFor, carrierFor } = require('./snapshotHandlers');
const shoulderView = require('./shoulderView');
const pacing = require('../game/pacing');
/** The live persist store (deploy survival), lazily: a no-op with LIVE_PERSIST off. */
const liveStore = () => require('../game/persist/liveStore').getLiveStore();
const avatarStore = require('../avatar/avatarStore');
const avatarWire = require('../avatar/avatarWire');
const { randomStockPic } = require('../avatar/stockAvatars');

const logContinuationError = (what, game) => (err) =>
    gameLogger.error(`${what} failed`, { gameId: game.gameId, error: err.message, stack: err.stack });
// A turn continuation (after a bot's bid or card) that threw may have left
// the table half-written: the game is tainted (GameState.markTainted)
const turnContinuationError = (what, game) => (err) => {
    game.markTainted?.(true);
    logContinuationError(what, game)(err);
};

/**
 * Tell the sender its action was refused (instead of failing silently) so a
 * client can resync rather than freeze. Clients that predate this event just
 * ignore it. `snapshot` (v2, additive) is the table as the sender should
 * redraw it (no log, no custom pictures: a v2 client already has those).
 */
function rejectAction(socket, game, action, reason, extra = {}) {
    gameLogger.warn('Action rejected', { action, reason, gameId: game.gameId, socketId: socket.id, ...extra });
    socket.emit('actionRejected', {
        action,
        reason,
        snapshot: snapshotFor(game, socket.id, { log: false, socket })
    });
}

/**
 * Check if the current turn is a bot and schedule their action
 * @param {Object} io - Socket.IO server
 * @param {Object} game - GameState
 * @param {string} actionType - 'bid' or 'play'
 */
function triggerBotIfNeeded(io, game, actionType) {
    // The bid clock first (bidClock.js): arms on a human bid turn, stops on
    // a bot's turn, a controller change or the end of bidding
    bidClock.onTurn(io, game);
    // A restored table still waiting for its humans (persist/restoreGame.js):
    // no bot action, AFK or progress watchdog; the restore kick runs this
    // again when the gate opens
    if (restoreGame.isGated(game)) {
        progressWatchdog.disarm(game);
        for (let p = 1; p <= 4; p++) game.clearTimer(`afk:${p}`);
        return;
    }
    // The tutorial (assistHandlers.tutorTick): its tips and advice for this
    // turn, in a setImmediate after this updateTurn (a no-op unless some
    // seat has it on; never a timer, the bid clock or AFK)
    assistHandlers.tutorTick(io, game);
    const seat = game.seat(game.currentTurn);
    // A human seat acts through its own socket; a connected one gets the
    // turn watchdog (seatLifecycle.armAfk: lazy after AFK_TIMEOUT_MS idle).
    // Any seat's turn clears the other seats' watchdogs. A bot's turn
    // arms the progress watchdog instead (progressWatchdog.js), a human's
    // clears it.
    if (!seat || seat.controller === Controller.HUMAN) {
        progressWatchdog.disarm(game);
        if (seat) seatLifecycle.armAfk(io, game, game.currentTurn);
        return;
    }
    for (let p = 1; p <= 4; p++) game.clearTimer(`afk:${p}`);
    progressWatchdog.arm(io, game);

    // Lazy, resign and native bot seats are all keyed by their bot socket
    if (actionType === 'bid') {
        botController.scheduleBotAction(io, game, 'bid', (io, game, bot) => {
            // Only advance the turn if the bid actually happened — advancing
            // after a stale-state bail wedges the game on a phantom turn
            if (!botController.processBotBid(io, game, bot)) return;
            game.currentTurn = rotatePosition(game.currentTurn);
            handlePostBid(io, game).catch(turnContinuationError('handlePostBid', game));
        });
    } else if (actionType === 'play') {
        botController.scheduleBotAction(io, game, 'play', (io, game, bot) => {
            if (!botController.processBotPlay(io, game, bot)) return;
            game.currentTurn = rotatePosition(game.currentTurn);
            handlePostPlay(io, game).catch(turnContinuationError('handlePostPlay', game));
        });
    }
}

/**
 * Handle logic after a bid is made (check if all bids done, trigger next bot)
 */
async function handlePostBid(io, game) {
    if (game.stage !== Phase.BIDDING) return;

    // Check if all bids are in
    if (game.getBidCount() === 4) {
        // Calculate team bids
        const bids = game.playerBids;
        game.bids = {
            team1: (BID_RANKS[bids[0]] || 0) + (BID_RANKS[bids[2]] || 0),
            team2: (BID_RANKS[bids[1]] || 0) + (BID_RANKS[bids[3]] || 0)
        };

        // Multipliers apply whenever a bore was bid — even when the summed bid
        // doesn't exceed the hand size (e.g. 'B' + '0' on the 13-card hand)
        game.team1Mult = calculateMultiplier(bids[0], bids[2]);
        game.team2Mult = calculateMultiplier(bids[1], bids[3]);

        // Cap bids at hand size
        if (game.bids.team1 > game.currentHand) {
            game.bids.team1 = game.currentHand;
        }
        if (game.bids.team2 > game.currentHand) {
            game.bids.team2 = game.currentHand;
        }

        gameLogger.debug('Bidding complete', { team1: game.bids.team1, team2: game.bids.team2, gameId: game.gameId });

        // Check for zero bids (redeal) BEFORE doneBidding: clients treat
        // doneBidding as "enter play", so sending it first flashes the play
        // phase for a hand that is about to be torn down
        if (game.bids.team1 === 0 && game.bids.team2 === 0) {
            if (!game.transition(Phase.BIDDING, Phase.REDEAL)) return;
            gameLogger.info('Zero bids, redealing', { gameId: game.gameId });
            const redealMsg = 'All bids were zero. Redealing.';
            game.addLogEntry(redealMsg, null, 'system');
            game.broadcast(io, 'gameLogEntry', { message: redealMsg, type: 'system' });
            game.broadcast(io, 'destroyHands', {});
            if (!game.transition(Phase.REDEAL, Phase.DEALING)) return;
            await dealHand(game, io, { dealer: game.dealer, handSize: game.currentHand });
            return;
        }

        const lead = findHighestBidder(game.bidder, bids) + 1;

        if (!game.transition(Phase.BIDDING, Phase.PLAYING)) return;
        // The hand is kept: its HSI joins the stats (one sample per counted hand)
        for (const [position, hsi] of Object.entries(game.hsiValues || {})) {
            game.addHSI(Number(position), hsi);
        }
        // teamBids / mults: additive (read by neither shipped client; v2
        // and future clients use them instead of re-deriving the bores)
        game.broadcast(io, 'doneBidding', {
            bids,
            lead,
            teamBids: { team1: game.bids.team1, team2: game.bids.team2 },
            mults: { team1: game.team1Mult, team2: game.team2Mult }
        });

        game.currentTurn = lead;
        game.leadPosition = lead;

        // Check for rainbows after bidding (only on 4-card hands)
        if (game.currentHand === 4) {
            const socketIds = game.getSocketIds();
            for (const socketId of socketIds) {
                const hand = game.getHand(socketId);
                if (isRainbow(hand, game.trump)) {
                    const position = game.getPositionBySocketId(socketId);
                    const player = game.getPlayerByPosition(position);
                    gameLogger.info('Rainbow hand detected', { socketId, position, gameId: game.gameId });
                    game.broadcast(io, 'rainbow', { position });
                    game.addLogEntry(`${player.username} has a rainbow!`, position, 'rainbow');

                    if (position === 1 || position === 3) {
                        game.rainbows.team1 += 1;
                    } else {
                        game.rainbows.team2 += 1;
                    }
                }
            }
        }
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger next bot if needed (bidding done: the lead may be a bot)
    triggerBotIfNeeded(io, game, game.stage === Phase.BIDDING ? 'bid' : 'play');
}

/**
 * Handle logic after a card is played (check for trick complete, trigger next bot).
 *
 * The 4th card opens TRICK_RESOLVING and schedules resumeTrick after
 * TRICK_VIEW_MS (the 'resume' game timer), then returns: nothing awaits the
 * hold. While it is open every play/bid is rejected (not_your_turn), no bot
 * is scheduled and no updateTurn goes out, so no compliant client can act.
 */
async function handlePostPlay(io, game) {
    if (game.stage !== Phase.PLAYING) return;

    if (game.playedCardsIndex === 4) {
        // TRICK_RESOLVING rejects plays and makes a second resolution a no-op
        if (!game.transition(Phase.PLAYING, Phase.TRICK_RESOLVING)) return;
        game.scheduleResume('trick', pacing(game).TRICK_VIEW_MS, () => resumeTrick(io, game), 'trickView');
        progressWatchdog.arm(io, game);
        return;
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger next bot if needed
    triggerBotIfNeeded(io, game, 'play');
}

/**
 * End of the trick view: count the trick (bookkeeping happens here, not at
 * the 4th card, so a rejoin during the hold sees exactly the pre-resolution
 * table), broadcast trickComplete, then either open the next trick
 * (updateTurn in the same tick) or hold HAND_RESOLVING until the hand is
 * scored.
 */
function resumeTrick(io, game) {
    if (game.stage !== Phase.TRICK_RESOLVING) return;

    // Re-validate after the hold: if the trick array was corrupted by a
    // stale action, log loudly instead of crashing the whole game loop
    const trickCards = game.playedCards.slice(0, 4);
    if (game.playedCardsIndex !== 4 || trickCards.length < 4 || trickCards.some(c => !c)) {
        gameLogger.error('Trick state invalid after resolution delay, skipping', {
            gameId: game.gameId,
            playedCardsIndex: game.playedCardsIndex,
            playedCards: game.playedCards
        });
        return;
    }

    const winner = determineWinner(game.playedCards, game.leadPosition, game.trump);

    if (winner === 1 || winner === 3) {
        game.tricks.team1++;
    } else {
        game.tricks.team2++;
    }
    // The won trick's cards (snapshot v2 trickHistory: a rejoin shows them)
    if (Array.isArray(game.trickHistory)) {
        const lead = game.leadPosition;
        const cards = [0, 1, 2, 3].map((k) => game.playedCards[((lead - 1 + k) % 4)]);
        game.trickHistory.push({ winner, lead, cards: cards.map((c) => ({ suit: c.suit, rank: c.rank })) });
    }

    // Track tricks for player stats
    if (game.playerStats && game.playerStats[winner]) {
        game.playerStats[winner].totalTricks++;
    }
    // Track tricks for this hand (used for set responsibility)
    if (game.handTricks) {
        game.handTricks[winner]++;
    }

    // Add trick winner to game log
    const winnerPlayer = game.getPlayerByPosition(winner);
    game.addLogEntry(`Trick won by ${winnerPlayer.username}.`, winner, 'trick');

    gameLogger.debug('Trick complete', { winner, team1Tricks: game.tricks.team1, team2Tricks: game.tricks.team2, gameId: game.gameId });

    game.currentTurn = winner;

    const lastTrick = game.cardIndex === game.currentHand * 4;
    const lastHand = game.currentHand === 13;
    const handMs = lastHand ? pacing(game).GAME_END_MS : pacing(game).HAND_END_MS;

    // The hand's last trick says how long the table is held before
    // handComplete (additive); otherwise the next trick is open now
    game.broadcast(io, 'trickComplete', lastTrick ? { winner, resumeInMs: handMs } : { winner });

    // Notify bots that the trick is complete
    botController.notifyTrickComplete(game.gameId);

    game.playedCards = [];
    game.playedCardsIndex = 0;

    if (lastTrick) {
        // Brief hold after the last trick stacks (longer before gameEnd)
        if (!game.transition(Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING)) return;
        game.scheduleResume('hand', handMs, () => handleHandComplete(game, io), lastHand ? 'gameEnd' : 'handEnd');
        progressWatchdog.arm(io, game);
        return;
    }
    if (!game.transition(Phase.TRICK_RESOLVING, Phase.PLAYING)) return;

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    triggerBotIfNeeded(io, game, 'play');
}

async function draw(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const username = game.entrant(socket.id)?.username || 'Player';

    // recordDraw refuses out-of-phase, duplicate and 5th draws
    const d = game.recordDraw(socket.id, data && data.num, username);
    if (!d) return;
    const { card, drawOrder } = d;

    gameLogger.debug('Player drew card', { socketId: socket.id, card: `${card.rank} of ${card.suit}` });

    // Tell the drawing player their card
    socket.emit('youDrew', { card, drawOrder });

    // Broadcast to all players that someone drew (so they can see it); no
    // socket id (V1_REMOVALS #14: neither client read playerDrew.socketId)
    game.broadcast(io, 'playerDrew', { username, card, drawOrder });

    // Check if all players have drawn
    if (game.drawIndex === 4) {
        await handleDrawComplete(io, game);
    }
}

/**
 * Auto-draw a random card for a socket that left, disconnected or (draw
 * watchdog) never drew. Broadcasts playerDrew; the caller decides whether
 * this draw completed the phase (game.drawIndex === 4).
 * @returns {{card: Object, drawOrder: number}|null} the draw, or null if
 *   none was made
 */
function autoDraw(io, game, socketId, username) {
    const d = game.recordDraw(socketId, null, username);
    if (d) {
        game.broadcast(io, 'playerDrew', { username, card: d.card, drawOrder: d.drawOrder });
    }
    return d;
}

/**
 * Handle draw phase completion - assign positions and start game
 * Called when all 4 players (human or bot) have drawn. Every draw path may
 * call it; the DRAWING -> DRAW_RESOLVING latch makes it run exactly once.
 */
async function handleDrawComplete(io, game) {
    if (game.drawIDs.length !== 4) return;
    game.clearTimer('draw:watchdog');
    if (!game.tryTransition(Phase.DRAWING, Phase.DRAW_RESOLVING)) return;
    // The profile lookups below wait on the DB
    progressWatchdog.arm(io, game);
    const alive = game.aliveCheck();

    // Saved profile pics for every human, looked up in parallel. No random
    // fallback here (null instead): the loop below draws every random pic
    // in drawIDs order, exactly as the sequential lookups did, so seeded
    // games (contract fixtures, transcripts, sim) are unchanged.
    const saved = await Promise.all(game.drawIDs.map(id => (gameManager.isBot(id)
        ? null
        : getUserProfilePic(game.entrant(id)?.username, { randomFallback: false }))));

    const pics = [];
    const usedPics = new Set();
    for (let i = 0; i < game.drawIDs.length; i++) {
        const playerId = game.drawIDs[i];
        const isBot = gameManager.isBot(playerId);
        let pic;

        if (isBot) {
            // Bots get random pics
            do {
                pic = randomStockPic();
            } while (usedPics.has(pic));
        } else {
            // Human players - saved profile pic, else a random one
            pic = saved[i] ?? randomStockPic();
            const isCustomPic = typeof pic === 'string' && pic.startsWith('data:image');

            // Only check for duplicates on numbered pics (custom pics are always unique)
            if (!isCustomPic) {
                while (usedPics.has(pic)) {
                    pic = randomStockPic();
                }
            }
        }

        usedPics.add(pic);
        pics.push(pic);
    }
    // Avatar URL versions of the humans' custom pictures (pure hashing, no
    // RNG, not part of toJSON): avatarWire maps them at emit time. The
    // lookups above already started deriving the renditions (warm), which
    // finishes inside the drawReveal hold
    game.avatarVersions = new Map();
    if (avatarStore.available()) {
        for (let i = 0; i < game.drawIDs.length; i++) {
            const username = game.entrant(game.drawIDs[i])?.username;
            const pic = pics[i];
            if (username && typeof pic === 'string' && pic.startsWith('data:image')) {
                game.avatarVersions.set(username, avatarStore.versionOf(pic));
            }
        }
    }
    // Aborted while the profile pics loaded
    if (!alive()) return;

    // Seat from the entrants as they are now (presence may have changed
    // during the pic lookups); the 4th seat clears game.entrants
    const entrants = game.entrants;

    // Assign positions based on cards drawn. Each entrant is seated by its
    // presence now: connected humans and bots normally; a draw-phase
    // disconnect as a human seat in reconnect grace (its 60s start now); a
    // draw-phase leaver straight to a bot (as if resigned, owner gone).
    const absentAtSeating = [];
    const takeovers = [];
    for (let i = 0; i < game.drawIDs.length; i++) {
        const playerId = game.drawIDs[i];
        const position = determineDrawPosition(game.drawCards[i], game.drawCards);
        const entrant = entrants?.get(playerId) ||
            { socketId: playerId, isBot: gameManager.isBot(playerId), username: null, presence: 'connected' };

        if (entrant.isBot) {
            // Real personality name from BotController
            const bot = botController.getBot(game.gameId, playerId);
            if (bot) {
                bot.position = position;
                bot.pic = pics[i];
            }
            game.addPlayer(playerId, bot?.username || 'Bot', position, pics[i], true);
            continue;
        }

        const username = entrant.username || 'Player';
        if (entrant.presence === 'connected') {
            // No playerAssigned (V1_REMOVALS #7): positionUpdate, the seat
            // gameStart's position and the snapshot's viewer give the seat
            game.addPlayer(playerId, username, position, pics[i], false);
        } else if (entrant.presence === 'disconnected') {
            game.createSeat(position, {
                controller: Controller.HUMAN,
                presence: Presence.GRACE,
                ownerUsername: username,
                ownerPic: pics[i],
                seatSocketId: playerId,
                onGraceExpire: () => seatLifecycle.onGraceExpired(io, game, position)
            });
            absentAtSeating.push(position);
        } else {
            // Left during the draw: gone for good, the table never waits
            const bot = seatLifecycle.createSeatBot(game, position, null);
            game.createSeat(position, {
                controller: Controller.RESIGN_BOT,
                presence: Presence.GONE,
                ownerUsername: username,
                ownerPic: pics[i],
                bot
            });
            takeovers.push(`${bot.username} is taking over for ${username}.`);
        }
    }
    game.entrants = null;
    for (const msg of takeovers) {
        game.addLogEntry(msg, null, 'system');
        game.broadcast(io, 'gameLogEntry', { message: msg, type: 'system' });
    }

    // Every human left during the draw: abort now. Nobody connected: the
    // abandon timer runs (draw-time grace seats started together with it).
    if (seatLifecycle.maybeAbort(io, game)) return;

    // Build all arrays in position order (1, 2, 3, 4) for consistency
    // isBot (additive, V1_REMOVALS #14): the bot: prefix of the seat socket
    // id as a flag; iOS 1.2.0 build 5 reads it first. sockets stays for now:
    // build 5 reads it only as fallbacks (the prefix when isBot is absent, my
    // seat before the username, the voice glow after the username), but the
    // TestFlight builds 3-4 tell a bot only by the prefix. usernames[] lost
    // its socketId (#14: read by neither client). nativeBot (additive,
    // 2026-11-19): true only for a seat whose controller is a native bot
    // ('bot': lobby Add Bot, tournament filler, solo), never a draw-phase
    // leaver's resign bot, whose seat socket is a bot: socket too (isBot is
    // true there). Clients read it for "/help has no limit here"
    // (assistState.isFreeHelpGame), never isBot alone.
    const orderedPositions = [];
    const orderedSockets = [];
    const orderedUsernames = [];
    const orderedPics = [];
    const orderedIsBot = [];
    const orderedNativeBot = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            orderedPositions.push(pos);
            orderedSockets.push(player.socketId);
            orderedUsernames.push({ username: player.username });
            orderedPics.push(player.pic);
            orderedIsBot.push(game.isBot(player.socketId));
            orderedNativeBot.push(game.seat(pos)?.controller === Controller.BOT);
        }
    }

    // A tournament table's owners are announced at its seating below; one
    // back at its seat during the hold is listed to nobody before that
    if (game.tournamentId) require('../voice/tournamentVoice').holdSeating(game);
    if (!(await game.hold('drawReveal', pacing(game).DRAW_REVEAL_MS))) return;

    // ONE room broadcast for every recipient (never split: seq): pics are
    // stock numbers or null (V1_REMOVALS #19: no inline picture), a custom
    // picture's URL is in avatarUrls once its rendition exists. Mapped now,
    // after the reveal hold the renditions derive in.
    let avatarUrls;
    const wirePics = orderedPics.map((pic, i) => {
        const r = avatarWire.seatResolve(game, pic, orderedUsernames[i].username);
        if (r.url) (avatarUrls = avatarUrls || {})[orderedPositions[i]] = r.url;
        return avatarWire.slot(pic);
    });
    const positionUpdate = {
        positions: orderedPositions,
        sockets: orderedSockets,
        usernames: orderedUsernames,
        pics: wirePics,
        isBot: orderedIsBot,
        nativeBot: orderedNativeBot
    };
    if (avatarUrls) positionUpdate.avatarUrls = avatarUrls;
    game.broadcast(io, 'positionUpdate', positionUpdate);

    // A tournament table's voice (owner 2026-11-24: whole-table voice as in
    // casual games): the connected human owners are announced to each other
    // now that both clients know who sits here (server/voice/tournamentVoice.js)
    if (game.tournamentId) require('../voice/tournamentVoice').announceTable(io, game);

    // Now that seats have positions, show draw-phase disconnects on the
    // table (their grace began at seating). Skip anyone who rejoined during
    // the delay above (they already got playerReconnected).
    for (const pos of absentAtSeating) {
        const seat = game.seat(pos);
        if (seat.presence === Presence.GRACE || seat.presence === Presence.RESIGNABLE) {
            game.broadcast(io, 'playerDisconnected', { position: pos, username: seat.ownerUsername });
        }
    }

    // Set active game for all human players (enables cross-browser
    // reconnection). Resolved per seat now, not from the pre-delay snapshot:
    // bots have no user document, and a seat that was resigned or /leave'd
    // meanwhile must not have its human's activeGameId re-armed.
    // One parallel batch (one DB round trip instead of four), still awaited
    // before teamsAnnounced so the pointer sign-in auto-rejoin reads is in
    // place in the same order as before.
    if (!alive()) return;
    const isTarget = s => s.ownerUsername && s.presence !== Presence.GONE && s.controller !== Controller.RESIGN_BOT;
    const targetSeats = game.seatList().filter(isTarget).map(s => ({ pos: s.position, username: s.ownerUsername }));
    await Promise.all(targetSeats.map(t => gameManager.setActiveGame(t.username, game.gameId)));
    // Aborted meanwhile: the abort's own clear may have run before one of
    // these writes landed, so re-clear (scoped to this game) every write.
    // Likewise a seat resigned or /leave'd during the batch: its leave-time
    // clear may have run first (the tournament batch does the same).
    const dead = !alive();
    const reclear = targetSeats.filter(t => {
        if (dead) return true;
        const seat = game.seat(t.pos);
        return !seat || seat.ownerUsername !== t.username || !isTarget(seat);
    });
    if (reclear.length) {
        await Promise.all(reclear.map(t =>
            gameManager.clearActiveGame(t.username, game.gameId).catch(logContinuationError('clearActiveGame', game))
        ));
    }
    if (dead || !alive()) return;

    // Announce teams (positions 1&3 vs 2&4)
    const team1Player1 = game.getPlayerByPosition(1);
    const team1Player2 = game.getPlayerByPosition(3);
    const team2Player1 = game.getPlayerByPosition(2);
    const team2Player2 = game.getPlayerByPosition(4);

    const seatingMs = pacing(game).SEATING_TO_TEAMS_MS;
    if (seatingMs > 0 && !(await game.hold('seating', seatingMs, 'seatingToTeams'))) return;

    if (!game.transition(Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED)) return;
    const teamsMs = pacing(game).TEAMS_MS;
    game.broadcast(io, 'teamsAnnounced', {
        team1: [team1Player1?.username || 'Player 1', team1Player2?.username || 'Player 3'],
        team2: [team2Player1?.username || 'Player 2', team2Player2?.username || 'Player 4'],
        resumeInMs: teamsMs // additive: time until createUI/gameStart
    });

    // Wait for the team announcement to be seen
    if (!(await game.hold('teams', teamsMs))) return;

    if (!game.transition(Phase.TEAMS_ANNOUNCED, Phase.DEALING)) return;

    // Reset draw state
    game.drawCards = [];
    game.drawIndex = 0;
    game.drawIDs = [];
    game.drawNames = [];
    game.deck = null;

    // Notify main room that a new in-progress game is available to spectate
    emitLobbiesUpdated(io);

    // createUI must come BEFORE gameStart (client expects this order)
    game.broadcast(io, 'createUI', {});

    // Add game start message to log
    game.addLogEntry('Game started!', null, 'system');

    // The tutorial's auto-start (a new account's first game, clients with
    // the cap tutorial, never at a tournament table): "<name> is playing
    // with the tutorial."; its welcome tip comes with the first turn
    assistHandlers.autoStart(io, game);

    // Deal the first hand (emits gameStart to each player)
    await dealHand(game, io, { dealer: game.dealer, handSize: game.currentHand, firstHand: true });
}

/**
 * Deal a hand and open its bidding. Used for the first hand (after the team
 * announcement), every following hand, and the all-zero redeal.
 * Wire order: gameStart (each seat) -> gameStart (spectators) ->
 * [1s pause on the first hand] -> updateTurn.
 * @param {Object} opts
 * @param {number} opts.dealer - dealer position for this hand
 * @param {number} opts.handSize - cards per player
 * @param {boolean} [opts.firstHand=false] - pause 1s before the first updateTurn
 */
async function dealHand(game, io, { dealer, handSize, firstHand = false }) {
    if (game.stage !== Phase.DEALING) {
        reportViolation('deal-wrong-stage', { gameId: game.gameId, stage: game.stage });
        return;
    }
    // No bid clock carries into a new deal (the redeal's included)
    bidClock.reset(io, game);
    // Hand 1 passes (1, 12), which equals the constructor defaults (bidder 2)
    game.resetForNewHand(dealer, handSize);
    // Identifies this deal so a stale continuation (e.g. the first-hand
    // pause outliving an all-zero redeal) can tell it is no longer current
    const dealSeq = game.dealSeq = (game.dealSeq || 0) + 1;

    // Initialize new deck and deal
    const deck = new Deck();
    deck.shuffle();

    const socketIds = game.getSocketIds();
    for (const socketId of socketIds) {
        const hand = deck.draw(game.currentHand);
        game.setHand(socketId, hand);
    }

    game.trump = deck.drawOne();

    // Reset bot memory for new hand and trigger personality reactions to trump
    botController.resetBotMemory(game.gameId, game.currentHand, game.trump);
    botController.handleTrumpRevealed(io, game);

    // HSI of each player's hand: each owner is shown its own (gameStart,
    // snapshot v2 `hsi`); the other seats' values never leave the server.
    // Added to the stats only once the bids keep the hand (handlePostBid):
    // an all-zero redeal's hand is never counted in totalHands, so its HSI
    // must not be
    const hsiValues = {};
    for (const socketId of socketIds) {
        const hand = game.getHand(socketId);
        const position = game.getPositionBySocketId(socketId);
        hsiValues[position] = calculateHSI(hand, game.trump);
    }

    // Store HSI values on game state for reconnection
    game.hsiValues = hsiValues;

    // Build current player info (reflects bot takeovers via lazy/resign)
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const p = game.getPlayerByPosition(pos);
        if (p) {
            playerInfo.push({ position: pos, username: p.username, pic: p.pic });
        }
    }

    // One sequence number for the whole deal: every seat and spectator
    // gameStart of this deal carries the same value
    const handSeq = game.nextSeq();

    // playerInfo for every recipient (built once per deal): a custom
    // picture's slot is null, its URL in avatarUrls (V1_REMOVALS #19)
    let info = null;
    const infoFor = () => {
        if (!info) info = avatarWire.mapPlayers(game, playerInfo);
        return info;
    };

    // Send each seat's hand to its connected owner (a lazy owner too, in
    // seat or watch view). Absent and /leave'd owners get nothing.
    for (const seat of game.seatList()) {
        if (seat.presence !== Presence.CONNECTED) continue;
        const playerPosition = seat.position;
        const info = infoFor();
        // No players (the seat socket ids, in deal order): V1_REMOVALS #6
        game.sendToPlayer(io, seat.ownerSocketId, 'gameStart', {
            gameId: game.gameId,
            hand: game.getHand(seat.seatSocketId),
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer,
            position: playerPosition,  // Include player's position to avoid the bid UI race
            currentHand: game.currentHand,  // Hand index for hand indicator
            // Only the receiver's own seat (2026-11-21: all four leaked the
            // others' hand strength); every shipped client reads only its own
            hsiValues: { [playerPosition]: hsiValues[playerPosition] },
            playerInfo: info.players,  // Current player info for avatar updates
            seq: handSeq,  // additive: the deal's broadcast sequence number
            ...(info.avatarUrls && { avatarUrls: info.avatarUrls })  // additive: custom pictures' URLs
        });
    }

    // Send spectator-safe gameStart (no hand data) so spectators see updated trump/score/hand.
    // An over-the-shoulder watcher (cap shoulderView, every rule re-checked:
    // shoulderView.watchedPositionOf) also gets the watched seat's
    // {position, hand, hsi} as the additive `shoulder`: that seat only
    for (const spec of game.getSpectators()) {
        const info = infoFor();
        const watched = shoulderView.watchedPositionOf(io, game, spec.socketId);
        game.sendToPlayer(io, spec.socketId, 'gameStart', {
            gameId: game.gameId,
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer,
            currentHand: game.currentHand,
            hand: [],
            playerInfo: info.players,
            seq: handSeq,
            ...(info.avatarUrls && { avatarUrls: info.avatarUrls }),
            ...(watched && { shoulder: shoulderView.shoulderPayload(game, watched) })
        });
    }

    gameLogger.info('Hand dealt', { gameId: game.gameId, handSize: game.currentHand, dealer: game.dealer, firstHand });
    // The final hand with a big lead: "alls we gotta do is not be stupid"
    botController.handleHandDealtChat(io, game);
    game.currentTurn = game.bidder;
    if (!game.transition(Phase.DEALING, Phase.BIDDING)) return;

    if (firstHand) {
        if (!(await game.hold('firstTurn', pacing(game).FIRST_HAND_TURN_MS))) return;
        // A bid during the pause already sent updateTurn and triggered the
        // next bot; repeating them would double-schedule it
        if (game.stage !== Phase.BIDDING || game.dealSeq !== dealSeq || game.getBidCount() > 0) return;
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger bot if first bidder is a bot
    triggerBotIfNeeded(io, game, 'bid');
}

async function playerBid(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    const result = placeBid(io, game, position, data.bid);
    if (!result.ok) {
        const extra = result.reason === 'not_your_turn' ? { position, currentTurn: game.currentTurn }
            : result.reason === 'invalid_bid' ? { position, bid: result.bid, handSize: game.currentHand }
                : { position };
        rejectAction(socket, game, 'bid', result.reason, extra);
        return;
    }
    await result.done;
}

/**
 * Place a seat's bid: a human's (playerBid) or the bid clock's timeout '0'
 * (bidClock.expire, `timedOut`), one path for both. Stage, turn, a repeat
 * and the bid itself are GameState.applyBid's, the path bots bid through
 * too. Refused: `{ok: false, reason, bid?}` and nothing happened. Accepted:
 * `{ok: true, bid, done}`; everything up to the next turn's trigger has
 * been emitted synchronously and `done` settles once handlePostBid has.
 */
function placeBid(io, game, position, rawBid, { timedOut = false } = {}) {
    const result = game.applyBid(position, rawBid);
    if (!result.ok) return result;
    return { ...result, done: bidAccepted(io, game, position, result.bid, timedOut) };
}

async function bidAccepted(io, game, position, bid, timedOut) {
    const player = game.getPlayerByPosition(position);
    // The tune stops for everyone ('timeout': clients let its end cue ring)
    bidClock.stop(io, game, timedOut ? 'timeout' : 'bid');
    if (timedOut) {
        // Only once the bid was accepted, so the line is never left without it
        const line = `${player.username} ran out of time.`;
        game.addLogEntry(line, null, 'system');
        game.broadcast(io, 'gameLogEntry', { message: line, type: 'system' });
    } else {
        bidClock.clearStrikes(game, position);
    }
    seatLifecycle.clearAfk(io, game, position);
    // A bid during the first-hand hold opens the turn early (its pause
    // then just ends): the table is no longer held
    if (game.resume && game.resume.kind === 'firstTurn') game.resume = null;

    // Add bid to game log
    game.addLogEntry(`${player.username} bid ${bid}.`, position, 'bid');

    gameLogger.debug('Bid received', { position, bid, gameId: game.gameId, timedOut });
    // The echo is the normalized string, as bidArray and bot bids are; iOS
    // 1.1.0 still SENDS numeric bids as an Int (accepted above) and decodes
    // either form (BidWire). V1_REMOVALS #11
    game.broadcast(io, 'bidReceived', {
        bid,
        position,
        bidArray: game.playerBids
    });

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

    // Timeouts in a row count as idle (bidClock strike rule): before the
    // next turn opens, so its trigger already sees the bot
    if (timedOut) bidClock.afterTimeout(io, game, position);

    // Handle post-bid logic (check if all bids done, trigger next bot, etc.)
    await handlePostBid(io, game);
}

async function playCard(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Stage, turn, trick state, card ownership and legality:
    // GameState.applyPlay, the path bots play through too
    const card = data.card;
    const result = game.applyPlay(position, card, socket.id);
    if (!result.ok) {
        if (result.reason === 'illegal_card') {
            gameLogger.warn(game.playedCardsIndex === 0 ? 'Player tried to lead illegal card' : 'Player tried to play illegal card',
                { position, card, gameId: game.gameId });
        }
        const extra = result.reason === 'not_your_turn' ? { position, currentTurn: game.currentTurn }
            : result.reason === 'invalid_play' ? { position, error: result.error }
                : result.reason === 'illegal_card' ? { position, card }
                    : { position };
        rejectAction(socket, game, 'play', result.reason, extra);
        if (result.error === 'Card not in hand') {
            // The client's hand has drifted from ours (e.g. iOS builds that
            // kept cards the lazy bot played after /active). Resend the full
            // seat state so it redraws from the truth instead of freezing.
            // Always AFTER actionRejected (iOS rolls the card back first);
            // never with tournamentId (web would route it as a rejoin)
            socket.emit('restorePlayerState', carrierFor(game, socket));
            assistHandlers.sendAssistState(io, game, position, socket.id);
        }
        return;
    }

    // The seat acted: its turn watchdog is over, and it is not idle
    seatLifecycle.clearAfk(io, game, position);
    bidClock.clearStrikes(game, position);

    game.broadcast(io, 'cardPlayed', game.cardPlayedPayload(card, position));

    // Notify bots about this card play
    botController.notifyCardPlayed(game.gameId, card, position, game.trump, game.leadPosition);
    botController.handleCardPlayedChat(io, game, card, position);

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

    // Handle post-play logic (check for trick complete, trigger next bot, etc.)
    await handlePostPlay(io, game);
}

async function handleHandComplete(game, io) {
    if (game.stage !== Phase.HAND_RESOLVING) return;
    gameLogger.info('Hand complete', { gameId: game.gameId, handSize: game.currentHand });

    const team1OldScore = game.score.team1;
    const team2OldScore = game.score.team2;

    // The hand's points (rules.calculateScore, the one scoring function)
    game.score.team1 += calculateScore(game.bids.team1, game.tricks.team1, game.team1Mult, game.rainbows.team1);
    game.score.team2 += calculateScore(game.bids.team2, game.tricks.team2, game.team2Mult, game.rainbows.team2);

    // Track hand stats for player profiles
    game.handStats.totalHands++;
    if (game.tricks.team1 < game.bids.team1) {
        game.handStats.team1Sets++;
        // Track the actual points lost to this set (for "drag" stat)
        const team1SetPoints = game.bids.team1 * 10 * game.team1Mult - game.rainbows.team1 * 10;
        game.handStats.team1SetPoints = (game.handStats.team1SetPoints || 0) + team1SetPoints;
    }
    if (game.tricks.team2 < game.bids.team2) {
        game.handStats.team2Sets++;
        // Track the actual points lost to this set (for "drag" stat)
        const team2SetPoints = game.bids.team2 * 10 * game.team2Mult - game.rainbows.team2 * 10;
        game.handStats.team2SetPoints = (game.handStats.team2SetPoints || 0) + team2SetPoints;
    }

    // Track set responsibility per player (rules.handFaults: a player on a
    // set team who took fewer tricks than they bid, a bore counting as 0;
    // the same list writes the hand's fault lines below)
    const faults = game.handTricks ? handFaults({
        teamBids: game.bids, teamTricks: game.tricks, playerBids: game.playerBids, handTricks: game.handTricks
    }) : [];
    if (game.playerStats) {
        for (const f of faults) {
            if (game.playerStats[f.position]) game.playerStats[f.position].setsCaused++;
        }
    }
    // Bags per seat (superlatives: Bag Boy): tricks over the seat's own bid
    // this hand, none on a team with a bore (rules.seatBags), into
    // game.seatBags with the hand itself (hands + 1), so a record can tell
    // a counter that saw every hand (hands === handStats.totalHands) from
    // one that missed some. Only a game that has the counter (GameState
    // starts it; a game adopted from a process without it has null, and
    // its record falls back to the net per seat:
    // profileHandlers.buildGameEndRecord). Server-only, never on the wire
    const sb = game.seatBags;
    if (sb && sb.byPos && game.handTricks && Array.isArray(game.playerBids)) {
        for (const pos of [1, 2, 3, 4]) {
            const partner = pos > 2 ? pos - 2 : pos + 2;
            sb.byPos[pos] += seatBags(game.playerBids[pos - 1], game.handTricks[pos], game.playerBids[partner - 1]);
        }
        sb.hands++;
    }
    // Spot-on bids per seat (superlatives: My Quantitative): the seat's own
    // tricks equal its numeric bid, or, on a team with a bore, the team took
    // every trick (rules.seatSpotOn), counted like seatBags above
    const se = game.seatExact;
    if (se && se.byPos && game.handTricks && Array.isArray(game.playerBids) && game.tricks) {
        for (const pos of [1, 2, 3, 4]) {
            const partner = pos > 2 ? pos - 2 : pos + 2;
            const teamTook = pos % 2 === 1 ? game.tricks.team1 : game.tricks.team2;
            se.byPos[pos] += seatSpotOn(game.playerBids[pos - 1], game.handTricks[pos], game.playerBids[partner - 1], teamTook, game.currentHand);
        }
        se.hands++;
    }

    gameLogger.debug('Score update', {
        team1: { score: game.score.team1, bids: [game.playerBids[0], game.playerBids[2]], tricks: game.tricks.team1 },
        team2: { score: game.score.team2, bids: [game.playerBids[1], game.playerBids[3]], tricks: game.tricks.team2 },
        gameId: game.gameId
    });

    // Add hand complete messages to game log
    const team1P1 = game.getPlayerByPosition(1);
    const team1P2 = game.getPlayerByPosition(3);
    const team2P1 = game.getPlayerByPosition(2);
    const team2P2 = game.getPlayerByPosition(4);
    const team1Name = `${team1P1.username}/${team1P2.username}`;
    const team2Name = `${team2P1.username}/${team2P2.username}`;
    const team1Change = game.score.team1 - team1OldScore;
    const team2Change = game.score.team2 - team2OldScore;
    const team1ChangeStr = team1Change >= 0 ? `+${team1Change}` : `${team1Change}`;
    const team2ChangeStr = team2Change >= 0 ? `+${team2Change}` : `${team2Change}`;

    game.addLogEntry('--- HAND COMPLETE ---', null, 'score');
    game.addLogEntry(`${team1Name}: Bid ${game.playerBids[0]}/${game.playerBids[2]}, Won ${game.tricks.team1}, ${team1ChangeStr} → ${game.score.team1}`, null, 'score');
    game.addLogEntry(`${team2Name}: Bid ${game.playerBids[1]}/${game.playerBids[3]}, Won ${game.tricks.team2}, ${team2ChangeStr} → ${game.score.team2}`, null, 'score');

    game.broadcast(io, 'handComplete', {
        score: game.score,
        team1Tricks: game.tricks.team1,
        team2Tricks: game.tricks.team2,
        team1OldScore,
        team2OldScore
    });

    // Then one stored, sequenced line per fault (owner 2026-11-19), after
    // the hand's lines: "Fault: <name> (bid N, took M)", with the optional
    // fault {position, bid, took} (clients draw it red; a snapshot's log
    // carries it, so a rejoin, reload or spectator replays it in place)
    for (const f of faults) {
        const name = game.getPlayerByPosition(f.position)?.username || `P${f.position}`;
        const message = `Fault: ${name} (bid ${f.bid}, took ${f.took})`;
        const fault = { position: f.position, bid: f.bid, took: f.took };
        game.addLogEntry(message, null, 'system', { fault });
        game.broadcast(io, 'gameLogEntry', { message, type: 'system', fault });
    }

    // The tutorial's hand-end tips (the hand's score after hands 1-3, the
    // graduation after the 2-card hand), private to each tutorial seat
    assistHandlers.tutorHandEnd(io, game);

    // Bot personality hooks: update Zach's partner tracking, trigger chat reactions
    botController.updatePartnerHistory(game);
    botController.handleHandCompleteChat(io, game);

    // Determine next hand (0: the 13-card hand was the last)
    const nextDealer = rotatePosition(game.dealer);
    const nextHandSize = handSizeAfter(game.currentHand);

    if (nextHandSize === 0) {
        // Game over - add final score to log
        game.addLogEntry('=== GAME OVER ===', null, 'score');
        game.addLogEntry(`${team1Name}: ${game.score.team1}`, null, 'score');
        game.addLogEntry(`${team2Name}: ${game.score.team2}`, null, 'score');

        gameLogger.info('Game ended', { gameId: game.gameId, finalScore: game.score });

        // Build player stats with usernames for final score screen
        const playerStatsWithNames = {};
        const totalHands = game.handStats.totalHands;
        for (let pos = 1; pos <= 4; pos++) {
            const player = game.getPlayerByPosition(pos);
            playerStatsWithNames[pos] = {
                username: player?.username || `P${pos}`,
                ...game.playerStats[pos],
                avgHSI: totalHands > 0 ? Math.round(game.playerStats[pos].totalHSI / totalHands) : 0
            };
        }

        // Check for tournament context
        const tournamentId = gameManager.tournamentGames.get(game.gameId) || null;

        // /help and the tutorial: a private line to each player this game
        // counted as bot-assisted for, and the tutorial's last tip (before
        // gameEnd: nothing is sent after it)
        assistHandlers.gameEndLines(io, game);

        // gameEnd goes out first, then ENDED + epoch bump + timer
        // cancellation (synchronously). False: the game was aborted
        // meanwhile, so the tournament must not be resolved a second time.
        if (!game.terminate(io, Phase.ENDED, 'gameEnd', {
            score: game.score,
            playerStats: playerStatsWithNames,
            tournamentId
        })) return;

        // A finished game: every new account that played it to the end is
        // no longer new (users.tutorial 'pending' -> 'done'; fire-and-forget)
        assistHandlers.gameFinished(io, game);

        // Play again (a lobby-born casual game): who is where, read before
        // _retire clears the spectators and the voice room
        const playAgainPlan = playAgain.plan(game, io, { score: game.score, playerStats: playerStatsWithNames });

        // Retire: bots, room, every playerGames entry (players can create
        // new lobbies / return to the tournament right away)
        gameManager.endGame(game.gameId, io);

        // ...then, before the first await, the lobby reopens with everyone
        // capable still at the table (lobbyReturn after their gameEnd)
        playAgain.open(io, playAgainPlan);

        // Persist stats in the background: a slow DB must not hold up the
        // end of the game for the players. Retried, replay-safe and waited
        // for by a graceful shutdown (profileHandlers, End-of-game writes)
        const store = liveStore();
        if (store.claimable(game)) {
            // Deploy survival (LIVE_PERSIST write; persist/liveStore.js):
            // the record is built once, and the game's saved doc becomes
            // the ENDED tombstone holding it BEFORE the stats start, so a
            // kill between the two can still record it exactly once. The
            // tombstone goes once the record's insert is acknowledged. The
            // one await in game code; bounded, and in write mode it never
            // fences (the end goes on as below whatever it answers). The
            // claim and the stats it holds up are ONE in-flight write, so a
            // SIGTERM during a slow claim still waits for the stats (and
            // the store's close ends the claim's wait at once)
            const record = buildGameEndRecord(game);
            const claim = store.claimEnded(game, { record, tournamentId });
            trackInFlight(Promise.resolve(claim).then((outcome) => {
                if (outcome === 'fenced') return null;
                return recordGameStats(game, { record, onRecorded: () => store.recordAcked(game.gameId) })
                    .finally(() => store.recordSettled(game.gameId));
            }).catch(logContinuationError('recordGameStats', game)));
            if ((await claim) === 'fenced') return;
        } else {
            recordGameStats(game).catch(logContinuationError('recordGameStats', game));
        }

        // Clear active game for all players
        try {
            await gameManager.clearActiveGameForAll(game.gameId, game);
        } catch (err) {
            logContinuationError('clearActiveGameForAll', game)(err);
        }

        // Tournament-specific: record scores and check round completion
        if (tournamentId) {
            // Re-resolved after the await: a cancel meanwhile deleted the
            // tournament and this game's mapping, and nothing is recorded
            const tournament = gameManager.tournamentGames.get(game.gameId) === tournamentId
                ? gameManager.getTournamentById(tournamentId)
                : null;
            if (tournament) {
                // Each member at the table: their team's final score, into
                // the round this game was created in (not filler bots)
                recordTableScores(tournament, game);

                // Handle tournament game end (mark complete, check round)
                const result = gameManager.handleTournamentGameEnd(game.gameId);

                // Broadcast game complete to tournament room
                tournament.broadcast(io, 'tournamentGameComplete', {
                    gameId: game.gameId,
                    score: game.score,
                    activeGames: tournament.getActiveGames(),
                    scoreboard: tournament.getScoreboard(),
                    currentRound: tournament.currentRound,
                    totalRounds: tournament.totalRounds
                });

                if (result && result.roundComplete) {
                    // Broadcasts tournamentRoundComplete, or tournamentComplete
                    // with the tournament kept alive briefly so players can
                    // return from the game-end screen and see final standings
                    const { broadcastRoundOutcome } = require('./tournamentHandlers');
                    await broadcastRoundOutcome(io, tournament);
                }
            }
        }

        // Notify main room that an in-progress game has ended
        emitLobbiesUpdated(io);
    } else {
        gameLogger.debug('Starting next hand', { dealer: nextDealer, handSize: nextHandSize, gameId: game.gameId });
        if (!game.transition(Phase.HAND_RESOLVING, Phase.DEALING)) return;
        await dealHand(game, io, { dealer: nextDealer, handSize: nextHandSize });
    }
}

/**
 * Replace a disconnected player whose grace period ran out with a bot. Any
 * connected owner may ask (a lazy owner watching their bot too). Also the
 * idle seat of a standing idle offer (tournament tables, seatLifecycle.offerIdle).
 */
async function forceResign(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) {
        emitError(socket, { message: 'Not in a game' }, 'forceResign');
        return;
    }

    const { position } = data;

    // Validate: the requesting socket owns a seat in this game
    const requestingPosition = game.seatByOwnerSocket(socket.id);
    if (!requestingPosition || !game.isHumanPresent(requestingPosition)) {
        emitError(socket, { message: 'Not a player in this game' }, 'forceResign');
        return;
    }

    // A suspended table (the holder self-fence) holds the replacement to its
    // thaw, then runs it from here again, re-validated then
    // (seatLifecycle.holdForThaw); refusals go out now as always (emitError
    // is the socket's own)
    const held = () => seatLifecycle.holdForThaw(game, socket, 'forceResign', () => {
        if (gameManager.getPlayerGame(socket.id) !== game) return undefined;
        return forceResign(socket, io, data);
    });

    // An idle seat at a tournament table whose offer stands (owner,
    // 2026-11-15): any other present owner may replace it
    if (position !== requestingPosition && seatLifecycle.idleOfferStands(game, position)) {
        if (held()) return;
        const idleUsername = game.seat(position).ownerUsername;
        if (!seatLifecycle.replaceIdleSeat(io, game, position)) return;
        gameLogger.info('Idle player replaced with a bot', {
            gameId: game.gameId,
            position,
            oldUsername: idleUsername,
            botUsername: game.seat(position).bot?.username,
            requestedBy: requestingPosition
        });
        return;
    }

    // Validate: the target seat's grace period has run out
    const targetPresence = game.seatPresence(position);
    if (targetPresence !== Presence.RESIGNABLE) {
        emitError(socket, {
            message: targetPresence === Presence.GRACE ? 'Player is still reconnecting' : 'Player is not disconnected'
        }, 'forceResign');
        return;
    }

    if (held()) return;
    const oldUsername = game.seat(position).ownerUsername;
    if (!seatLifecycle.resignSeat(io, game, position)) return;

    gameLogger.info('Player force-resigned', {
        gameId: game.gameId,
        position,
        oldUsername,
        botUsername: game.seat(position).bot?.username,
        requestedBy: requestingPosition
    });
}

module.exports = {
    draw,
    autoDraw,
    playerBid,
    placeBid,
    playCard,
    handleDrawComplete,
    forceResign,
    triggerBotIfNeeded,
    // The restore kick (deploy survival): a restored TRICK_RESOLVING /
    // HAND_RESOLVING table re-schedules its hold with these
    resumeTrick,
    handleHandComplete
};
