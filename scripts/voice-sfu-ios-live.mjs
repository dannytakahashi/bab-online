#!/usr/bin/env node
/**
 * Live harness for the iOS SFU transport (PR 3; docs/claude/voice.md "SFU voice, iOS"): the
 * host side of the opt-in `LiveSfuVoiceTests` (iOSClient/BABOnlineUITests). It starts a PRIVATE
 * local server with VOICE_SFU=tournament against a REAL Cloudflare Realtime SFU app (the DEV
 * app), seeds `--pages` accounts and signs that many headless Chromium pages (Playwright) into
 * the tournament the iOS app creates (the one whose creator is
 * `--ios-user`). Each page drives the client protocol by hand on one PeerConnection (its
 * microphone a WebAudio tone that beeps once a second), as
 * scripts/voice-sfu-smoke.mjs does: it pushes its microphone at once, pulls every member who
 * publishes (the iPhone included, from its first unmute), closes a pull whose member left or
 * changed session, and answers every SFU offer.
 *
 * A UDP relay on 127.0.0.1 (`--relay-port`, control `--relay-ctl`) carries the iPhone's SFU media
 * when the app runs with `-sfuRelay 127.0.0.1:<relay-port> -sfuRelayCtl <relay-ctl>` (DEBUG,
 * `SfuRelay.swift`): the run can cut it (the simulator's network to the SFU, both ways), bring it
 * back, or move it to a new source port (a NAT rebinding), without touching the Mac's network.
 *
 * The UI test drives it through files in `--ctl <dir>`: `cmd-<n>.json` ({action, ...}) is run
 * and answered with `done-<n>.json`. Actions: `ready` (the pages are in the room and hear each
 * other), `hearIos` (each page's inbound from the iPhone over 3 s: kbps, audio energy, the
 * pull's session), `leavePage {page}` (joinMainRoom, keeping nothing), `returnPage {page}`
 * (returnToTournament: a new session, push, pulls), `relay {mode: cut|restore|rebind}`,
 * `suspendApp` / `resumeApp` (SIGSTOP / SIGCONT of the BAB Online process on `--udid`, as iOS
 * suspends an app), `pagesState`, `stop`; with `--proxy-port` (a TCP proxy in front of the
 * server for the app's socket only: the app's `-serverURL` is the proxy), `socketDrop
 * {seconds}` (the app's connections closed and new ones refused for that long) and `blip
 * {seconds}` (that and the relay cut at the same time: a Wi-Fi drop takes both).
 *
 * Usage (from a #!/bin/bash wrapper that loads the DEV app's id and secret into this process's
 * environment only: set -a; . ~/.bab-secrets/cf-sfu-dev.env; set +a; MONGO_URI a private test
 * mongod, never 27017):
 *
 *   node scripts/voice-sfu-ios-live.mjs --port 38641 --db sfuios_x --pages 2 --ios-user <name> \
 *     --udid <simulator> --ctl <new dir> --relay-port 38642 --relay-ctl 38643
 *
 * Prints no secret, token or SDP. Writes the server's log to <ctl>/server.log.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[sfu-ios-live ${t()}]`, ...a);

function args() {
    const a = process.argv.slice(2);
    const o = { port: 38641, db: `sfuios_${process.pid}`, pages: 2, iosUser: null, udid: null, ctl: null, relayPort: 0, relayCtl: 0, proxyPort: 0 };
    for (let i = 0; i < a.length; i++) {
        const k = a[i];
        const v = a[i + 1];
        if (k === '--port') { o.port = Number(v); i++; }
        else if (k === '--db') { o.db = v; i++; }
        else if (k === '--pages') { o.pages = Number(v); i++; }
        else if (k === '--ios-user') { o.iosUser = v; i++; }
        else if (k === '--udid') { o.udid = v; i++; }
        else if (k === '--ctl') { o.ctl = v; i++; }
        else if (k === '--relay-port') { o.relayPort = Number(v); i++; }
        else if (k === '--relay-ctl') { o.relayCtl = Number(v); i++; }
        else if (k === '--proxy-port') { o.proxyPort = Number(v); i++; }
    }
    if (!(o.port >= 38100 && o.port <= 38899)) throw new Error('--port must be in 38100-38899');
    if (!process.env.MONGO_URI || /:27017\b/.test(process.env.MONGO_URI)) throw new Error('MONGO_URI must name a private test mongod (not 27017)');
    if (!process.env.CF_SFU_APP_ID || !process.env.CF_SFU_APP_SECRET) throw new Error('CF_SFU_APP_ID / CF_SFU_APP_SECRET must be in the environment');
    if (o.db.toLowerCase() === 'babonline') throw new Error('never the database babonline');
    if (!o.iosUser || !o.ctl || !o.udid) throw new Error('--ios-user, --udid and --ctl are required');
    if (!(o.pages >= 1 && o.pages <= 12)) throw new Error('--pages 1..12');
    return o;
}

// ---------------------------------------------------------------- the relay
// One outbound socket per app-side source address (a NAT's mapping): the SFU's answers on a
// mapping go back to the source that opened it, so each of the app's local candidates (and each
// new PeerConnection) is its own 5-tuple at the SFU, as without the relay. `rebind` gives every
// mapping a new outbound port (a NAT rebinding); `cut` drops everything both ways.
function startRelay(port, ctlPort) {
    const state = { mode: 'pass', target: null, maps: new Map(), fromApp: 0, toApp: 0, dropped: 0, rebinds: 0 };
    const front = dgram.createSocket('udp4');
    const mapping = (rinfo) => {
        const key = `${rinfo.address}:${rinfo.port}`;
        let m = state.maps.get(key);
        if (!m) {
            const out = dgram.createSocket('udp4');
            m = { out, app: { address: rinfo.address, port: rinfo.port } };
            out.on('message', (msg) => {
                if (state.mode === 'cut') { state.dropped++; return; }
                state.toApp++;
                front.send(msg, m.app.port, m.app.address);
            });
            out.on('error', () => {});
            out.bind(0, '0.0.0.0');
            state.maps.set(key, m);
        }
        return m;
    };
    front.on('message', (msg, rinfo) => {
        if (state.mode === 'cut' || !state.target) { state.dropped++; return; }
        state.fromApp++;
        mapping(rinfo).out.send(msg, state.target.port, state.target.address);
    });
    front.bind(port, '127.0.0.1');
    const ctl = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(body.trim());
            if (req.url === '/target' && m) {
                if (state.target?.address !== m[1] || state.target?.port !== Number(m[2])) log(`relay: SFU target ${m[1]}:${m[2]}`);
                state.target = { address: m[1], port: Number(m[2]) };
            }
            res.end('ok');
        });
    });
    ctl.listen(ctlPort, '127.0.0.1');
    return {
        state,
        set(mode) {
            if (mode === 'rebind') {
                for (const m of state.maps.values()) m.out.close();
                state.maps.clear();
                state.rebinds++;
                state.mode = 'pass';
                return;
            }
            state.mode = mode === 'cut' ? 'cut' : 'pass';
        },
        close() { front.close(); for (const m of state.maps.values()) m.out.close(); ctl.close(); },
    };
}

// ---------------------------------------------------------------- the app's socket proxy
// A plain TCP pipe (Socket.IO's HTTP polling and WebSocket pass through unchanged) in front of
// the server for the app only; `drop(ms)` closes every connection and refuses new ones for that
// long (the app's socket goes down, Socket.IO-Client-Swift reconnects once it may).
function startProxy(port, target) {
    const state = { refuseUntil: 0, open: new Set(), accepted: 0, refused: 0, drops: 0 };
    const front = net.createServer((c) => {
        if (Date.now() < state.refuseUntil) { state.refused++; c.destroy(); return; }
        state.accepted++;
        const up = net.connect(target, '127.0.0.1');
        const pair = { c, up };
        state.open.add(pair);
        const close = () => { c.destroy(); up.destroy(); state.open.delete(pair); };
        c.on('error', close); up.on('error', close); c.on('close', close); up.on('close', close);
        c.pipe(up); up.pipe(c);
    });
    front.listen(port, '127.0.0.1');
    return {
        state,
        drop(ms) {
            state.drops++;
            state.refuseUntil = Date.now() + ms;
            for (const p of state.open) { p.c.destroy(); p.up.destroy(); }
            state.open.clear();
        },
        close() { for (const p of state.open) { p.c.destroy(); p.up.destroy(); } front.close(); },
    };
}

// ---------------------------------------------------------------- the server
function startServer({ port, db, logFile }) {
    const env = { ...process.env, BAB_LIVE_PORT: String(port), BAB_LIVE_DB: db, DB_NAME: db, VOICE_SFU: 'tournament', LOG_LEVEL: 'debug', NODE_ENV: 'development' };
    delete env.PORT;
    const child = spawn(process.execPath, ['-r', './scripts/ios-live-resume-preload.js', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(logFile);
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    return { child, out };
}

async function waitReady(base, child) {
    for (let i = 0; i < 240; i++) {
        if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})`);
        try { if ((await fetch(`${base}/ready`)).ok) return; } catch { /* not yet */ }
        await sleep(250);
    }
    throw new Error('server never became ready');
}

