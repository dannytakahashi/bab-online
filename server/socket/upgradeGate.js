/**
 * Update screen for the old App Store iOS builds: 1.0.0 (build 1, source
 * cc9059f; gated since 2026-11-11) and 1.1.0 (build 2, source f05d264;
 * gated once 1.2.0 is live: owner decision, MIN_IOS_BUILD 3). All a player
 * on an old build should see is "please update the app", while the app
 * keeps its saved session so the update finds the player signed in.
 *
 * Detection: positive identification only, fail open. Every iOS build opens
 * with HTTP long-polling through URLSession (Socket.IO-Client-Swift
 * `.forceWebsockets(false)`), whose default User-Agent is
 * `<CFBundleName>/<CFBundleVersion> CFNetwork/<v> Darwin/<v>`. Captured from
 * simulator builds of cc9059f and f05d264 (2026-11-11):
 *   1.0.0  "BAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0"
 *   1.1.0  "BAB%20Online/2 CFNetwork/3896.200.61 Darwin/27.2.0"
 *   1.2.0  "BAB%20Online/6 ..." (the App Store build since 2026-11-13: build 5
 *          + the new app icon; build 3 was uploaded, never submitted; build 4
 *          was pulled from review)
 *   1.2.1  "BAB%20Online/7 ..." on TestFlight; 8 is the next build
 * The websocket upgrade request (Starscream) carries no User-Agent, but
 * socket.handshake keeps the polling handshake's headers for the socket's
 * life. A socket is gated only when that header parses as the iOS app with a
 * build number below MIN_IOS_BUILD; a browser, a missing or unparseable
 * header, and build 3 or later are never gated. `clientHello` cannot be the
 * signal: 1.0.0 and 1.1.0 never send it.
 *
 * What both old builds do with what they get (AuthSocketHandler.swift at
 * cc9059f and f05d264; the handlers below read the same keys in both):
 *   restoreSessionResponse {success:false}  CLEARS its saved token. Never sent.
 *   signInResponse {success:false, message} sets authState.error, which
 *       SignInView (and RegisterView) shows in red; credentials untouched.
 *       A plain socket.on, so an unrequested one is shown too.
 *   signUpResponse {success:false, message} the same on RegisterView.
 *   mainRoomJoined                            replaces the main room's chat
 *       (1.0.0 reads recentMessages, 1.1.0 recentMessages ?? messages),
 *       lobbies, games and tournaments (no navigation).
 *   leftGame / leftLobby / tournamentLeft     navigate to the main room
 *       (1.1.0 also sends joinMainRoom after leftGame / tournamentLeft, and
 *       MainRoomView.onAppear sends it; a leftGame inside a tournament game
 *       sends returnToTournament, which gets tournamentLeft).
 *   app-level `error`                         never sent (1.1.0 would toast it).
 * So a gated socket gets the update message on every screen it can be on:
 *   - sign-in / register (every cold start: SplashView 1.5 s, then SignInView;
 *     both SignInView.onAppear and RegisterView.onAppear clear
 *     authState.error, and switching between them sends nothing): signInResponse
 *     pushed PUSH_DELAYS_MS after connect, then every REPEAT_MS while the
 *     socket stays connected (so a trip to Register and back shows it again
 *     within REPEAT_MS), and as the reply to restoreSession, signIn and signUp
 *     (signUpResponse);
 *   - main room (a warm reconnect after a deploy or a long background):
 *     a mainRoomJoined whose only content is the message, pushed once and
 *     sent again on joinMainRoom;
 *   - game table / lobby (warm reconnect): the app's in-game Leave (`/leave`)
 *     gets leftGame, a lobby's Leave gets leftLobby, a tournament's leave /
 *     return gets tournamentLeft, so every way out lands in that main room.
 *     (No game-log copy: gameLogEntry is a room broadcast that carries seq.)
 *   - the draw (warm reconnect while "Draw for Deal" is up): 1.1.0's Leave
 *     cannot be reached during the draw (found in the 2026-11-12 live check;
 *     f05d264 GameContainerView). On a phone the corner Leave stays ENABLED
 *     but DrawPhaseView's full-screen `Color.black.opacity(0.7)` overlay sits
 *     above tablePane in gameContent's ZStack and takes every tap; on the
 *     Duo's vertical bar `leaveBarButton` is `.disabled(gameState.phase ==
 *     .draw)`. So do not audit this by searching for `.disabled`: what makes
 *     Leave unreachable on most devices is the overlay. Tap to Draw (`draw`)
 *     is the only way out and gets leftGame too (both builds send `draw`
 *     only from DrawPhaseView). A player who had
 *     already drawn before the deploy has no button left: force-quitting
 *     lands on sign-in with the message.
 * Nothing else is registered for a gated socket (setupSocketHandlers returns
 * before its handlers), so every other event is ignored: it never signs in,
 * is never registered as online, never joins a room, never touches a game,
 * lobby or tournament. Every emit is rate limited per socket.
 *
 * "You'll stay signed in": sessions expire SESSION_TTL_MS after lastUsedAt
 * (utils/sessionTokens.js), and before the gate every launch of an old build
 * refreshed it through restoreSession. So the first restoreSession of a gated
 * socket does the one database touch the gate makes: it reads the user's
 * sessions and, for a token verifySession accepts, moves that one entry's
 * lastUsedAt to now (an atomic arrayFilters $set; nothing else on the user
 * changes: no socketId, no registerUser, no restoreSessionResponse). A player
 * who keeps opening an old build therefore keeps the session the update
 * restores (every build keeps it in the Keychain service com.bab-online.auth
 * under the same accounts). A token that is
 * not accepted (expired, evicted by MAX_SESSIONS, a merged account) gets the
 * signed-out message from then on. A database error changes nothing.
 *
 * Kill switch: UPGRADE_GATE=off (also false / 0 / disabled / no), read at each
 * connection. Telemetry: one info line per gated connection (build, the
 * username it sent if any; never a token or password), plus the parsed build
 * of every iOS socket (adoption).
 */

