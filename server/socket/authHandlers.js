/**
 * Authentication socket event handlers
 */

const passwordHash = require('../utils/passwordHash');
const signInThrottle = require('./signInThrottle');
const rateLimiter = require('./rateLimiter');
const { describeClientAddress, ipBucketKey, ipNet48Key } = require('../utils/clientIp');
const { getUsersCollection, getGameRecordsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { safeTimeout } = require('../utils/safeTimer');
const { randomStockPic } = require('../avatar/stockAvatars');
const { issueSession, verifySession, revokeOtherSessions } = require('../utils/sessionTokens');
const { checkNewUsername, findNameClash, takenMessage, MESSAGES: USERNAME_MESSAGES } = require('../utils/usernameRules');
const { rememberBlockList } = require('./voiceHandlers');
const playAgain = require('./playAgain');
const { eraseAccount, forgetAccount, isNameHold } = require('../admin/accountDelete');
const pointerResolve = require('./pointerResolve');
const onlinePresence = require('./onlinePresence');
const { checkPasswordRule, revokeOpenResetLinks, PASSWORD_RULE_MESSAGE } = require('../admin/setPassword');
const {
    belongsTo, releaseIdentity, markSuperseding, cancelSupersede, confirmSupersede, clearSuperseded,
    reparkClosedNotices, rememberTutorialFlag
} = require('./sessionIdentity');

/**
 * Accounts merged by scripts/merge-accounts.js stay behind as tombstones
 * ({ username, mergedInto }). Tell the player which account to use instead
 * of a generic "wrong password", since they likely forgot which one is theirs.
 */
const BUSY_MESSAGE = 'Server is busy. Try again in a moment.';
const THROTTLED_MESSAGE = 'Too many failed sign-in attempts. Please wait a few minutes and try again.';
const SIGN_UP_LIMIT_MESSAGE = 'Too many sign-up attempts. Please wait a few minutes and try again.';
const SIGN_UP_SERVER_LIMIT_MESSAGE = 'Too many new accounts are being created right now. Please try again in a few minutes.';
const DELETE_THROTTLED_MESSAGE = 'Too many incorrect passwords. Please wait a few minutes and try again.';
const LAST_ADMIN_DELETE_MESSAGE = 'You are the only admin. Make someone else an admin before deleting your account.';
const SESSIONS_CHANGED_MESSAGE = 'Your account was just signed out everywhere. Please sign in again.';
const ACCOUNT_CHANGED_MESSAGE = 'Your account was just changed by an admin (renamed or merged). Nothing was deleted. Sign in again and try again.';
const DATABASE_ERROR_MESSAGE = 'Database error. Try again.';
const DELETE_IN_GAME_MESSAGE = "You're in a game right now. Delete your account after it ends.";
const DELETE_IN_TOURNAMENT_MESSAGE = "You're in a tournament right now. Leave it (or wait until it ends), then delete your account.";
const PASSWORD_CHANGED_MESSAGE = 'Password changed. Your other devices were signed out.';
const SAME_PASSWORD_MESSAGE = 'Choose a new password that is different from the current one.';
const WRONG_CURRENT_PASSWORD_MESSAGE = 'Your current password is incorrect.';
const PASSWORD_CHANGE_RACE_MESSAGE = 'Your password was changed somewhere else meanwhile. Sign in again and try again.';
// restoreSessionResponse failures worth retrying with the same saved token
// (additive 2026-11-15): a database error or a name an admin action holds
// for a moment. Web keeps the token and retries with backoff; iOS from the
// next build after 1.2.1 build 9 too; iOS 1.2.0 ignores the key and forgets
// its token on any failure, as before
const RETRYABLE = Object.freeze({ retryable: true });
const isHashBusy = (error) => Boolean(error && error.code === 'HASH_BUSY');

function mergedAccountMessage(username, mergedInto) {
    return `"${username}" was combined into your account "${mergedInto}". Please sign in as ${mergedInto}.`;
}

/**
 * The message for a tombstone: a merged account names the account it went
 * into; the redirect an admin rename leaves (server/admin/accountRename.js:
 * `renamedAt` on the tombstone) names the new name. A rename's new name is
 * told ONLY to its owner (hidesNewName below): a player who asked to be
 * renamed may be getting away from someone who knows the old name.
 */
function tombstoneMessage(username, doc) {
    if (doc.renamedAt) return `This account is now called ${doc.mergedInto}. Sign in as ${doc.mergedInto}.`;
    return mergedAccountMessage(username, doc.mergedInto);
}

/**
 * A tombstone whose target name is private: the redirect an admin rename
 * left (`renamedAt`), or a merged account re-pointed by a later rename
 * (`targetRenamedAt`, accountRename.renameEverywhere). Its target is told
 * only for that account's password; sign-up, restore and profiles never
 * name it.
 */
const hidesNewName = (doc) => Boolean(doc && doc.mergedInto && (doc.renamedAt || doc.targetRenamedAt));

/**
 * Sign-in with such an old name: does `password` belong to the account it
 * now points at? Only then is the name told (anyone else gets the
 * wrong-password reply, counted like one). A missing or retired target, or
 * a document without a hash, is false.
 */
async function ownsRenamedAccount(usersCollection, redirect, password) {
    const target = await usersCollection.findOne(
        { username: redirect.mergedInto, mergedInto: { $exists: false } },
        { projection: { password: 1 } }
    );
    return typeof target?.password === 'string' && typeof password === 'string'
        && await passwordHash.compare(password, target.password);
}

/**
 * The normal signed-out flow for one live socket: `forceLogout` (both
 * clients go to their sign-in screen and forget the tab's / app's
 * credentials), the game manager's disconnect bookkeeping, then the
 * socket is closed. Returns false when that socket is not connected.
 */
function signOutSocket(io, socketId) {
    const sock = io?.sockets?.sockets?.get(socketId);
    if (!sock) return false;
    sock.emit('forceLogout');
    const username = gameManager.getUserBySocketId(socketId)?.username;
    const wasOnline = onlinePresence.isOnline(username);
    gameManager.handleDisconnect(socketId);
    // Outside a game handleDisconnect drops the entry here, so the
    // disconnect below finds no user and announces nothing: this does
    // (in a game the entry stays and the disconnect announces it)
    onlinePresence.announceOffline(io, username, wasOnline);
    sock.disconnect();
    return true;
}

/**
 * socket.data.username: the account a socket is signed in as, or is about
 * to be (set once its password or saved session checked out, BEFORE the
 * write that records the session, so a revoke landing while that write is
 * in flight still finds the socket). signIn, signUp, restoreSession and a
 * token rejoin set it; a refused attempt puts the previous value back.
 * Returns the previous value.
 */
function claimSocket(socket, username) {
    if (!socket.data) return undefined;
    const previous = socket.data.username;
    socket.data.username = username;
    return previous;
}

function releaseClaim(socket, username, previous) {
    if (socket.data && socket.data.username === username) socket.data.username = previous;
}

/**
 * Sign out every live socket of `username` (sign out everywhere, a
 * password reset by link, a merge retiring the account): the sockets the
 * game manager has signed in under that name, the user document's socketId
 * (the caller reads it with the revoke: findOneAndUpdate 'before'), and
 * every connected socket that claimed the name (socket.data.username): a
 * second tab restored from the same saved session (the web client copies
 * the saved session into every new tab, and currentUsers keeps one entry
 * per name) and a sign-in / restore / rejoin whose write is still in
 * flight. Returns how many were connected. `except`: a socket to leave
 * alone (a player deleting their own account gets its reply first). A
 * socket that switched to another account since (the user document's
 * socketId can still name it) is never touched (sessionIdentity.belongsTo).
 */
function signOutUser(io, username, { socketId = null, except = null } = {}) {
    // Play again: places held or reserved for this user after a game have
    // no socket, so handleDisconnect below never reaches them
    playAgain.releaseUser(io, username);
    const ids = new Set((gameManager.currentUsers || []).filter(u => u.username === username).map(u => u.socketId));
    if (socketId && belongsTo(socketId, io?.sockets?.sockets?.get(socketId), username)) ids.add(socketId);
    for (const [id, sock] of io?.sockets?.sockets || []) {
        if (sock?.data?.username === username) ids.add(id);
    }
    if (except) ids.delete(except);
    let n = 0;
    for (const id of ids) if (signOutSocket(io, id)) n++;
    if (n) authLogger.info('Signed out live sockets', { username, sockets: n });
    return n;
}

const MERGE_LOCKED_MESSAGE = 'This account is being updated. Please try again in a minute.';

/**
 * Right after registerUser in signIn / restoreSession: is this sign-in
 * still good? Read again AFTER registering, so a revoke (sign out
 * everywhere, a password reset, a merge retiring the account) either
 * landed before this read (seen here: its session is gone) or runs its
 * signOutUser after the registration (which then finds this socket). The
 * write's epoch filter alone misses a revoke that lands after the write
 * but before the registration. Also refused: a socket that was signed out
 * meanwhile and a name a panel merge is retiring right now.
 * @returns {Promise<string|null>} null when still good, else why not
 */
async function sessionGoneSince(usersCollection, socket, username, hash, filter = {}) {
    if (socket.connected === false) return 'disconnected';
    if (gameManager.isMergeLocked?.(username)) return 'merge';
    let user;
    try {
        user = await usersCollection.findOne(
            { username },
            { projection: { mergedInto: 1, sessionEpoch: 1, 'sessionTokens.hash': 1 } }
        );
    } catch (error) {
        authLogger.error('Session re-check failed', { username, error: error.message });
        return 'error'; // fail closed
    }
    if (socket.connected === false) return 'disconnected';
    if (gameManager.isMergeLocked?.(username)) return 'merge';
    if (!user || user.mergedInto) return 'revoked';
    // A revoke (sign out everywhere, a password reset, set-password: every
    // one goes through REVOKE_ALL_SESSIONS) always bumps sessionEpoch, so
    // "revoked since our write" is "the epoch moved off the value our write
    // was filtered on" (session.filter). A missing hash with the epoch
    // unchanged is another device's concurrent session write replacing the
    // array (issueSession / verifySession rewrite it whole), not a revoke:
    // this sign-in stays (its token may need a fresh sign-in later, as before).
    if (!epochUnchanged(user, filter.sessionEpoch)) return 'revoked';
    if (!(user.sessionTokens || []).some(t => t && t.hash === hash)) {
        authLogger.warn('Session hash replaced by a concurrent session write (not a revoke)', { username });
    }
    return null;
}

/** Does the user's sessionEpoch still match a session.filter value ({$exists:false} or a number)? */
function epochUnchanged(user, expected) {
    const now = user.sessionEpoch;
    if (expected && typeof expected === 'object' && expected.$exists === false) return now === undefined || now === null;
    return now === expected;
}

/**
 * Undo registerUser for a sign-in that sessionGoneSince refused: this
 * socket is no longer that user. registerUser dropped the name's previous
 * entry, so a previous socket that is still connected gets it back.
 */
function unregister(io, socket, username, previousEntry, previousClaim) {
    gameManager.removeUserSocket(socket.id);
    if (previousEntry && previousEntry.socketId !== socket.id && io?.sockets?.sockets?.has(previousEntry.socketId)
        && !(gameManager.currentUsers || []).some(u => u.username === username)) {
        gameManager.registerUser(previousEntry.socketId, username);
    }
    if (socket.data) delete socket.data.sessionHash;
    releaseClaim(socket, username, previousClaim);
}

const entryOf = (username) => (gameManager.currentUsers || []).find(u => u.username === username) || null;

/**
 * One live connection per user: kick the previous socket (another device or
 * tab) so a game never has two sockets for the same player.
 */
function disconnectPreviousSocket(io, previousSocketId, currentSocketId, username) {
    if (!previousSocketId || previousSocketId === currentSocketId) return;
    // users.socketId may name a socket that is another account now
    if (!belongsTo(previousSocketId, io?.sockets?.sockets?.get(previousSocketId), username)) return;
    if (signOutSocket(io, previousSocketId)) {
        authLogger.info('User logged out from another device', { username });
    }
}

/**
 * isAdmin on signInResponse / restoreSessionResponse (additive, only when
 * true): the web menu shows its Admin entry. Display only: every admin
 * request is re-checked against the database (adminHandlers.js); iOS
 * 1.1.0 reads these replies as dictionaries and ignores the key.
 */
function adminDisplay(user) {
    return user && user.isAdmin === true && !user.mergedInto ? { isAdmin: true } : {};
}

/**
 * The one-time notice after a password reset (setPassword.writePasswordHash
 * sets passwordResetNotice {by: 'link'|'admin', at}): `passwordReset {by,
 * at}` on the next signInResponse / restoreSessionResponse (additive
 * 2026-11-15; web shows one line; iOS from the next build after 1.2.1
 * build 9; iOS 1.2.0 ignores it). The field is unset only once the reply
 * is a success (clearResetNotice), so a refused sign-in still tells it later.
 */
function resetNoticeFor(user) {
    const n = user && user.passwordResetNotice;
    if (!n || (n.by !== 'link' && n.by !== 'admin')) return null;
    const at = new Date(n.at);
    return { by: n.by, at: Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString() };
}

/** What a successful signInResponse / restoreSessionResponse adds for `user`. */
function replyExtras(user) {
    const notice = resetNoticeFor(user);
    return { ...adminDisplay(user), ...(notice ? { passwordReset: notice } : {}) };
}

/**
 * The reset notice is being told: unset it, scoped to the one read (a newer
 * reset meanwhile keeps its own). A failed write only tells it once more.
 */
async function clearResetNotice(usersCollection, username, user) {
    const n = user && user.passwordResetNotice;
    if (!n) return;
    try {
        await usersCollection.updateOne({ username, 'passwordResetNotice.at': n.at }, { $unset: { passwordResetNotice: '' } });
    } catch (error) {
        authLogger.warn('Could not clear the password reset notice', { username, error: error.message });
    }
}

/**
 * signIn/restoreSession read everything on the user document except the
 * big or unused fields: the custom picture (up to ~500 KB base64), stats,
 * the end-of-game guard ids (statsGames) and the merge audit log. Exclusion keeps password, mergedInto, socketId,
 * sessionTokens, the legacy sessionToken, activeGameId, activeTournamentId
 * and blockedUsers.
 */
const SIGN_IN_PROJECTION = { customProfilePic: 0, stats: 0, botStats: 0, statsGames: 0, mergedFrom: 0 };
const RESTORE_PROJECTION = { ...SIGN_IN_PROJECTION, password: 0 };

/**
 * The users collection, waiting up to 10 s on a cold start: connectDB runs
 * after listen(), and a reconnect storm right after a deploy must not get
 * 'Database error' (a failed restoreSession makes both clients forget their
 * saved token). Still missing after the wait: the caller's usual reply.
 * whenReady is optional so test mocks of ../database without it still work.
 */
async function usersCollectionWhenReady() {
    let usersCollection = getUsersCollection();
    if (!usersCollection) {
        await require('../database').whenReady?.(10000);
        usersCollection = getUsersCollection();
    }
    return usersCollection;
}

/**
 * The game a signing-in user's saved activeGameId names, for the signIn /
 * restoreSession reply: {game, held}. Off / write: today's in-memory
 * lookup, synchronous (nothing more is awaited). LIVE_PERSIST=on (deploy
 * survival PR 5, pointerResolve; the plan's 2.6): a game not in memory is
 * resolved through the live store. One adopted just now is the active
 * game; one another live instance still holds (pending: the deploy
 * overlap, an older instance alive) keeps the pointer and is answered as
 * active too, so the client sends rejoinGame, which parks until it is
 * adopted here (or engine-closes for a retry). Only 'gone' clears it.
 * @returns {{game: Object|null, held: boolean}|Promise<{game: Object|null, held: boolean}>}
 */
function pointerGame(activeGameId) {
    const game = activeGameId ? gameManager.getGameById(activeGameId) : null;
    if (game || !activeGameId || !pointerResolve.active()) return { game, held: false };
    return pointerResolve.resolveGame(activeGameId).then((r) => ({ game: r.game || null, held: r.state === 'pending' }));
}

/**
 * The tournament a signing-in user's saved activeTournamentId names, or
 * null. LIVE_PERSIST=on: only one the user is a member of; a non-member's
 * pointer is answered as none and cleared (scoped) by the caller, so a
 * client is never routed into a tournament it is not in (the plan's 2.6,
 * review clients 3). Off / write: today's lookup.
 */
function pointerTournament(activeTournamentId, username) {
    const t = activeTournamentId ? gameManager.getTournamentById(activeTournamentId) : null;
    if (!pointerResolve.active()) return t;
    const member = (x) => typeof x.getPlayerByUsername !== 'function' || !!x.getPlayerByUsername(username);
    if (t) return member(t) ? t : null;
    if (!activeTournamentId) return null;
    // PR 6: not in memory: adopted now (a released or dead owner's doc), or
    // held while another live instance has it (answered as active: the
    // client's joinTournament parks until it is adopted here). A saved doc
    // that does not list the user is a non-member's pointer: none
    return pointerResolve.resolveTournament(activeTournamentId).then(async (r) => {
        if (r.tournament) return member(r.tournament) ? r.tournament : null;
        if (r.state !== 'pending') return null;
        const listed = await pointerResolve.savedTournamentMember(activeTournamentId, username);
        return listed === false ? null : { held: true };
    });
}

async function signIn(socket, io, data) {
    const { username, password } = data;

    // Failed-attempt throttle (pair / ip / username), checked before any
    // DB read or hash. Only failures count (signInThrottle.js).
    const who = { ip: socket.data?.clientIp ?? null, username };
    const gate = signInThrottle.check(who);
    if (!gate.ok) {
        authLogger.warn('Sign-in throttled after repeated failures', { username, ip: who.ip, retryAfterMs: gate.retryAfterMs });
        socket.emit('signInResponse', { success: false, message: THROTTLED_MESSAGE });
        return;
    }

    // Reserve a failure now, synchronously with the check, so concurrent
    // attempts cannot overshoot the limits while their hashes run; settled
    // in the finally below (kept for a real failure, released otherwise)
    const reservation = signInThrottle.reserve(who);
    let failed = false;
    let succeeded = false;
    let claim = null; // {previous} while this attempt holds socket.data.username unconfirmed

    try {
        const usersCollection = await usersCollectionWhenReady();
        const user = await usersCollection.findOne({ username }, { projection: SIGN_IN_PROJECTION });

        // A deleted account's name hold (accountDelete.js) is no account:
        // the unknown-user reply, counted like one
        if (!user || isNameHold(user)) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            // Not the typed name: no account has it, and it is sometimes the
            // password typed into the wrong field
            authLogger.warn('Sign-in failed: user not found');
            failed = true;
            return;
        }

        if (user.mergedInto) {
            // A rename's old name: the new name only for the password of the
            // account it points at; otherwise a wrong password, counted
            if (hidesNewName(user) && !(await ownsRenamedAccount(usersCollection, user, password))) {
                socket.emit('signInResponse', {
                    success: false,
                    message: 'Invalid username or password!'
                });
                authLogger.warn('Sign-in failed: renamed name, password not the account\'s', { username });
                failed = true;
                return;
            }
            socket.emit('signInResponse', {
                success: false,
                message: tombstoneMessage(username, user)
            });
            authLogger.info('Sign-in to merged account redirected', { username, mergedInto: user.mergedInto, renamed: Boolean(user.renamedAt) });
            return;
        }

        // No password hash (a malformed legacy document): a normal failure,
        // not a throw inside compare
        const passwordMatch = typeof user.password === 'string'
            && await passwordHash.compare(password, user.password);
        if (!passwordMatch) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            authLogger.warn('Sign-in failed: incorrect password', { username });
            failed = true;
            return;
        }
        succeeded = true;
        // This socket signed in as another account until now (sign out,
        // then sign in as someone else): that identity goes first, fully
        await releaseIdentity(io, socket, username);
        // Family scale: one line per password sign-in so the owner can check
        // after a deploy that different networks get different IPs
        authLogger.info('Sign-in client address', { username, ip: who.ip, ...describeClientAddress(socket) });

        // If user is already logged in, disconnect the old session
        disconnectPreviousSocket(io, user.socketId, socket.id, username);

        // New per-device session token; other devices' tokens stay valid
        const session = issueSession(user);
        const sessionToken = session.token;
        claim = { previous: claimSocket(socket, username) };

        // session.filter: only while no revoke (sign out everywhere, a
        // password reset) landed since the read above. Otherwise this write
        // would put every revoked session back (the bcrypt compare is the
        // window); the player just signs in again
        const written = await usersCollection.updateOne(
            { username, ...session.filter },
            {
                $set: { socketId: socket.id, ...session.update.$set },
                $unset: session.update.$unset
            }
        );
        if (written && written.matchedCount === 0) {
            socket.emit('signInResponse', { success: false, message: SESSIONS_CHANGED_MESSAGE });
            authLogger.warn('Sign-in lost a race with a session revoke', { username });
            return;
        }
        socket.data.sessionHash = session.hash;

        // Register with game manager, then make sure no revoke landed
        // meanwhile (sessionGoneSince)
        const previousEntry = entryOf(username);
        // The name's previous socket, if still connected, is parked now
        // and told once this sign-in stands (sessionIdentity: supersede)
        const parked = markSuperseding(io, gameManager.registerUser(socket.id, username), socket, username);
        const gone = await sessionGoneSince(usersCollection, socket, username, session.hash, session.filter);
        if (gone) {
            cancelSupersede(parked);
            unregister(io, socket, username, previousEntry, claim.previous);
            claim = null;
            if (gone !== 'disconnected') {
                socket.emit('signInResponse', { success: false, message: gone === 'merge' ? MERGE_LOCKED_MESSAGE : SESSIONS_CHANGED_MESSAGE });
            }
            authLogger.warn('Sign-in undone: the session ended while it was being recorded', { username, reason: gone });
            return;
        }
        claim = null; // signed in: the name stays claimed
        // Back online (e.g. a reconnect straight into a game, which never
        // joins the main room): the main room's list hears it now
        onlinePresence.announceOnline(io, username, previousEntry != null);
        await clearResetNotice(usersCollection, username, user);
        clearSuperseded(socket, io);
        confirmSupersede(io, parked, socket);
        reparkClosedNotices(io, socket);

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        let where = pointerGame(activeGameId);
        if (typeof where.then === 'function') where = await where;

        const blockedUsers = user.blockedUsers || [];
        rememberBlockList(socket, blockedUsers); // voice signaling checks it
        rememberTutorialFlag(socket, user); // the tutorial's auto-start reads it

        if (where.game || where.held) {
            // User has an active game - notify client
            socket.emit('signInResponse', {
                success: true,
                username,
                sessionToken,
                activeGameId: activeGameId,
                blockedUsers,
                ...replyExtras(user)
            });
            authLogger.info('User signed in with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // No active game (or game no longer exists) - clear stale activeGameId if present
            // Scoped to the stale id: a game that starts meanwhile and
            // writes a new pointer must keep it. Never while this process
            // hands its tables off (LIVE_PERSIST=on, shutting down)
            if (activeGameId && !pointerResolve.holdsPointers()) {
                await gameManager.clearActiveGame(username, activeGameId);
            }

            // Check for active tournament
            const activeTournamentId = user.activeTournamentId;
            let activeTournament = pointerTournament(activeTournamentId, username);
            if (activeTournament && typeof activeTournament.then === 'function') activeTournament = await activeTournament;

            if (activeTournament) {
                socket.emit('signInResponse', {
                    success: true,
                    username,
                    sessionToken,
                    activeTournamentId,
                    blockedUsers,
                    ...replyExtras(user)
                });
                authLogger.info('User signed in with active tournament', { username, socketId: socket.id, tournamentId: activeTournamentId });
            } else {
                if (activeTournamentId && !pointerResolve.holdsPointers()) {
                    await gameManager.clearActiveTournament(username, activeTournamentId);
                }
                socket.emit('signInResponse', { success: true, username, sessionToken, blockedUsers, ...replyExtras(user) });
                authLogger.info('User signed in', { username, socketId: socket.id });
            }
        }

    } catch (error) {
        if (isHashBusy(error)) {
            authLogger.warn('Sign-in deferred: password hashing busy', { username });
            socket.emit('signInResponse', { success: false, message: BUSY_MESSAGE });
            return;
        }
        authLogger.error('Database error during sign-in', { username, error: error.message });
        socket.emit('signInResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    } finally {
        if (claim) releaseClaim(socket, username, claim.previous);
        // Counted: unknown user, wrong password (also on a rename's old
        // name). Not counted: a merged account, a database error, a busy hash pool. Success clears the pair.
        if (succeeded) signInThrottle.recordSuccess(who, reservation);
        else if (failed) signInThrottle.confirm(who);
        else signInThrottle.release(who, reservation);
    }
}

function signUpNetworkMessage(retryAfterMs) {
    const minutes = Math.max(1, Math.round(retryAfterMs / 60000));
    return `Too many new accounts from this network. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

// One warn line per kind per minute under a flood (the count says how many
// were refused since the last line)
const signUpRefusals = { ip: { at: 0, held: 0 }, global: { at: 0, held: 0 } };
function noteSignUpRefusal(kind, message, details) {
    const r = signUpRefusals[kind];
    const now = Date.now();
    if (now - r.at < 60000) {
        r.held++;
        return;
    }
    authLogger.warn(message, { ...details, refusedSinceLastLine: r.held });
    r.at = now;
    r.held = 0;
}

/**
 * The sign-up limits that outlive a socket (rateLimiter.buckets): per
 * client IP, IPv6 by its /64 and its /48 (skipped when the IP is unknown,
 * as in signInThrottle: never one shared key for everyone), then
 * server-wide. Every bucket is checked before any is charged, so a refused
 * attempt writes no key (a flood refused by the ceiling cannot fill the
 * per-IP map).
 * @returns {{ok: true, refund: Function} | {ok: false, message: string}}
 */
function takeSignUpSlot(socket) {
    const ip = socket.data?.clientIp ?? null;
    const charges = [];
    if (ip) {
        charges.push(['signUpIp', ipBucketKey(ip)]);
        const net48 = ipNet48Key(ip);
        if (net48) charges.push(['signUpNet48', net48]);
    }
    charges.push(['signUpGlobal', 'all']);
    for (const [name, key] of charges) {
        const seen = rateLimiter.peek(name, key);
        if (seen.ok) continue;
        if (name === 'signUpGlobal') {
            const { burst, perHour } = rateLimiter.buckets.signUpGlobal;
            noteSignUpRefusal('global', 'Sign-up ceiling reached: refusing new accounts server-wide', { burst, perHour, retryAfterMs: seen.retryAfterMs });
            return { ok: false, message: SIGN_UP_SERVER_LIMIT_MESSAGE };
        }
        noteSignUpRefusal('ip', 'Sign-up refused: per-IP account limit', { ip: key, bucket: name, retryAfterMs: seen.retryAfterMs });
        return { ok: false, message: signUpNetworkMessage(seen.retryAfterMs) };
    }
    for (const [name, key] of charges) rateLimiter.take(name, key);
    return {
        ok: true,
        refund: () => {
            for (const [name, key] of charges) rateLimiter.refund(name, key);
        }
    };
}

async function signUp(socket, io, data) {
    const usersCollection = await usersCollectionWhenReady();

    if (!usersCollection) {
        socket.emit('signUpResponse', {
            success: false,
            message: 'Database not ready. Try again.'
        });
        authLogger.error('Database not ready: usersCollection is undefined');
        return;
    }

    const { username, password } = data;

    // New sign-ups only (owner, 2026-11-11): 3-20 ASCII letters, digits,
    // space _ - . ; no emoji (bots are "🤖 <name>"). Existing names are
    // never re-checked: sign-in and every lookup stay exact.
    const rule = checkNewUsername(username);
    if (!rule.ok) {
        socket.emit('signUpResponse', { success: false, message: rule.message });
        authLogger.warn('Sign-up failed: username rule', { reason: rule.reason });
        return;
    }

    // Substring matching for usernames — embedded slurs in handles like
    // "xX_slur_Xx" must be rejected, not just standalone words
    const { containsProfanitySubstring } = require('../utils/profanityFilter');
    if (containsProfanitySubstring(username)) {
        socket.emit('signUpResponse', {
            success: false,
            message: 'That username is not allowed.'
        });
        authLogger.warn('Sign-up failed: username rejected by filter', { username });
        return;
    }

    // Every new password: 8-100 characters (setPassword.checkPasswordRule;
    // Joi still takes 1-100, so a short one gets this message)
    if (!checkPasswordRule(password)) {
        socket.emit('signUpResponse', { success: false, message: PASSWORD_RULE_MESSAGE });
        authLogger.warn('Sign-up failed: password rule');
        return;
    }

    // A name an admin rename / delete / merge holds right now (either side
    // of a rename): taken until it is done, ignoring case like the check below
    if (gameManager.isNameLockedIgnoringCase?.(username)) {
        socket.emit('signUpResponse', { success: false, message: USERNAME_MESSAGES.taken });
        authLogger.warn('Sign-up refused: the name is locked by an admin action', { username });
        return;
    }

    let slot = null; // the per-IP / server-wide tokens, given back if the hash never ran
    try {
        // Taken ignoring case and surrounding whitespace ("alan T" vs "Alan T")
        const existingUser = await findNameClash(usersCollection, username);

        if (existingUser) {
            socket.emit('signUpResponse', {
                success: false,
                // A rename's old name, and a deleted account's name hold,
                // are just taken (sign-up proves nothing)
                message: existingUser.exact && existingUser.mergedInto && !hidesNewName(existingUser) && !isNameHold(existingUser)
                    ? tombstoneMessage(username, existingUser)
                    : takenMessage(username, existingUser)
            });
            authLogger.warn('Sign-up failed: username taken', { username, existing: existingUser.username, exact: existingUser.exact });
            return;
        }

        // The account budget (rateLimiter.signUpAccount, 3 / 5 min per
        // socket) is spent only here, on an attempt that hashes and inserts.
        // Refusals above (name rules, profanity, taken) only count against
        // the wrapper's wider signUp cap, so a player trying names is never
        // locked out by the rules. Over the budget: an ordinary refusal,
        // which both clients show (never serverError, a generic toast on iOS).
        if (rateLimiter.getRemaining(socket.id, 'signUpAccount') < 1) {
            socket.emit('signUpResponse', { success: false, message: SIGN_UP_LIMIT_MESSAGE });
            authLogger.warn('Sign-up refused: account budget spent', { socketId: socket.id });
            return;
        }
        // The same kind of attempt against the budgets a reconnect does not
        // reset: per client IP and server-wide (takeSignUpSlot). Checked
        // before signUpAccount is spent, so retrying after one of these
        // refusals never turns into the per-socket message
        const taken = takeSignUpSlot(socket);
        if (!taken.ok) {
            socket.emit('signUpResponse', { success: false, message: taken.message });
            return;
        }
        slot = taken;
        rateLimiter.check(socket.id, 'signUpAccount'); // remaining >= 1 above, nothing awaited since

        // Session token for reconnection (this device's first session)
        const session = issueSession(null);
        const sessionToken = session.token;

        const hashedPassword = await passwordHash.hash(password, 10);
        const profilePic = randomStockPic();
        const inserted = await usersCollection.insertOne({
            username,
            password: hashedPassword,
            socketId: socket.id,  // Set socketId immediately for auto-login
            sessionTokens: session.update.$set.sessionTokens,
            profilePic,
            // A new account: its first finished game makes it 'done'; until
            // then a client with the cap tutorial starts with the tutorial
            // on (assistHandlers.autoStart)
            tutorial: 'pending',
            stats: {
                wins: 0,
                losses: 0,
                gamesPlayed: 0,
                totalPoints: 0,
                totalTricksBid: 0,
                totalTricksTaken: 0
            }
        });
        // The check above ran before the hash: a case variant written since
        // (another sign-up, an admin rename to "Bob" while this one hashed
        // "bob") is caught now. Of two racing writes, the later one's
        // re-check sees the earlier one (accountRename.renameUserDoc
        // re-checks after its write the same way), so the two can never
        // stay side by side; the unique index only catches the exact name
        const clash = await caseVariantSince(usersCollection, username, inserted?.insertedId);
        if (clash) {
            await usersCollection.deleteOne({ _id: inserted.insertedId, username });
            socket.emit('signUpResponse', {
                success: false,
                message: clash === 'error' ? 'Database error. Try again.' : USERNAME_MESSAGES.taken
            });
            authLogger.warn('Sign-up undone: a case variant appeared during sign-up, or the re-check failed', { username, reason: clash });
            return;
        }
        await releaseIdentity(io, socket, username);
        socket.data.sessionHash = session.hash;
        claimSocket(socket, username);

        // The name now belongs to a fresh account — stop anonymizing it in
        // new game records (only relevant if a deleted name is re-registered)
        gameManager.deletedUsernames.delete(username);

        // Auto-login: register with game manager (same as signIn)
        const wasOnline = onlinePresence.isOnline(username);
        gameManager.registerUser(socket.id, username);
        onlinePresence.announceOnline(io, username, wasOnline);
        clearSuperseded(socket, io);
        rememberBlockList(socket, []);
        rememberTutorialFlag(socket, { tutorial: 'pending' });

        socket.emit('signUpResponse', { success: true, username, sessionToken, autoLoggedIn: true });
        authLogger.info('New user registered and auto-logged in', { username, socketId: socket.id });

    } catch (error) {
        // Lost a race with a concurrent sign-up for the same name: the unique
        // index on users.username rejects the second insert
        if (error && error.code === 11000) {
            socket.emit('signUpResponse', { success: false, message: USERNAME_MESSAGES.taken });
            authLogger.warn('Sign-up failed: username taken (duplicate key)', { username });
            return;
        }
        if (isHashBusy(error)) {
            slot?.refund();
            authLogger.warn('Sign-up deferred: password hashing busy', { username });
            socket.emit('signUpResponse', { success: false, message: BUSY_MESSAGE });
            return;
        }
        authLogger.error('Database error during sign-up', { username, error: error.message });
        socket.emit('signUpResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Another account whose name equals `username` ignoring case and
 * surrounding whitespace (findNameClash's rule), other than the document
 * just inserted: 'taken', or 'error' when the read failed (fails closed:
 * the sign-up is undone), else null.
 */
async function caseVariantSince(usersCollection, username, insertedId) {
    if (!insertedId) return null;
    try {
        const other = await usersCollection.findOne(
            { _id: { $ne: insertedId }, username: { $regex: `^\\s*${escapeRegex(username)}\\s*$`, $options: 'i' } },
            { projection: { _id: 1 } }
        );
        return other ? 'taken' : null;
    } catch (error) {
        authLogger.error('Sign-up re-check failed', { username, error: error.message });
        return 'error';
    }
}

/**
 * Restore session after page refresh using session token
 */
async function restoreSession(socket, io, data) {
    const usersCollection = await usersCollectionWhenReady();
    const { username, sessionToken } = data;
    let claim = null; // as in signIn

    try {
        // Find user and validate session token
        const user = await usersCollection.findOne({ username }, { projection: RESTORE_PROJECTION });

        // A deleted account's name hold: as if the document were gone
        if (!user || isNameHold(user)) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'User not found'
            });
            authLogger.warn('Session restore failed: user not found', { username, deletedName: Boolean(user) });
            return;
        }

        if (user.mergedInto) {
            // A rename's old name holds no sessions and a saved one proves
            // nothing (the rename revoked them): the routine reply, and the
            // player signs in with the old name and password to be told
            socket.emit('restoreSessionResponse', {
                success: false,
                message: hidesNewName(user) ? 'Invalid session token' : tombstoneMessage(username, user)
            });
            return;
        }

        const session = verifySession(user, sessionToken);
        if (!session) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'Invalid session token'
            });
            authLogger.warn('Session restore failed: invalid token', { username });
            return;
        }
        // A valid saved session proves this network is the account's own:
        // its password sign-ins skip the username-wide limit (signInThrottle)
        signInThrottle.rememberGood({ ip: socket.data?.clientIp ?? null, username });
        // Another account on this socket until now: released first
        await releaseIdentity(io, socket, username);

        // A different device resuming its saved session takes over the one
        // live connection. The same device reconnecting (same token, e.g. a
        // network blip or page refresh) is left to the normal disconnect flow.
        const previousSocket = user.socketId ? io.sockets.sockets.get(user.socketId) : null;
        if (previousSocket && previousSocket.data?.sessionHash !== session.hash) {
            disconnectPreviousSocket(io, user.socketId, socket.id, username);
        }
        // Session token is valid - update socket ID and session last-used
        // time, only while no revoke landed since the read above
        // (session.filter): a restore racing sign out everywhere or a
        // password reset must not write the revoked sessions back
        claim = { previous: claimSocket(socket, username) };
        const written = await usersCollection.updateOne(
            { username, ...session.filter },
            {
                $set: { socketId: socket.id, ...session.update.$set },
                $unset: session.update.$unset
            }
        );
        if (written && written.matchedCount === 0) {
            releaseClaim(socket, username, claim.previous);
            claim = null;
            socket.emit('restoreSessionResponse', { success: false, message: 'Invalid session token' });
            authLogger.warn('Session restore failed: sessions revoked meanwhile', { username });
            return;
        }
        socket.data.sessionHash = session.hash;

        // Register with game manager, then make sure no revoke landed
        // meanwhile (sessionGoneSince)
        const previousEntry = entryOf(username);
        // The tab / socket this session was live on is parked and told once
        // the restore stands: a second tab of the same saved session
        const parked = markSuperseding(io, gameManager.registerUser(socket.id, username), socket, username);
        const gone = await sessionGoneSince(usersCollection, socket, username, session.hash, session.filter);
        if (gone) {
            cancelSupersede(parked);
            unregister(io, socket, username, previousEntry, claim.previous);
            claim = null;
            if (gone !== 'disconnected') {
                // A merge lock and a failed re-check read are passing: the
                // saved token may be good, so the client keeps it and retries
                socket.emit('restoreSessionResponse', gone === 'merge'
                    ? { success: false, message: MERGE_LOCKED_MESSAGE, ...RETRYABLE }
                    : gone === 'error'
                        ? { success: false, message: DATABASE_ERROR_MESSAGE, ...RETRYABLE }
                        : { success: false, message: 'Invalid session token' });
            }
            authLogger.warn('Session restore undone: the session ended while it was being recorded', { username, reason: gone });
            return;
        }
        claim = null; // signed in: the name stays claimed
        // Back online (e.g. a reconnect straight into a game, which never
        // joins the main room): the main room's list hears it now
        onlinePresence.announceOnline(io, username, previousEntry != null);
        await clearResetNotice(usersCollection, username, user);
        clearSuperseded(socket, io);
        confirmSupersede(io, parked, socket);
        reparkClosedNotices(io, socket);

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        let where = pointerGame(activeGameId);
        if (typeof where.then === 'function') where = await where;
        const blockedUsers = user.blockedUsers || [];
        rememberBlockList(socket, blockedUsers); // voice signaling checks it
        rememberTutorialFlag(socket, user); // the tutorial's auto-start reads it

        if (where.game || where.held) {
            socket.emit('restoreSessionResponse', {
                success: true,
                username,
                activeGameId: activeGameId,
                blockedUsers,
                ...replyExtras(user)
            });
            authLogger.info('Session restored with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // Clear stale activeGameId if present
            // Scoped to the stale id: a game that starts meanwhile and
            // writes a new pointer must keep it. Never while this process
            // hands its tables off (LIVE_PERSIST=on, shutting down)
            if (activeGameId && !pointerResolve.holdsPointers()) {
                await gameManager.clearActiveGame(username, activeGameId);
            }

            // Check for active tournament
            const activeTournamentId = user.activeTournamentId;
            let activeTournament = pointerTournament(activeTournamentId, username);
            if (activeTournament && typeof activeTournament.then === 'function') activeTournament = await activeTournament;

            if (activeTournament) {
                socket.emit('restoreSessionResponse', {
                    success: true,
                    username,
                    activeTournamentId,
                    blockedUsers,
                    ...replyExtras(user)
                });
                authLogger.info('Session restored with active tournament', { username, socketId: socket.id, tournamentId: activeTournamentId });
            } else {
                if (activeTournamentId && !pointerResolve.holdsPointers()) {
                    await gameManager.clearActiveTournament(username, activeTournamentId);
                }
                socket.emit('restoreSessionResponse', { success: true, username, blockedUsers, ...replyExtras(user) });
                authLogger.info('Session restored', { username, socketId: socket.id });
            }
        }

    } catch (error) {
        if (claim) releaseClaim(socket, username, claim.previous);
        authLogger.error('Database error during session restore', { username, error: error.message });
        socket.emit('restoreSessionResponse', {
            success: false,
            message: DATABASE_ERROR_MESSAGE,
            ...RETRYABLE
        });
    }
}

/**
 * Permanently delete the signed-in user's account (App Store Guideline
 * 5.1.1(v) requires in-app deletion). Requires password re-confirmation.
 * Removes the user document and anonymizes the username in historical game
 * records, which are shared documents describing other players' games too
 * (server/admin/accountDelete.js, shared with the admin panel's delete).
 */
async function deleteAccount(socket, io, data) {
    const usersCollection = getUsersCollection();
    const { password } = data;

    if (!usersCollection) {
        socket.emit('deleteAccountResponse', {
            success: false,
            message: 'Database not ready. Try again.'
        });
        return;
    }

    // Only the authenticated session may delete its own account — never
    // accept a client-supplied username here
    const sessionUser = gameManager.getUserBySocketId(socket.id);
    if (!sessionUser) {
        socket.emit('deleteAccountResponse', {
            success: false,
            message: 'Not signed in'
        });
        return;
    }
    const username = sessionUser.username;

    // The password check counts like a sign-in (signInThrottle: per
    // username / IP failures across sockets), so a stolen signed-in socket
    // cannot guess the password through deleteAccount at reconnect speed
    const who = { ip: socket.data?.clientIp ?? null, username };
    const gate = signInThrottle.check(who);
    if (!gate.ok) {
        authLogger.warn('Account deletion throttled after repeated wrong passwords', { username, ip: who.ip, retryAfterMs: gate.retryAfterMs });
        socket.emit('deleteAccountResponse', { success: false, message: DELETE_THROTTLED_MESSAGE });
        return;
    }
    const reservation = signInThrottle.reserve(who);
    let passwordChecked = null; // true / false once compared; null: the failure does not count

    try {
        const user = await usersCollection.findOne({ username }, { projection: { password: 1, socketId: 1, isAdmin: 1 } });
        if (!user) {
            socket.emit('deleteAccountResponse', {
                success: false,
                message: 'Account not found'
            });
            return;
        }

        const passwordMatch = await passwordHash.compare(password, user.password);
        passwordChecked = Boolean(passwordMatch);
        if (!passwordMatch) {
            socket.emit('deleteAccountResponse', {
                success: false,
                message: 'Incorrect password'
            });
            authLogger.warn('Account deletion failed: incorrect password', { username });
            return;
        }

        // From here the deletion waits its turn in the admin panel's queue
        // (server/admin/mergeQueue.js), so an admin rename, merge or delete
        // of this account can never interleave with it, and the account is
        // read again by _id AND name: renamed or merged while the password
        // was checked, nothing is deleted
        const { serializeMerges } = require('../admin/mergeQueue');
        const refused = await serializeMerges(async () => {
            if (gameManager.isMergeLocked?.(username)) return MERGE_LOCKED_MESSAGE;
            const current = await usersCollection.findOne(
                { _id: user._id, username, mergedInto: { $exists: false } },
                { projection: { isAdmin: 1 } }
            );
            if (!current) return ACCOUNT_CHANGED_MESSAGE;

            // Not while playing (owner 2026-11-15, as the admin panel's
            // delete): a game (its draw included, any seat presence, a
            // /leave'd seat until the game ends) or a tournament that is not
            // complete, from memory. Otherwise the name's seat, round
            // scores and in-flight records would outlive the account. Then
            // the name is locked (GameManager.mergeLocks: no sign-in,
            // restore, rejoin, lobby, tournament or game start) in the same
            // synchronous step, until the deletion is done
            const live = gameManager.findLiveActivity?.(username);
            if (live) return live.kind === 'game' ? DELETE_IN_GAME_MESSAGE : DELETE_IN_TOURNAMENT_MESSAGE;
            gameManager.lockForMerge?.([username]);
            try {
                // LIVE_PERSIST=on: the saved pointer too, through resolve()
                if (pointerResolve.active()) {
                    const held = await savedGameRefusal(usersCollection, current._id, username);
                    if (held) return held;
                }
                return await eraseOwnAccount(io, usersCollection, user, current, username);
            } finally {
                gameManager.unlockMerge?.([username]);
            }
        });
        if (refused) {
            socket.emit('deleteAccountResponse', { success: false, message: refused });
            authLogger.warn('Account deletion refused', { username, reason: refused });
            return;
        }

        // Every other tab and device signed in as this account goes to the
        // sign-in screen (this socket gets its reply first, below)
        signOutUser(io, username, { socketId: user.socketId, except: socket.id });

        socket.emit('deleteAccountResponse', { success: true });
        authLogger.info('Account deleted', { username, socketId: socket.id });

        // Disconnect after the response flushes; the normal disconnect flow
        // cleans up any lobby/queue/game/tournament state (those handlers
        // run inside this callback, hence the guard)
        safeTimeout(() => socket.disconnect(true), 500, 'deleteAccountDisconnect');

    } catch (error) {
        if (isHashBusy(error)) {
            socket.emit('deleteAccountResponse', { success: false, message: BUSY_MESSAGE });
            return;
        }
        authLogger.error('Database error during account deletion', { username, error: error.message });
        socket.emit('deleteAccountResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    } finally {
        // As signIn: a wrong password counts, a right one clears the pair;
        // no account, a busy pool or a DB error before the compare do not
        if (passwordChecked === true) signInThrottle.recordSuccess(who, reservation);
        else if (passwordChecked === false) signInThrottle.confirm(who);
        else signInThrottle.release(who, reservation);
    }
}

/**
 * Self delete, LIVE_PERSIST=on (deploy survival PR 5, the plan's 2.6): the
 * account's saved activeGameId, resolved. A game in memory, adopted now or
 * pending on another live instance refuses the deletion (the account's
 * seat may still come back); a pointer nothing holds (no doc, no live
 * instance lists it) is stale: cleared (scoped), and the deletion goes on,
 * so a stale pointer can never block it. While this process hands its
 * tables off, any pointer refuses. Runs with the name locked.
 * @returns {Promise<string|null>} a refusal or null
 */
async function savedGameRefusal(usersCollection, userId, username) {
    const doc = await usersCollection.findOne({ _id: userId, username }, { projection: { activeGameId: 1 } });
    const gameId = doc?.activeGameId;
    if (!gameId) return null;
    if (pointerResolve.holdsPointers()) return DELETE_IN_GAME_MESSAGE;
    const r = await pointerResolve.resolveGame(gameId);
    if (r.state !== 'gone') return DELETE_IN_GAME_MESSAGE;
    await gameManager.clearActiveGame(username, gameId);
    return null;
}

/**
 * deleteAccount's turn in the queue, with the name locked: the admin flag,
 * then the shared deletion. @returns {Promise<string|null>} a refusal or null
 */
async function eraseOwnAccount(io, usersCollection, user, current, username) {
    // The last admin cannot delete their account (it would leave
    // nobody able to open the admin panel). The flag comes off first
    // through the same guard as the panel's Remove admin (remove,
    // count, put it back if nobody is left), so two last admins
    // deleting at once cannot both go
    if (current.isAdmin === true) {
        const { setAdminFlag } = require('../admin/adminRole');
        try {
            await setAdminFlag({ users: usersCollection }, username, false, { by: username });
        } catch (error) {
            if (error && error.code === 'last_admin') return LAST_ADMIN_DELETE_MESSAGE;
            throw error;
        }
    }

    // The shared deletion (server/admin/accountDelete.js, also the
    // admin panel's): game records anonymized, open reset links
    // revoked, reports marked, the user document replaced by its name
    // hold and its tombstones deleted, then the in-memory caches, the
    // avatar store and deletedUsernames. Other players' blocks of this
    // name stay (pullBlocks: false): deleting the account and signing up
    // again as the same name must not clear them
    const database = require('../database');
    const db = {
        users: usersCollection,
        gameRecords: getGameRecordsCollection(),
        reports: database.getReportsCollection?.(),
        passwordResets: database.getPasswordResetsCollection?.()
    };
    const erased = await eraseAccount(db, { _id: user._id, username }, { pullBlocks: false });
    await forgetAccount(io, db, username, erased);
    return null;
}

/**
 * Change password (owner 2026-11-15; c2s changePassword {current, next} ->
 * changePasswordResponse {success, message}): the signed-in socket only
 * (never a client-supplied username). The current-password check counts in
 * signInThrottle exactly like deleteAccount's (a hijacked signed-in socket
 * cannot guess through it); the new one must pass the new-password rule
 * (8-100) and differ from the current one. Then: open reset links
 * cancelled, ONE guarded write (still this account, still the hash that
 * was checked: a reset or another change meanwhile wins) sets the hash and
 * revokes every saved session but this device's (revokeOtherSessions, the
 * epoch bumped), and every OTHER live socket of the name is signed out
 * (signOutUser except this one: forceLogout, so other devices show sign-in).
 * Existing shorter passwords keep working for sign-in until changed.
 */
async function changePassword(socket, io, data) {
    const reply = (success, message) => socket.emit('changePasswordResponse', { success, message });
    const usersCollection = getUsersCollection();
    if (!usersCollection) return reply(false, 'Database not ready. Try again.');
    const sessionUser = gameManager.getUserBySocketId(socket.id);
    if (!sessionUser) return reply(false, 'Not signed in');
    const username = sessionUser.username;
    const { current, next } = data;

    // Cheap refusals first: nothing read, nothing counted
    if (!checkPasswordRule(next)) return reply(false, PASSWORD_RULE_MESSAGE);
    if (next === current) return reply(false, SAME_PASSWORD_MESSAGE);

    const who = { ip: socket.data?.clientIp ?? null, username };
    const gate = signInThrottle.check(who);
    if (!gate.ok) {
        authLogger.warn('Password change throttled after repeated wrong passwords', { username, ip: who.ip, retryAfterMs: gate.retryAfterMs });
        return reply(false, DELETE_THROTTLED_MESSAGE);
    }
    const reservation = signInThrottle.reserve(who);
    let passwordChecked = null; // as deleteAccount

    try {
        const user = await usersCollection.findOne(
            { username, mergedInto: { $exists: false } },
            { projection: { password: 1, socketId: 1, sessionTokens: 1, sessionToken: 1 } }
        );
        if (!user) return reply(false, 'Account not found');
        const match = typeof user.password === 'string' && await passwordHash.compare(current, user.password);
        passwordChecked = Boolean(match);
        if (!match) {
            authLogger.warn('Password change failed: incorrect current password', { username });
            return reply(false, WRONG_CURRENT_PASSWORD_MESSAGE);
        }
        if (gameManager.isMergeLocked?.(username)) return reply(false, MERGE_LOCKED_MESSAGE);

        const hash = await passwordHash.hash(next, 10);
        const now = new Date();
        const database = require('../database');
        // Before the write (setPassword's order): a failure changes nothing
        const revokedLinks = await revokeOpenResetLinks({ passwordResets: database.getPasswordResetsCollection?.() }, { username }, { now });
        const { kept, ...revoke } = revokeOtherSessions(user, socket.data?.sessionHash, now);
        const before = await usersCollection.findOneAndUpdate(
            { _id: user._id, username, mergedInto: { $exists: false }, password: user.password },
            { ...revoke, $set: { ...revoke.$set, password: hash, passwordChangedAt: now } },
            { returnDocument: 'before', projection: { socketId: 1 } }
        );
        if (!before) {
            authLogger.warn('Password change lost a race (reset, merge or another change)', { username });
            return reply(false, PASSWORD_CHANGE_RACE_MESSAGE);
        }
        const signedOut = signOutUser(io, username, { socketId: before.socketId, except: socket.id });
        authLogger.info('Password changed', { username, keptThisDevice: kept, revokedLinks, signedOut });
        return reply(true, PASSWORD_CHANGED_MESSAGE);
    } catch (error) {
        if (isHashBusy(error)) return reply(false, BUSY_MESSAGE);
        authLogger.error('Database error during password change', { username, error: error.message });
        return reply(false, DATABASE_ERROR_MESSAGE);
    } finally {
        if (passwordChecked === true) signInThrottle.recordSuccess(who, reservation);
        else if (passwordChecked === false) signInThrottle.confirm(who);
        else signInThrottle.release(who, reservation);
    }
}

module.exports = {
    signOutSocket,
    signOutUser,
    claimSocket,
    releaseClaim,
    MERGE_LOCKED_MESSAGE,
    tombstoneMessage,
    // Counted as a restore in flight for requestSnapshot's deferral (LIVE_PERSIST=on)
    signIn: pointerResolve.tracked(signIn),
    signUp,
    restoreSession: pointerResolve.tracked(restoreSession),
    deleteAccount,
    changePassword
};