async function seedUsers(db, n, runId) {
    const { MongoClient } = require('mongodb');
    const bcrypt = require('bcryptjs');
    const { issueSession } = require(path.join(ROOT, 'server/utils/sessionTokens.js'));
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        const users = client.db(db).collection('users');
        const out = [];
        for (let i = 0; i < n; i++) {
            const username = `pg${runId}${'abcdefghijkl'[i]}`;
            const session = issueSession(null);
            await users.insertOne({
                username,
                password: bcrypt.hashSync(randomBytes(12).toString('hex'), 4),
                sessionTokens: session.update.$set.sessionTokens,
                profilePic: 1 + i, tutorial: 'done',
                stats: { wins: 0, losses: 0, gamesPlayed: 0, totalPoints: 0, totalTricksBid: 0, totalTricksTaken: 0 },
            });
            out.push({ username, token: session.token });
        }
        return out;
    } finally { await client.close(); }
}

async function dropDb(db) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try { await client.db(db).dropDatabase(); } finally { await client.close(); }
}

// ---------------------------------------------------------------- the in-page client
function pageClient() {
    const S = window.S = { replies: new Map(), roster: null, members: new Map(), pc: null, sessionId: null, token: null, localMid: null,
        pulls: new Map(), midOwner: {}, n: 0, busy: false, retries: {}, log: [], status: null, enabled: false, refused: {} };
    const note = (s) => { S.log.push(`${Date.now()} ${s}`); if (S.log.length > 200) S.log.shift(); };
    window.ask = (event, data = {}) => new Promise((resolve) => {
        const requestId = `pg-${++S.n}`;
        const tm = setTimeout(() => { S.replies.delete(requestId); resolve({ ok: false, error: { code: 'client_timeout' } }); }, 12000);
        S.replies.set(requestId, (d) => { clearTimeout(tm); resolve(d); });
        S.socket.emit(event, { requestId, ...data });
    });
    window.signIn = async ({ username, token, caps }) => {
        await new Promise((resolve, reject) => {
            const sc = document.createElement('script');
            sc.src = '/socket.io/socket.io.js';
            sc.onload = resolve; sc.onerror = () => reject(new Error('socket.io client did not load'));
            document.head.appendChild(sc);
        });
        const socket = S.socket = window.io({ transports: ['websocket'] });
        socket.on('sfuReply', (d) => { const w = S.replies.get(d.requestId); if (w) { S.replies.delete(d.requestId); w(d); } });
        socket.on('sfuRoster', (d) => {
            S.roster = d; S.status = d.status; S.members = new Map(d.members.map((m) => [m.username, m]));
            S.refused = {};
            note(`roster ${d.status} ${d.members.length}`);
        });
        socket.on('sfuMember', (d) => {
            if (d.event === 'left') S.members.delete(d.member.username); else S.members.set(d.member.username, d.member);
            S.refused = {};
            note(`member ${d.event} ${d.member.username} ${d.member.sessionId ? 'session' : 'none'} ${d.member.trackName || '-'}`);
        });
        await new Promise((r) => socket.once('connect', r));
        socket.emit('clientHello', { client: 'web', version: 'sfu-ios-live', caps });
        const res = await new Promise((r) => { socket.once('restoreSessionResponse', r); socket.emit('restoreSession', { username, sessionToken: token }); });
        if (!res.success) throw new Error('restoreSession failed');
        return true;
    };
    const newPc = () => {
        if (S.pc) S.pc.close();
        S.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
        S.pc.ontrack = (e) => {
            const el = document.createElement('audio');
            el.autoplay = true;
            el.srcObject = new MediaStream([e.track]);
            document.body.appendChild(el);
            el.play().catch(() => {});
        };
        S.localMid = null;
        S.pulls = new Map();
        S.midOwner = {};
    };
    const session = async () => {
        const r = await window.ask('sfuSession');
        if (!r.ok) return r;
        S.sessionId = r.sessionId; S.token = r.sessionToken;
        newPc();
        // a tone that beeps (on 0.4 s, off 0.6 s) from WebAudio: Chromium's fake capture device
        // went silent for some of 6 pages in one browser (their pushed track never reached the SFU)
        if (!S.tone) {
            const ac = new AudioContext();
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            const dst = ac.createMediaStreamDestination();
            osc.frequency.value = 440 + 60 * Math.random();
            osc.connect(gain).connect(dst);
            osc.start();
            setInterval(() => { gain.gain.setValueAtTime(0.3, ac.currentTime); gain.gain.setValueAtTime(0, ac.currentTime + 0.4); }, 1000);
            await ac.resume();
            S.tone = dst.stream.getAudioTracks()[0];
        }
        const tx = S.pc.addTransceiver(S.tone, { direction: 'sendonly' });
        await S.pc.setLocalDescription(await S.pc.createOffer());
        const p = await window.ask('sfuPush', { sessionId: S.sessionId, offer: { type: 'offer', sdp: S.pc.localDescription.sdp }, mid: tx.mid, trackName: 'mic' });
        if (!p.ok) return p;
        await S.pc.setRemoteDescription(p.answer);
        S.localMid = tx.mid;
        note('session + push');
        return { ok: true };
    };
    // keep my pulls current with the members (the protocol's steps 5 and 6, simplified)
    const tick = async () => {
        if (S.busy || !S.enabled || S.status !== 'admitted') return;
        S.busy = true;
        try {
            // a page whose session never connected (or failed) starts over: the pages are the
            // harness, not what is measured
            if (S.sessionId && S.pc && (S.pc.connectionState === 'failed' || (S.pc.connectionState !== 'connected' && Date.now() - S.sessionAt > 15000))) {
                note(`session ${S.pc.connectionState}: a new one`);
                await window.ask('sfuLeave', { sessionId: S.sessionId });
                S.pc.close(); S.pc = null; S.sessionId = null;
            }
            if (!S.sessionId) { const r = await session(); if (!r.ok) { note(`session failed ${r.error?.code}`); return; } S.sessionAt = Date.now(); }
            const close = [];
            for (const [user, p] of S.pulls) {
                const m = S.members.get(user);
                if (m?.state === 'reconnecting') continue;
                if (!m || !m.sessionId || !m.trackName || m.sessionId !== p.sessionId || m.trackName !== p.trackName) close.push(user);
            }
            if (close.length) {
                const mids = close.map((u) => S.pulls.get(u).mid);
                for (const u of close) S.pulls.delete(u);
                for (const tr of S.pc.getTransceivers()) if (mids.includes(tr.mid)) tr.stop();
                await S.pc.setLocalDescription(await S.pc.createOffer());
                const r = await window.ask('sfuClose', { sessionId: S.sessionId, mids, offer: { type: 'offer', sdp: S.pc.localDescription.sdp } });
                if (r.ok && r.answer) await S.pc.setRemoteDescription(r.answer);
                else { await S.pc.setLocalDescription({ type: 'rollback' }).catch(() => {}); await window.ask('sfuClose', { sessionId: S.sessionId, mids, force: true }); }
                note(`closed ${close.join(',')}`);
            }
            const want = [...S.members.values()].filter((m) => m.sessionId && m.trackName && !S.pulls.has(m.username)
                && S.refused[m.username] !== `${m.sessionId}/${m.trackName}`);
            if (want.length) {
                const r = await window.ask('sfuPull', { sessionId: S.sessionId, tracks: want.map((m) => ({ sessionId: m.sessionId, trackName: m.trackName })) });
                if (!r.ok) {
                    note(`pull failed ${r.error?.code}`);
                    if (r.error?.code === 'session_gone' || r.error?.code === 'not_your_session') { S.sessionId = null; }
                    return;
                }
                const opened = [];
                for (const tr of r.tracks) {
                    const m = want.find((x) => x.sessionId === tr.sessionId && x.trackName === tr.trackName);
                    if (!m) continue;
                    if (tr.mid && !tr.errorCode) { opened.push([m, tr.mid]); S.midOwner[tr.mid] = m.username; }
                    else if (!['empty_track_error', 'not_found_track_error'].includes(tr.errorCode)) S.refused[m.username] = `${m.sessionId}/${m.trackName}`;
                }
                if (r.offer) {
                    await S.pc.setRemoteDescription(r.offer);
                    await S.pc.setLocalDescription(await S.pc.createAnswer());
                    await window.ask('sfuRenegotiate', { sessionId: S.sessionId, answer: { type: 'answer', sdp: S.pc.localDescription.sdp } });
                }
                for (const [m, mid] of opened) S.pulls.set(m.username, { sessionId: m.sessionId, trackName: m.trackName, mid });
                if (opened.length) note(`pulled ${opened.map(([m]) => m.username).join(',')}`);
            }
        } catch (e) {
            note(`tick error ${e.message}`);
        } finally {
            S.busy = false;
        }
    };
    setInterval(tick, 500);
    window.leaveRoom = async () => {
        S.enabled = false;
        if (S.sessionId) await window.ask('sfuLeave', { sessionId: S.sessionId });
        S.pc?.close(); S.pc = null; S.sessionId = null; S.pulls = new Map();
        await new Promise((r) => { S.socket.once('mainRoomJoined', r); S.socket.emit('joinMainRoom'); });
    };
    window.returnRoom = async () => {
        await new Promise((r) => { S.socket.once('tournamentJoined', r); S.socket.emit('returnToTournament'); });
        S.enabled = true;
    };
    window.inbound = async () => {
        const out = {};
        if (!S.pc) return out;
        const stats = await S.pc.getStats();
        stats.forEach((s) => {
            if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
            const who = S.midOwner[s.mid];
            if (!who) return;
            const prev = out[who];
            if (prev && prev.bytes >= s.bytesReceived) return;
            out[who] = { bytes: s.bytesReceived, energy: s.totalAudioEnergy ?? 0, packets: s.packetsReceived, lost: s.packetsLost ?? 0, sessionId: S.pulls.get(who)?.sessionId ?? null };
        });
        return out;
    };
    window.info = () => ({ status: S.status, sessionId: S.sessionId ? S.sessionId.slice(0, 8) : null, pc: S.pc?.connectionState ?? null,
        pulls: [...S.pulls.keys()], members: [...S.members.values()].map((m) => `${m.username}:${m.sessionId ? m.sessionId.slice(0, 8) : '-'}:${m.trackName || '-'}:${m.state}`),
        log: S.log.slice(-12) });
}