'use strict';

const { socketLogger } = require('../utils/logger');
const { getUsersCollection } = require('../database');
const { verifySession } = require('../utils/sessionTokens');
// The kill switch, shared with server/game/pacing.js (the solo overlay)
const { gateEnabled } = require('../utils/upgradeGateSwitch');

/**
 * First iOS build number that is never gated: 1.0.0 (1) and 1.1.0 (2) are,
 * 1.2.0 (6 in the App Store, live 2026-11-13; 3 was never submitted, 4 was
 * pulled from review, 5 was replaced by 6), 1.2.1 (7 on TestFlight, 8 next)
 * and later are not.
 */
const MIN_IOS_BUILD = 3;

// Short: SignInView shows it as a caption that truncates once the keyboard
// is up (measured: about 2 lines at 375 pt wide), and as one main-room chat line
const UPDATE_MESSAGE = "Update required. Please update BAB Online in the App Store. You'll stay signed in.";
/** For a socket that sent no restoreSession (no saved session to keep). */
const UPDATE_MESSAGE_SIGNED_OUT = 'Update required. Please update BAB Online in the App Store.';
const SENDER = 'BAB Online';

// Unsolicited signInResponse pushes after connect (ms). Not game pacing: the
// first can land under the 1.5 s splash (SignInView.onAppear clears it), the
// later ones after it.
const PUSH_DELAYS_MS = Object.freeze([300, 2000, 5000]);
/** The push that also carries the main-room copy and the log line. */
const MAIN_PUSH = 1;
// After the last of those, signInResponse again every REPEAT_MS while the
// socket is connected: the app's screen changes send nothing, so this is the
// only way to put the message back after Register -> Sign In clears it.
const REPEAT_MS = 6000;
// At most EMIT_LIMIT gate emits per socket per EMIT_WINDOW_MS (taps on Sign In,
// a client looping on something); over it, emits are dropped silently. The
// timed pushes stop at EMIT_LIMIT - REPLY_RESERVE, so replies always have room.
const EMIT_LIMIT = 20;
const REPLY_RESERVE = 6;
const EMIT_WINDOW_MS = 60 * 1000;

