/**
 * Authentication socket event handlers
 */

const passwordHash = require('../utils/passwordHash');
const signInThrottle = require('./signInThrottle');
const rateLimiter = require('./rateLimiter');
const { describeClientAddress } = require('../utils/clientIp');
const { getUsersCollection, getGameRecordsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { issueSession, verifySession, hasLiveSession } = require('../utils/sessionTokens');
const { checkNewUsername, findNameClash, takenMessage, MESSAGES: USERNAME_MESSAGES } = require('../utils/usernameRules');
const { rememberBlockList } = require('./voiceHandlers');

/**
 * Accounts merged by scripts/merge-accounts.js stay behind as tombstones
 * ({ username, mergedInto }). Tell the player which account to use instead
 * of a generic "wrong password", since they likely forgot which one is theirs.
 */
const BUSY_MESSAGE = 'Server is busy. Try again in a moment.';
const THROTTLED_MESSAGE = 'Too many failed sign-in attempts. Please wait a few minutes and try again.';
const SIGN_UP_LIMIT_MESSAGE = 'Too many sign-up attempts. Please wait a few minutes and try again.';
const LAST_ADMIN_DELETE_MESSAGE = 'You are the only admin. Make someone else an admin before deleting your account.';
const SESSIONS_CHANGED_MESSAGE = 'Your account was just signed out everywhere. Please sign in again.';
const isHashBusy = (error) => Boolean(error && error.code === 'HASH_BUSY');

function mergedAccountMessage(username, mergedInto) {
    return `"${username}" was combined into your account "${mergedInto}". Please sign in as ${mergedInto}.`;
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
    gameManager.handleDisconnect(socketId);
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
 * flight. Returns how many were connected.
 */
function signOutUser(io, username, { socketId = null } = {}) {
    const ids = new Set((gameManager.currentUsers || []).filter(u => u.username === username).map(u => u.socketId));
    if (socketId) ids.add(socketId);
    for (const [id, sock] of io?.sockets?.sockets || []) {
        if (sock?.data?.username === username) ids.add(id);
    }
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
async function sessionGoneSince(usersCollection, socket, username, hash) {
    if (socket.connected === false) return 'disconnected';
    if (gameManager.isMergeLocked?.(username)) return 'merge';
    let user;
    try {
        user = await usersCollection.findOne(
            { username },
            { projection: { mergedInto: 1, 'sessionTokens.hash': 1, 'sessionTokens.lastUsedAt': 1, 'sessionTokens.createdAt': 1, sessionToken: 1 } }
        );
    } catch (error) {
        authLogger.error('Session re-check failed', { username, error: error.message });
        return 'error'; // fail closed
    }
    if (socket.connected === false) return 'disconnected';
    if (gameManager.isMergeLocked?.(username)) return 'merge';
    if (!user || user.mergedInto || !hasLiveSession(user, hash)) return 'revoked';
    return null;
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
 * signIn/restoreSession read everything on the user document except the
 * big or unused fields: the custom picture (up to ~500 KB base64), stats
 * and the merge audit log. Exclusion keeps password, mergedInto, socketId,
 * sessionTokens, the legacy sessionToken, activeGameId, activeTournamentId
 * and blockedUsers.
 */
const SIGN_IN_PROJECTION = { customProfilePic: 0, stats: 0, mergedFrom: 0 };
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

        if (!user) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            authLogger.warn('Sign-in failed: user not found', { username });
            failed = true;
            return;
        }

        if (user.mergedInto) {
            socket.emit('signInResponse', {
                success: false,
                message: mergedAccountMessage(username, user.mergedInto)
            });
            authLogger.info('Sign-in to merged account redirected', { username, mergedInto: user.mergedInto });
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
        gameManager.registerUser(socket.id, username);
        const gone = await sessionGoneSince(usersCollection, socket, username, session.hash);
        if (gone) {
            unregister(io, socket, username, previousEntry, claim.previous);
            claim = null;
            if (gone !== 'disconnected') {
                socket.emit('signInResponse', { success: false, message: gone === 'merge' ? MERGE_LOCKED_MESSAGE : SESSIONS_CHANGED_MESSAGE });
            }
            authLogger.warn('Sign-in undone: the session ended while it was being recorded', { username, reason: gone });
            return;
        }
        claim = null; // signed in: the name stays claimed

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        const activeGame = activeGameId ? gameManager.getGameById(activeGameId) : null;

        const blockedUsers = user.blockedUsers || [];
        rememberBlockList(socket, blockedUsers); // voice signaling checks it

        if (activeGame) {
            // User has an active game - notify client
            socket.emit('signInResponse', {
                success: true,
                username,
                sessionToken,
                activeGameId: activeGameId,
                blockedUsers,
                ...adminDisplay(user)
            });
            authLogger.info('User signed in with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // No active game (or game no longer exists) - clear stale activeGameId if present
            // Scoped to the stale id: a game that starts meanwhile and
            // writes a new pointer must keep it
            if (activeGameId) {
                await gameManager.clearActiveGame(username, activeGameId);
            }

            // Check for active tournament
            const activeTournamentId = user.activeTournamentId;
            const activeTournament = activeTournamentId ? gameManager.getTournamentById(activeTournamentId) : null;

            if (activeTournament) {
                socket.emit('signInResponse', {
                    success: true,
                    username,
                    sessionToken,
                    activeTournamentId,
                    blockedUsers,
                    ...adminDisplay(user)
                });
                authLogger.info('User signed in with active tournament', { username, socketId: socket.id, tournamentId: activeTournamentId });
            } else {
                if (activeTournamentId) {
                    await gameManager.clearActiveTournament(username, activeTournamentId);
                }
                socket.emit('signInResponse', { success: true, username, sessionToken, blockedUsers, ...adminDisplay(user) });
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
        // Counted: unknown user, wrong password. Not counted: a merged
        // account, a database error, a busy hash pool. Success clears the pair.
        if (succeeded) signInThrottle.recordSuccess(who, reservation);
        else if (failed) signInThrottle.confirm(who);
        else signInThrottle.release(who, reservation);
    }
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

    try {
        // Taken ignoring case and surrounding whitespace ("alan T" vs "Alan T")
        const existingUser = await findNameClash(usersCollection, username);

        if (existingUser) {
            socket.emit('signUpResponse', {
                success: false,
                message: existingUser.exact && existingUser.mergedInto
                    ? mergedAccountMessage(username, existingUser.mergedInto)
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
        // which both clients show (never `error`, a generic toast on iOS).
        if (!rateLimiter.check(socket.id, 'signUpAccount')) {
            socket.emit('signUpResponse', { success: false, message: SIGN_UP_LIMIT_MESSAGE });
            authLogger.warn('Sign-up refused: account budget spent', { socketId: socket.id });
            return;
        }

        // Session token for reconnection (this device's first session)
        const session = issueSession(null);
        const sessionToken = session.token;

        const hashedPassword = await passwordHash.hash(password, 10);
        // Generate random profile pic (1-82)
        const profilePic = Math.floor(Math.random() * 82) + 1;
        await usersCollection.insertOne({
            username,
            password: hashedPassword,
            socketId: socket.id,  // Set socketId immediately for auto-login
            sessionTokens: session.update.$set.sessionTokens,
            profilePic,
            stats: {
                wins: 0,
                losses: 0,
                gamesPlayed: 0,
                totalPoints: 0,
                totalTricksBid: 0,
                totalTricksTaken: 0
            }
        });
        socket.data.sessionHash = session.hash;
        claimSocket(socket, username);

        // The name now belongs to a fresh account — stop anonymizing it in
        // new game records (only relevant if a deleted name is re-registered)
        gameManager.deletedUsernames.delete(username);

        // Auto-login: register with game manager (same as signIn)
        gameManager.registerUser(socket.id, username);
        rememberBlockList(socket, []);

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

        if (!user) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'User not found'
            });
            authLogger.warn('Session restore failed: user not found', { username });
            return;
        }

        if (user.mergedInto) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: mergedAccountMessage(username, user.mergedInto)
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
        gameManager.registerUser(socket.id, username);
        const gone = await sessionGoneSince(usersCollection, socket, username, session.hash);
        if (gone) {
            unregister(io, socket, username, previousEntry, claim.previous);
            claim = null;
            if (gone !== 'disconnected') {
                socket.emit('restoreSessionResponse', { success: false, message: gone === 'merge' ? MERGE_LOCKED_MESSAGE : 'Invalid session token' });
            }
            authLogger.warn('Session restore undone: the session ended while it was being recorded', { username, reason: gone });
            return;
        }
        claim = null; // signed in: the name stays claimed

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        const activeGame = activeGameId ? gameManager.getGameById(activeGameId) : null;
        const blockedUsers = user.blockedUsers || [];
        rememberBlockList(socket, blockedUsers); // voice signaling checks it

        if (activeGame) {
            socket.emit('restoreSessionResponse', {
                success: true,
                username,
                activeGameId: activeGameId,
                blockedUsers,
                ...adminDisplay(user)
            });
            authLogger.info('Session restored with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // Clear stale activeGameId if present
            // Scoped to the stale id: a game that starts meanwhile and
            // writes a new pointer must keep it
            if (activeGameId) {
                await gameManager.clearActiveGame(username, activeGameId);
            }

            // Check for active tournament
            const activeTournamentId = user.activeTournamentId;
            const activeTournament = activeTournamentId ? gameManager.getTournamentById(activeTournamentId) : null;

            if (activeTournament) {
                socket.emit('restoreSessionResponse', {
                    success: true,
                    username,
                    activeTournamentId,
                    blockedUsers,
                    ...adminDisplay(user)
                });
                authLogger.info('Session restored with active tournament', { username, socketId: socket.id, tournamentId: activeTournamentId });
            } else {
                if (activeTournamentId) {
                    await gameManager.clearActiveTournament(username, activeTournamentId);
                }
                socket.emit('restoreSessionResponse', { success: true, username, blockedUsers, ...adminDisplay(user) });
                authLogger.info('Session restored', { username, socketId: socket.id });
            }
        }

    } catch (error) {
        if (claim) releaseClaim(socket, username, claim.previous);
        authLogger.error('Database error during session restore', { username, error: error.message });
        socket.emit('restoreSessionResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

/**
 * Permanently delete the signed-in user's account (App Store Guideline
 * 5.1.1(v) requires in-app deletion). Requires password re-confirmation.
 * Removes the user document and anonymizes the username in historical game
 * records, which are shared documents describing other players' games too.
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
        if (!passwordMatch) {
            socket.emit('deleteAccountResponse', {
                success: false,
                message: 'Incorrect password'
            });
            authLogger.warn('Account deletion failed: incorrect password', { username });
            return;
        }

        // The last admin cannot delete their account (it would leave nobody
        // able to open the admin panel). The flag comes off first through
        // the same guard as the panel's Remove admin (remove, count, put it
        // back if nobody is left), so two last admins deleting at once
        // cannot both go
        if (user.isAdmin === true) {
            const { setAdminFlag } = require('../admin/adminRole');
            try {
                await setAdminFlag({ users: usersCollection }, username, false, { by: username });
            } catch (error) {
                if (error && error.code === 'last_admin') {
                    socket.emit('deleteAccountResponse', { success: false, message: LAST_ADMIN_DELETE_MESSAGE });
                    authLogger.warn('Account deletion refused: the only admin', { username });
                    return;
                }
                throw error;
            }
        }

        const gameRecords = getGameRecordsCollection();
        if (gameRecords) {
            await gameRecords.updateMany(
                { team1Players: username },
                { $set: { 'team1Players.$[p]': '[deleted]' } },
                { arrayFilters: [{ p: username }] }
            );
            await gameRecords.updateMany(
                { team2Players: username },
                { $set: { 'team2Players.$[p]': '[deleted]' } },
                { arrayFilters: [{ p: username }] }
            );
        }

        // Removes password hash, session token, stats (and with them the
        // leaderboard entry), profile pictures, and active game/tournament
        // pointers in one shot — everything else is keyed by this document
        await usersCollection.deleteOne({ username });

        // Old accounts merged into this one only reserve their names; remove
        // them too so nothing tied to this person remains
        await usersCollection.deleteMany({ mergedInto: username });

        // The leaderboard row is gone and the records now say '[deleted]'
        const { invalidateLeaderboard, invalidateRecords } = require('./profileHandlers');
        invalidateLeaderboard?.();
        invalidateRecords?.();
        require('../avatar/avatarStore').forgetUser(username);

        // Keep an in-flight game from re-inserting this username into a new
        // game record after the anonymization above
        gameManager.deletedUsernames.add(username);

        // Force-logout any other device signed into this account
        if (user.socketId && user.socketId !== socket.id) {
            const otherSocket = io.sockets.sockets.get(user.socketId);
            if (otherSocket) {
                otherSocket.emit('forceLogout');
                otherSocket.disconnect();
            }
        }

        socket.emit('deleteAccountResponse', { success: true });
        authLogger.info('Account deleted', { username, socketId: socket.id });

        // Disconnect after the response flushes; the normal disconnect flow
        // cleans up any lobby/queue/game/tournament state
        setTimeout(() => socket.disconnect(true), 500);

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
    }
}

module.exports = {
    signOutSocket,
    signOutUser,
    claimSocket,
    releaseClaim,
    MERGE_LOCKED_MESSAGE,
    signIn,
    signUp,
    restoreSession,
    deleteAccount
};