// ---------------------------------------------------------------- the run
async function main() {
    const o = args();
    fs.mkdirSync(o.ctl, { recursive: true });
    const { chromium } = require('playwright');
    const base = `http://127.0.0.1:${o.port}`;
    const relay = o.relayPort ? startRelay(o.relayPort, o.relayCtl) : null;
    const proxy = o.proxyPort ? startProxy(o.proxyPort, o.port) : null;
    let suspended = null;
    const server = startServer({ port: o.port, db: o.db, logFile: path.join(o.ctl, 'server.log') });
    const onSignal = () => {
        try { if (suspended) process.kill(suspended, 'SIGCONT'); } catch { /* gone */ }
        server.child.kill('SIGTERM');
        relay?.close();
        proxy?.close();
        process.exit(1);
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    let browser = null;
    const appPid = () => {
        try {
            const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
            const line = out.split('\n').find((l) => l.includes(`Devices/${o.udid}/`) && /BAB Online\.app\/BAB Online(\s|$)/.test(l));
            return line ? Number(line.trim().split(/\s+/)[0]) : null;
        } catch { return null; }
    };
    try {
        await waitReady(base, server.child);
        log(`server up on ${o.port}`);
        const runId = randomBytes(2).toString('hex');
        const accounts = await seedUsers(o.db, o.pages, runId);
        browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
        const caps = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentVoiceStatus', 'cutForABuck', 'sfuVoice'];
        const pages = [];
        for (const acct of accounts) {
            const ctx = await browser.newContext({ permissions: ['microphone'], bypassCSP: true });
            const page = await ctx.newPage();
            page.on('pageerror', (e) => log(`[page ${acct.username}] ${e.message}`));
            await page.goto(`${base}/health`);
            await page.evaluate(pageClient);
            await page.evaluate((a) => window.signIn(a), { ...acct, caps });
            pages.push({ page, username: acct.username });
        }
        fs.writeFileSync(path.join(o.ctl, 'pages.json'), JSON.stringify(pages.map((p) => p.username)));
        log(`pages signed in: ${pages.map((p) => p.username).join(', ')}; waiting for ${o.iosUser}'s tournament`);

        // the iPhone creates the tournament: every page joins it
        let tid = null;
        for (let i = 0; i < 300 && !tid; i++) {
            // joinMainRoom answers with the tournament list (rate-limited: every 3 s, 4 s wait)
            tid = await pages[0].page.evaluate((creator) => new Promise((r) => {
                const tm = setTimeout(() => r(null), 4000);
                window.S.socket.once('mainRoomJoined', (d) => { clearTimeout(tm); r((d.tournaments || []).find((x) => x.creatorUsername === creator && x.phase === 'lobby')?.id ?? null); });
                window.S.socket.emit('joinMainRoom');
            }), o.iosUser);
            if (!tid) await sleep(3000);
            if (fs.existsSync(path.join(o.ctl, 'stop'))) throw new Error('stopped before the tournament');
        }
        if (!tid) throw new Error('no tournament from the iPhone');
        log(`tournament ${tid}`);
        for (const p of pages) {
            await p.page.evaluate((id) => new Promise((r) => { window.S.socket.once('tournamentJoined', () => r()); window.S.socket.emit('joinTournament', { tournamentId: id }); }), tid);
            await p.page.evaluate(() => { window.S.enabled = true; });
        }
        fs.writeFileSync(path.join(o.ctl, 'joined'), tid);

        const inbound = () => Promise.all(pages.map((p) => p.page.evaluate(() => window.inbound())));
        const heard = async (who, ms = 3000) => {
            const a = await inbound();
            await sleep(ms);
            const b = await inbound();
            return pages.map((p, i) => {
                const x = b[i][who]; const y = a[i][who];
                return { page: p.username, kbps: x ? Math.round(((x.bytes - (y?.bytes ?? 0)) * 8) / ms) : 0, energyUp: !!x && x.energy > (y?.energy ?? 0),
                    energyDelta: x ? Number((x.energy - (y?.energy ?? 0)).toExponential(2)) : 0,
                    packets: x ? x.packets - (y?.packets ?? 0) : 0, lost: x?.lost ?? null, session: x?.sessionId ? x.sessionId.slice(0, 8) : null };
            });
        };
        const actions = {
            async ready() {
                for (let i = 0; i < 80; i++) {
                    const infos = await Promise.all(pages.map((p) => p.page.evaluate(() => window.info())));
                    const others = pages.length - 1;
                    if (infos.every((x) => x.status === 'admitted' && x.pulls.filter((u) => u !== o.iosUser).length >= others)) break;
                    await sleep(500);
                }
                const s = await inbound();
                return { pages: pages.map((p, i) => ({ page: p.username, pulls: Object.keys(s[i]) })) };
            },
            async hearIos({ ms = 3000 } = {}) { return { heard: await heard(o.iosUser, ms) }; },
            async pagesState() { return { pages: await Promise.all(pages.map(async (p) => ({ page: p.username, ...(await p.page.evaluate(() => window.info())) }))) }; },
            async leavePage({ page }) { await pages[page].page.evaluate(() => window.leaveRoom()); return { left: pages[page].username }; },
            async returnPage({ page }) { await pages[page].page.evaluate(() => window.returnRoom()); return { back: pages[page].username }; },
            async relay({ mode }) { if (!relay) return { error: 'no relay' }; relay.set(mode); return { mode, mappings: relay.state.maps.size }; },
            async relayState() { return relay ? { mode: relay.state.mode, target: relay.state.target, mappings: relay.state.maps.size, fromApp: relay.state.fromApp, toApp: relay.state.toApp, dropped: relay.state.dropped, rebinds: relay.state.rebinds } : { error: 'no relay' }; },
            async socketDrop({ seconds }) {
                if (!proxy) return { error: 'no proxy' };
                proxy.drop(seconds * 1000);
                await sleep(seconds * 1000);
                return { seconds, refused: proxy.state.refused, accepted: proxy.state.accepted };
            },
            async blip({ seconds }) {
                if (!proxy || !relay) return { error: 'needs the proxy and the relay' };
                relay.set('cut');
                proxy.drop(seconds * 1000);
                await sleep(seconds * 1000);
                relay.set('restore');
                return { seconds, refused: proxy.state.refused, accepted: proxy.state.accepted, dropped: relay.state.dropped };
            },
            async suspendApp() { const pid = appPid(); if (pid) { process.kill(pid, 'SIGSTOP'); suspended = pid; } return { pid }; },
            async resumeApp() { const pid = appPid() ?? suspended; if (pid) process.kill(pid, 'SIGCONT'); suspended = null; return { pid }; },
        };
        log('ready for commands');
        const seen = new Set();
        for (;;) {
            if (fs.existsSync(path.join(o.ctl, 'stop'))) break;
            for (const f of fs.readdirSync(o.ctl).filter((x) => /^cmd-\d+\.json$/.test(x)).sort()) {
                if (seen.has(f)) continue;
                seen.add(f);
                const n = f.slice(4, -5);
                let cmd;
                try { cmd = JSON.parse(fs.readFileSync(path.join(o.ctl, f), 'utf8')); } catch { seen.delete(f); continue; }
                const t0 = Date.now();
                let out;
                try {
                    if (cmd.action === 'stop') { fs.writeFileSync(path.join(o.ctl, 'stop'), ''); out = { stopping: true }; }
                    else if (actions[cmd.action]) out = await actions[cmd.action](cmd);
                    else out = { error: `unknown action ${cmd.action}` };
                } catch (e) { out = { error: e.message }; }
                const result = { action: cmd.action, at: new Date().toISOString(), ms: Date.now() - t0, ...out };
                log(`${cmd.action}: ${JSON.stringify(result).slice(0, 400)}`);
                fs.writeFileSync(path.join(o.ctl, `done-${n}.json`), JSON.stringify(result, null, 2));
            }
            await sleep(200);
        }
        for (const p of pages) await p.page.evaluate(() => window.leaveRoom()).catch(() => {});
    } finally {
        // never leave the app stopped
        if (suspended) { try { process.kill(suspended, 'SIGCONT'); } catch { /* gone */ } }
        if (browser) await browser.close().catch(() => {});
        server.child.kill('SIGTERM');
        for (let i = 0; i < 40 && server.child.exitCode === null; i++) await sleep(100);
        if (server.child.exitCode === null) server.child.kill('SIGKILL');
        server.out.end();
        relay?.close();
        proxy?.close();
        await dropDb(o.db).catch(() => {});
        log('done');
    }
}

main().catch((e) => { console.error(e.message); process.exit(2); });