const UA_MAX = 512;
// "BAB%20Online/<digits> ... CFNetwork/<v> ... Darwin/<v>": the product token
// must lead and the build must be a plain integer (a dotted or other
// CFBundleVersion fails to parse and is never gated)
const IOS_UA = /^BAB(?:%20| )Online\/(\d{1,9}) (?:.* )?CFNetwork\/\d[\d.]* (?:.* )?Darwin\/\d[\d.]*(?: |$)/;

/**
 * Parse the iOS app's URLSession User-Agent.
 * @returns {{client: 'ios', build: number} | null} null for anything else
 */
function parseIosUserAgent(ua) {
    if (typeof ua !== 'string' || ua.length === 0 || ua.length > UA_MAX) return null;
    const m = IOS_UA.exec(ua);
    if (!m) return null;
    const build = Number(m[1]);
    if (!Number.isSafeInteger(build)) return null;
    return { client: 'ios', build };
}

/** The handshake's User-Agent, or undefined (never throws). */
function handshakeUserAgent(socket) {
    try {
        const ua = socket?.handshake?.headers?.['user-agent'];
        return typeof ua === 'string' ? ua : undefined;
    } catch {
        return undefined;
    }
}


/** Is this the old iOS build? Positive identification only. */
function isOutdatedIosApp(ua) {
    const app = parseIosUserAgent(ua);
    return app !== null && app.build < MIN_IOS_BUILD;
}

const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * Called first for every connection (setupSocketHandlers). Records the
 * parsed iOS build on socket.data.appBuild; gates the socket when it is the
 * old build and the gate is on.
 * @returns {boolean} true when the socket is gated (register nothing else)
 */
function gate(socket) {
    const ua = handshakeUserAgent(socket);
    const app = parseIosUserAgent(ua);
    if (app && socket.data) socket.data.appBuild = app.build;
    if (app) socketLogger.info('iOS app connected', { socketId: socket.id, build: app.build });
    if (!app || app.build >= MIN_IOS_BUILD) return false;
    if (!gateEnabled()) return false;
    if (typeof socket.on !== 'function' || typeof socket.emit !== 'function') return false;
    attach(socket, app);
    return true;
}

