// Preload for the iOS live resume harness (scripts/ios-live-resume-harness.sh), never
// for production: `node -r scripts/ios-live-resume-preload.js server/index.js`.
//
// - server/index.js listens on a hard-coded 3000: remapped to BAB_LIVE_PORT on 127.0.0.1.
// - server/database.js uses DB_NAME, else 'babonline': the default is remapped to BAB_LIVE_DB
//   (setting DB_NAME is the cleaner way for a new check; this keeps working without it).
// - Logs every Engine.IO handshake, namespace connect / close and selected events per
//   socket id ('[keeplog]' lines, no payload secrets): the server-side proof that a kept
//   connection made no new handshake, and the probe's requestSnapshot and its answer.
// - Writes the answer to each foreground probe (stateSnapshot with a requestId "fg-N") to
//   $BAB_LIVE_CTL/probe-snapshot.json ({requestId, stage, hand}) for
//   LiveForegroundResumeTests to compare with the table it shows.
const fs = require('fs');
const http = require('http');
const path = require('path');

const port = Number(process.env.BAB_LIVE_PORT);
if (!Number.isInteger(port) || port <= 0 || port === 3000) {
    throw new Error('ios-live-resume-preload: BAB_LIVE_PORT must be set and not 3000');
}
const dbName = process.env.BAB_LIVE_DB;
if (!dbName || dbName.toLowerCase() === 'babonline') {
    throw new Error('ios-live-resume-preload: BAB_LIVE_DB must be set and not babonline');
}
const ctl = process.env.BAB_LIVE_CTL || '';

const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (p, ...rest) {
    if (p === 3000) return origListen.call(this, port, '127.0.0.1', ...rest.filter((a) => typeof a === 'function'));
    return origListen.call(this, p, ...rest);
};

const { MongoClient } = require(require.resolve('mongodb', { paths: [process.cwd()] }));
const origDb = MongoClient.prototype.db;
MongoClient.prototype.db = function (name, ...rest) {
    return origDb.call(this, name === 'babonline' ? dbName : name, ...rest);
};

const sioDir = path.dirname(path.dirname(require.resolve('socket.io', { paths: [process.cwd()] })));
const eioDir = path.dirname(path.dirname(require.resolve('engine.io', { paths: [sioDir, process.cwd()] })));
const { Socket } = require(path.join(sioDir, 'dist/socket.js'));
const eio = require(path.join(eioDir, 'build/server.js'));
const t = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log('[keeplog]', t(), ...a);

const origHandshake = eio.Server.prototype.handshake;
eio.Server.prototype.handshake = function (transportName, req, ...rest) {
    log('HANDSHAKE', transportName, (req.headers['user-agent'] || '').slice(0, 40));
    return origHandshake.call(this, transportName, req, ...rest);
};
const origConnect = Socket.prototype._onconnect;
Socket.prototype._onconnect = function () {
    log('NSP-CONNECT', this.id);
    return origConnect.call(this);
};
const origClose = Socket.prototype._onclose;
Socket.prototype._onclose = function (reason) {
    log('NSP-CLOSE', this.id, reason);
    return origClose.apply(this, arguments);
};

// event names only (and a requestSnapshot's requestId / log flag): never a payload
const IN = new Set(['restoreSession', 'requestSnapshot', 'rejoinGame', 'joinMainRoom', 'signUp', 'signIn',
    'createLobby', 'playerBid', 'playCard', 'addBot', 'playerReady']);
// BAB_LIVE_RESTORE_DELAY_MS: each restoreSession is handled that much later (a production
// database's latency: the restore's answer is still on its way when the app comes to the front).
// BAB_LIVE_DROP_RESTORES=<n>: the first n restoreSession packets are dropped unanswered (a
// restore lost on its way: the app's connection is up, its session gate stays closed)
const restoreDelay = Number(process.env.BAB_LIVE_RESTORE_DELAY_MS) || 0;
let restoresToDrop = Number(process.env.BAB_LIVE_DROP_RESTORES) || 0;
const origOnevent = Socket.prototype.onevent;
Socket.prototype.onevent = function (packet) {
    const [name, data] = packet.data || [];
    if (IN.has(name)) {
        const extra = name === 'requestSnapshot' ? ` requestId=${data && data.requestId} log=${data && data.log}` : '';
        log('IN ', this.id, name + extra);
    }
    if (restoresToDrop > 0 && name === 'restoreSession') {
        restoresToDrop -= 1;
        log('DROP', this.id, 'restoreSession');
        return undefined;
    }
    if (restoreDelay > 0 && name === 'restoreSession') {
        setTimeout(() => origOnevent.call(this, packet), restoreDelay);
        return undefined;
    }
    return origOnevent.call(this, packet);
};

function writeProbeSnapshot(d) {
    if (!ctl || typeof d.requestId !== 'string' || !d.requestId.startsWith('fg-')) return;
    const s = d.snapshot;
    const out = { requestId: d.requestId, stage: s ? s.stage : null, reason: d.reason || null, hand: (s && s.hand) || [] };
    try {
        fs.writeFileSync(path.join(ctl, 'probe-snapshot.json'), JSON.stringify(out));
    } catch (err) {
        log('probe-snapshot.json not written:', err.message);
    }
}

const OUT = new Set(['stateSnapshot', 'rejoinSuccess', 'restoreSessionResponse', 'signUpResponse', 'gameStart',
    'updateTurn', 'mainRoomJoined']);
const origEmit = Socket.prototype.emit;
Socket.prototype.emit = function (ev, ...args) {
    if (OUT.has(ev)) {
        const d = args[0] || {};
        let extra = '';
        if (ev === 'stateSnapshot') {
            const s = d.snapshot;
            extra = ` requestId=${d.requestId} ` + (s
                ? `stage=${s.stage} seq=${s.seq} viewer=${JSON.stringify(s.viewer)} turn=${JSON.stringify(s.turn ?? null)} hand(${(s.hand || []).length})=${JSON.stringify(s.hand || [])}`
                : `reason=${d.reason}`);
            writeProbeSnapshot(d);
        } else if (ev === 'restoreSessionResponse') {
            extra = ` success=${d.success} activeGameId=${d.activeGameId || ''}`;
        } else if (ev === 'rejoinSuccess') {
            const s = d.snapshot;
            extra = s ? ` stage=${s.stage} seq=${s.seq} hand=${(s.hand || []).length}` : '';
        } else if (ev === 'updateTurn') {
            extra = ` turn=${d.currentTurn}`;
        }
        log('OUT', this.id, ev + extra);
    }
    return origEmit.call(this, ev, ...args);
};
log(`preload ready: port ${port}, db ${dbName}${ctl ? ', probe snapshots to the CTL dir' : ''}`);