function attach(socket, app) {
    const st = {
        username: null, restored: false, sessionValid: null, refreshTried: false,
        logged: false, emits: [], timers: [], interval: null, connected: true,
    };

    const send = (event, payload, reserve = 0) => {
        if (!st.connected) return;
        const now = Date.now();
        while (st.emits.length && now - st.emits[0] >= EMIT_WINDOW_MS) st.emits.shift();
        if (st.emits.length >= EMIT_LIMIT - reserve) return;
        st.emits.push(now);
        if (payload === undefined) socket.emit(event); else socket.emit(event, payload);
    };
    // "You'll stay signed in" only while the saved session is (or may be) valid
    const message = () => (st.restored && st.sessionValid !== false ? UPDATE_MESSAGE : UPDATE_MESSAGE_SIGNED_OUT);
    const note = (data) => {
        const u = str(data?.username);
        if (u) st.username = u;
    };
    // One info line per gated connection that lived to the main push or sent
    // a username; a socket the app dropped at once (its foreground
    // forceReconnect replaces the launch socket) is debug only
    const logOnce = (quiet = false) => {
        if (st.logged) return;
        st.logged = true;
        const fields = { socketId: socket.id, build: app.build, username: st.username, savedSession: st.restored };
        if (quiet && !st.username) socketLogger.debug('Upgrade gate: outdated iOS app (dropped at once)', fields);
        else socketLogger.info('Upgrade gate: outdated iOS app', fields);
    };

    function sendUpdateMessage(reserve = 0) {
        send('signInResponse', { success: false, message: message() }, reserve);
    }
    function replySignUp() {
        send('signUpResponse', { success: false, message: message() });
    }
    function sendMainRoom() {
        const line = [{ username: SENDER, message: message(), timestamp: Date.now() }];
        send('mainRoomJoined', {
            // recentMessages: the key 1.0.0 reads first (the main-room
            // handlers no longer send it: V1_REMOVALS #13)
            messages: line, recentMessages: line, lobbies: [], onlineCount: 0, onlineUsers: [], inProgressGames: [], tournaments: [],
        });
    }
    function replyLeave(event) {
        send(event, event === 'leftGame' ? undefined : {});
    }

    socket.on('restoreSession', (data) => {
        st.restored = true;
        note(data);
        sendUpdateMessage();
        if (!st.refreshTried) {
            st.refreshTried = true;
            refreshSession(data).then((valid) => {
                if (valid !== null) st.sessionValid = valid;
            });
        }
    });
    socket.on('signIn', (data) => { note(data); sendUpdateMessage(); });
    socket.on('signUp', (data) => { note(data); replySignUp(); });
    socket.on('joinMainRoom', () => sendMainRoom());
    // The in-game Leave button sends the /leave chat command
    socket.on('chatMessage', (data) => {
        if (typeof data?.message === 'string' && data.message.trim().toLowerCase() === '/leave') replyLeave('leftGame');
    });
    // Tap to Draw: the only control a stale draw screen leaves (1.1.0's Leave
    // is covered by the draw overlay on phones, disabled on the Duo's bar)
    socket.on('draw', () => replyLeave('leftGame'));
    socket.on('leaveLobby', () => replyLeave('leftLobby'));
    socket.on('leaveTournament', () => replyLeave('tournamentLeft'));
    socket.on('returnToTournament', () => replyLeave('tournamentLeft'));
    socket.on('disconnect', () => {
        st.connected = false;
        for (const t of st.timers) clearTimeout(t);
        st.timers = [];
        if (st.interval) clearInterval(st.interval);
        st.interval = null;
        logOnce(true);
    });

    const last = PUSH_DELAYS_MS.length - 1;
    PUSH_DELAYS_MS.forEach((ms, i) => {
        const t = setTimeout(() => {
            sendUpdateMessage(REPLY_RESERVE);
            if (i === MAIN_PUSH) {
                sendMainRoom();
                logOnce();
            }
            if (i === last && st.connected) {
                st.interval = setInterval(() => sendUpdateMessage(REPLY_RESERVE), REPEAT_MS);
                if (typeof st.interval?.unref === 'function') st.interval.unref();
            }
        }, ms);
        if (typeof t?.unref === 'function') t.unref();
        st.timers.push(t);
    });
}

/**
 * Keep a gated device's saved session alive: for a token verifySession
 * accepts, set that one entry's lastUsedAt to now. Never throws.
 * @returns {Promise<boolean|null>} true: refreshed; false: not a live session
 *   (expired, evicted, unknown user, merged account); null: not checked
 *   (bad payload, no database, a database error)
 */
async function refreshSession(data) {
    const username = typeof data?.username === 'string' ? data.username : null;
    const token = typeof data?.sessionToken === 'string' ? data.sessionToken : null;
    if (!username || !token || username.length > 64 || token.length > 128) return null;
    try {
        const users = getUsersCollection();
        if (!users) return null;
        const user = await users.findOne({ username }, { projection: { sessionTokens: 1, sessionToken: 1, mergedInto: 1 } });
        if (!user || user.mergedInto) return false;
        const now = new Date();
        const session = verifySession(user, token, now);
        if (!session) return false;
        // a legacy plaintext sessionToken has no expiry: nothing to refresh
        if (!(user.sessionTokens || []).some((e) => e && e.hash === session.hash)) return true;
        await users.updateOne(
            { username, 'sessionTokens.hash': session.hash },
            { $set: { 'sessionTokens.$[s].lastUsedAt': now } },
            { arrayFilters: [{ 's.hash': session.hash }] },
        );
        return true;
    } catch (err) {
        socketLogger.debug('Upgrade gate: session refresh failed', { error: err?.message });
        return null;
    }
}

module.exports = {
    MIN_IOS_BUILD,
    UPDATE_MESSAGE,
    UPDATE_MESSAGE_SIGNED_OUT,
    PUSH_DELAYS_MS,
    REPEAT_MS,
    EMIT_LIMIT,
    REPLY_RESERVE,
    EMIT_WINDOW_MS,
    parseIosUserAgent,
    isOutdatedIosApp,
    gateEnabled,
    gate,
};
