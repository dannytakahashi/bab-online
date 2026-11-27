#!/usr/bin/env node
/**
 * Cloudflare SFU voice: a live smoke run of the server side (docs/claude/voice.md,
 * "SFU voice (server)"). Starts a PRIVATE local server with VOICE_SFU=tournament
 * against a REAL Cloudflare Realtime SFU app, signs three headless Chromium pages
 * (Playwright, fake microphone: Chromium's beep) into one tournament lobby, and
 * drives the client protocol by hand in each page (one RTCPeerConnection per page,
 * the server-relayed sfu* requests; this is not the web transport, which is PR 2):
 *
 *   1. a pushes on its first "unmute" (session + push)
 *   2. b makes a pull-only session and pulls a; c pulls a
 *   3. b pushes on its connected session; c and a pull b
 *   4. getStats: every page hears every publisher (inbound bytes and audio
 *      energy growing on each pulled mid)
 *   5. an ICE restart on a's session (the spike's tracks/new form), still heard
 *   6. the SDP's size as c pulls a's track again and again (bytes per m-section)
 *   7. a forced 410: b closes its PeerConnection; after Cloudflare's window
 *      (~35 s) a call on b's session must answer session_gone and the room hears
 *      b's session end (sfuMember session null); then b recovers with a new
 *      session, pushes, and c hears it again
 *
 * Usage (MONGO_URI a private test mongod, never 27017; the Cloudflare DEV app's
 * id and secret in the environment, never on the command line):
 *
 *   set -a; . ~/.bab-secrets/cf-sfu-dev.env; set +a
 *   MONGO_URI=mongodb://127.0.0.1:<port> node scripts/voice-sfu-smoke.mjs --port 38871 --json out.json
 *
 * Options: --port <n> (38100-38899, never 3000), --db <name> (default sfusmoke_<pid>,
 * dropped at the end), --json <file>, --log <file> (the server's log), --skip-410.
 * Exit 0 only when every check passes. Prints no secret, token or SDP.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args() {
    const a = process.argv.slice(2);
    const o = { port: 38871, db: `sfusmoke_${process.pid}`, json: null, log: null, skip410: false };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--port') o.port = Number(a[++i]);
        else if (a[i] === '--db') o.db = a[++i];
        else if (a[i] === '--json') o.json = a[++i];
        else if (a[i] === '--log') o.log = a[++i];
        else if (a[i] === '--skip-410') o.skip410 = true;
    }
    if (!(o.port >= 38100 && o.port <= 38899)) throw new Error('--port must be in 38100-38899');
    if (!process.env.MONGO_URI || /:27017\b/.test(process.env.MONGO_URI)) throw new Error('MONGO_URI must name a private test mongod (not 27017)');
    if (!process.env.CF_SFU_APP_ID || !process.env.CF_SFU_APP_SECRET) throw new Error('CF_SFU_APP_ID / CF_SFU_APP_SECRET must be in the environment');
    if (o.db.toLowerCase() === 'babonline') throw new Error('never the database babonline');
    return o;
}

function startServer({ port, db, logFile }) {
    const env = { ...process.env, BAB_LIVE_PORT: String(port), BAB_LIVE_DB: db, DB_NAME: db, VOICE_SFU: 'tournament', LOG_LEVEL: 'debug', NODE_ENV: 'development' };
    delete env.PORT;
    const child = spawn(process.execPath, ['-r', './scripts/ios-live-resume-preload.js', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    const out = logFile ? fs.createWriteStream(logFile) : null;
    const onData = (buf) => {
        const s = buf.toString();
        if (out) out.write(s);
        for (const raw of s.split('\n')) if (/Voice SFU/.test(raw)) lines.push(raw.replace(/\x1b\[[0-9;]*m/g, ''));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    return { child, lines, out };
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
            const username = `sfu${runId}_${'abc'[i]}`;
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
// One RTCPeerConnection per page, the protocol of docs/claude/voice.md by hand.
function pageClient() {
    const S = window.S = { replies: new Map(), rosters: [], members: [], pc: null, sessionId: null, token: null, localMid: null, pulls: {}, sdp: [], n: 0, errors: [] };
    const wait = (pred, ms, what) => new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => { if (pred()) return resolve(Date.now() - t0); if (Date.now() - t0 > ms) return reject(new Error(`timeout: ${what}`)); setTimeout(tick, 50); };
        tick();
    });
    window.ask = (event, data = {}) => new Promise((resolve, reject) => {
        const requestId = `smoke-${++S.n}`;
        const t = setTimeout(() => { S.replies.delete(requestId); reject(new Error(`no sfuReply to ${event}`)); }, 20000);
        S.replies.set(requestId, (d) => { clearTimeout(t); resolve(d); });
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
        socket.on('sfuRoster', (d) => S.rosters.push(d));
        socket.on('sfuMember', (d) => S.members.push(d));
        await new Promise((r) => socket.once('connect', r));
        socket.emit('clientHello', { client: 'web', version: 'sfu-smoke', caps });
        const res = await new Promise((r) => { socket.once('restoreSessionResponse', r); socket.emit('restoreSession', { username, sessionToken: token }); });
        if (!res.success) throw new Error('restoreSession failed');
        return true;
    };
    window.newPc = () => {
        if (S.pc) S.pc.close();
        S.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
        // Play every pulled track (Chromium decodes and counts audio energy only for a track that plays out)
        S.pc.ontrack = (e) => {
            const el = document.createElement('audio');
            el.autoplay = true;
            el.srcObject = new MediaStream([e.track]);
            document.body.appendChild(el);
            el.play().catch(() => {});
        };
        S.localMid = null;
        S.pulls = {};
    };
    window.newSession = async () => {
        const r = await window.ask('sfuSession');
        if (!r.ok) return r;
        S.sessionId = r.sessionId; S.token = r.sessionToken;
        window.newPc();
        return { ok: true };
    };
    const connected = () => wait(() => S.pc.connectionState === 'connected', 10000, 'connected');
    window.push = async () => {
        const t0 = performance.now();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const tx = S.pc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendonly' });
        await S.pc.setLocalDescription(await S.pc.createOffer());
        const r = await window.ask('sfuPush', { sessionId: S.sessionId, offer: { type: 'offer', sdp: S.pc.localDescription.sdp }, mid: tx.mid, trackName: 'mic' });
        if (!r.ok) return r;
        await S.pc.setRemoteDescription(r.answer);
        S.localMid = tx.mid;
        await connected();
        return { ok: true, ms: Math.round(performance.now() - t0), trackErrors: r.tracks.filter((x) => x.errorCode).length };
    };
    window.pull = async (who) => {
        const t0 = performance.now();
        const roster = S.rosters.at(-1);
        const latest = new Map(roster.members.map((m) => [m.username, m]));
        for (const d of S.members) if (d.rev > roster.rev || true) latest.set(d.member.username, d.member);
        const m = latest.get(who);
        if (!m?.sessionId || !m?.trackName) return { ok: false, why: `no published track for ${who}` };
        for (let attempt = 0; attempt < 10; attempt++) {
            const r = await window.ask('sfuPull', { sessionId: S.sessionId, tracks: [{ sessionId: m.sessionId, trackName: m.trackName }] });
            if (!r.ok) return r;
            if (r.offer) {
                await S.pc.setRemoteDescription(r.offer);
                await S.pc.setLocalDescription(await S.pc.createAnswer());
                const rr = await window.ask('sfuRenegotiate', { sessionId: S.sessionId, answer: { type: 'answer', sdp: S.pc.localDescription.sdp } });
                if (!rr.ok) return rr;
                S.sdp.push({ mSections: (r.offer.sdp.match(/^m=/gm) || []).length, offerBytes: r.offer.sdp.length, answerBytes: S.pc.localDescription.sdp.length });
            }
            const tr = r.tracks[0];
            if (tr.mid && !tr.errorCode) {
                S.pulls[tr.mid] = who;
                if (S.pc.connectionState !== 'connected') await connected();
                return { ok: true, mid: tr.mid, attempts: attempt + 1, ms: Math.round(performance.now() - t0) };
            }
            if (!['empty_track_error', 'not_found_track_error'].includes(tr.errorCode)) return { ok: false, errorCode: tr.errorCode };
            await new Promise((res) => setTimeout(res, 1000));
        }
        return { ok: false, why: 'pull retries exhausted' };
    };
    window.inbound = async () => {
        const out = {};
        const stats = await S.pc.getStats();
        stats.forEach((s) => {
            if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
            const prev = out[s.mid];
            if (prev && prev.bytes >= s.bytesReceived) return; // Chrome's tiny extra stream on a reused mid
            out[s.mid] = { who: S.pulls[s.mid] ?? null, bytes: s.bytesReceived, energy: s.totalAudioEnergy ?? 0, samples: s.totalSamplesReceived ?? 0, lost: s.packetsLost ?? 0 };
        });
        return out;
    };
    window.iceRestart = async () => {
        const t0 = performance.now();
        S.pc.restartIce();
        await S.pc.setLocalDescription(await S.pc.createOffer({ iceRestart: true }));
        const r = await window.ask('sfuIceRestart', { sessionId: S.sessionId, offer: { type: 'offer', sdp: S.pc.localDescription.sdp } });
        if (!r.ok) { await S.pc.setLocalDescription({ type: 'rollback' }).catch(() => {}); return r; }
        await S.pc.setRemoteDescription(r.answer);
        await connected();
        return { ok: true, ms: Math.round(performance.now() - t0) };
    };
}

// ---------------------------------------------------------------- the run
async function main() {
    const o = args();
    const { chromium } = require('playwright');
    const base = `http://127.0.0.1:${o.port}`;
    const report = { startedAt: new Date().toISOString(), checks: [], steps: {} };
    const check = (name, ok, detail = null) => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`); };
    const server = startServer({ port: o.port, db: o.db, logFile: o.log });
    let browser = null;
    try {
        await waitReady(base, server.child);
        const runId = randomBytes(3).toString('hex');
        const accounts = await seedUsers(o.db, 3, runId);
        browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
        const caps = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentVoiceStatus', 'cutForABuck', 'sfuVoice'];
        const pages = [];
        for (const acct of accounts) {
            const ctx = await browser.newContext({ permissions: ['microphone'], bypassCSP: true });
            const page = await ctx.newPage();
            page.on('pageerror', (e) => console.warn(`[page ${acct.username}] ${e.message}`));
            await page.goto(`${base}/health`);
            await page.evaluate(pageClient);
            await page.evaluate((a) => window.signIn(a), { ...acct, caps });
            pages.push(page);
        }
        const [a, b, c] = pages;
        const names = accounts.map((x) => x.username);
        const tid = await a.evaluate(() => new Promise((r) => { window.S.socket.once('tournamentCreated', (d) => r(d.tournamentId)); window.S.socket.emit('createTournament'); }));
        for (const p of [b, c]) await p.evaluate((id) => new Promise((r) => { window.S.socket.once('tournamentJoined', () => r()); window.S.socket.emit('joinTournament', { tournamentId: id }); }), tid);
        await sleep(300);
        const rosters = await Promise.all(pages.map((p) => p.evaluate(() => window.S.rosters.at(-1))));
        check('every page admitted to the SFU room (sfuRoster admitted, one bootId)', rosters.every((r) => r?.status === 'admitted') && new Set(rosters.map((r) => r.bootId)).size === 1, { cap: rosters[0]?.cap, members: rosters.map((r) => r?.members.length) });

        // 1. a: first unmute -> session + push
        report.steps.aSession = await a.evaluate(() => window.newSession());
        report.steps.aPush = await a.evaluate(() => window.push());
        check('a: session + push, connected', report.steps.aPush.ok, report.steps.aPush);
        await sleep(300);
        const heardPublished = await b.evaluate((n) => window.S.members.some((m) => m.event === 'published' && m.member.username === n), names[0]);
        check('b heard sfuMember published for a', heardPublished);

        // 2. b pull-only session pulls a; c pulls a
        report.steps.bSession = await b.evaluate(() => window.newSession());
        report.steps.bPullA = await b.evaluate((n) => window.pull(n), names[0]);
        check('b (pull-only session): pull a, connected', report.steps.bPullA.ok, report.steps.bPullA);
        report.steps.cSession = await c.evaluate(() => window.newSession());
        report.steps.cPullA = await c.evaluate((n) => window.pull(n), names[0]);
        check('c: pull a', report.steps.cPullA.ok, report.steps.cPullA);

        // 3. b pushes on its connected session; c and a pull b
        report.steps.bPush = await b.evaluate(() => window.push());
        check('b: push on a connected pull-only session', report.steps.bPush.ok, report.steps.bPush);
        await sleep(300);
        report.steps.cPullB = await c.evaluate((n) => window.pull(n), names[1]);
        report.steps.aPullB = await a.evaluate((n) => window.pull(n), names[1]);
        check('c and a pull b', report.steps.cPullB.ok && report.steps.aPullB.ok, { c: report.steps.cPullB, a: report.steps.aPullB });

        // 4. everyone hears every publisher
        const hear = async () => {
            const s1 = await Promise.all(pages.map((p) => p.evaluate(() => window.inbound())));
            await sleep(2000);
            const s2 = await Promise.all(pages.map((p) => p.evaluate(() => window.inbound())));
            return s2.map((st, i) => Object.fromEntries(Object.entries(st).filter(([, v]) => v.who).map(([mid, v]) => [v.who, { kbps: Math.round(((v.bytes - (s1[i][mid]?.bytes ?? 0)) * 8) / 2000), energyUp: v.energy > (s1[i][mid]?.energy ?? 0), samplesUp: v.samples > (s1[i][mid]?.samples ?? 0), lost: v.lost }])));
        };
        await sleep(2000);
        report.steps.hearing = await hear();
        const hears = (i, who) => (report.steps.hearing[i][who]?.kbps ?? 0) > 5 && report.steps.hearing[i][who]?.energyUp;
        check('a hears b, b hears a, c hears a and b (getStats bytes + audio energy)', hears(0, names[1]) && hears(1, names[0]) && hears(2, names[0]) && hears(2, names[1]), report.steps.hearing);

        // 5. ICE restart on a's session
        report.steps.aIceRestart = await a.evaluate(() => window.iceRestart());
        await sleep(1500);
        report.steps.hearingAfterRestart = await hear();
        check('ICE restart on a (tracks/new re-declaring its track): ok, b and c still hear a', report.steps.aIceRestart.ok && (report.steps.hearingAfterRestart[1][names[0]]?.kbps ?? 0) > 5 && (report.steps.hearingAfterRestart[2][names[0]]?.kbps ?? 0) > 5, report.steps.aIceRestart);

        // 6. SDP growth: c pulls a's track again and again
        const growth = [];
        for (let i = 0; i < 12; i++) {
            const r = await c.evaluate((n) => window.pull(n), names[0]);
            growth.push(r.ok ? 'ok' : (r.errorCode || r.why || r.error?.code));
            if (!r.ok) break;
        }
        report.steps.sdpGrowth = { results: growth, sizes: await c.evaluate(() => window.S.sdp) };
        const sizes = report.steps.sdpGrowth.sizes;
        if (sizes.length >= 2) {
            const f = sizes[0];
            const l = sizes.at(-1);
            report.steps.sdpGrowth.bytesPerMSection = { offer: Math.round((l.offerBytes - f.offerBytes) / (l.mSections - f.mSections)), answer: Math.round((l.answerBytes - f.answerBytes) / (l.mSections - f.mSections)) };
        }
        check('SDP size measured per m-section', sizes.length >= 2, report.steps.sdpGrowth.bytesPerMSection);

        // 7. forced 410
        if (!o.skip410) {
            const bSession = await b.evaluate(() => window.S.sessionId);
            await b.evaluate(() => window.S.pc.close());
            const closedAt = Date.now();
            console.log('b closed its PeerConnection; waiting 40 s for Cloudflare to drop the session');
            await sleep(40000);
            const t0 = Date.now();
            const r = await b.evaluate((sid) => window.ask('sfuRenegotiate', { sessionId: sid, answer: { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' } }), bSession);
            report.steps.forced410 = { reply: { ok: r.ok, code: r.error?.code, status: r.error?.status, cfCode: r.error?.cfCode }, callMs: Date.now() - t0, sinceCloseMs: Date.now() - closedAt };
            await sleep(300);
            const cSaw = await c.evaluate((n) => window.S.members.filter((m) => m.member.username === n).map((m) => [m.event, m.member.sessionId]), names[1]);
            report.steps.forced410.cSaw = cSaw.slice(-2);
            check('forced 410: a call on b\'s dead session answers session_gone (410), the room hears b\'s session end', r.ok === false && r.error?.code === 'session_gone' && r.error?.status === 410 && cSaw.at(-1)?.[0] === 'session' && cSaw.at(-1)?.[1] === null, report.steps.forced410);
            // recovery: a new session, push, c pulls again
            report.steps.bRecover = await b.evaluate(() => window.newSession().then(() => window.push()));
            await sleep(300);
            report.steps.cRepullB = await c.evaluate((n) => window.pull(n), names[1]);
            await sleep(2000);
            const after = await hear();
            report.steps.hearingAfterRecovery = after;
            check('b recovers with a new session: c hears b again', report.steps.bRecover.ok && report.steps.cRepullB.ok && (after[2][names[1]]?.kbps ?? 0) > 5, { recover: report.steps.bRecover, repull: report.steps.cRepullB });
        }

        // cleanup
        for (const p of pages) await p.evaluate(() => window.ask('sfuLeave', {}).finally(() => window.S.pc?.close())).catch(() => {});
        await a.evaluate(() => window.S.socket.emit('cancelTournament'));
        await sleep(500);
        report.serverLines = server.lines.filter((l) => !/v=0/.test(l));
    } finally {
        if (browser) await browser.close().catch(() => {});
        server.child.kill('SIGTERM');
        for (let i = 0; i < 40 && server.child.exitCode === null; i++) await sleep(100);
        if (server.child.exitCode === null) server.child.kill('SIGKILL');
        if (server.out) server.out.end();
        await dropDb(o.db).catch(() => {});
    }
    report.passed = report.checks.length > 0 && report.checks.every((x) => x.ok);
    if (o.json) fs.writeFileSync(o.json, JSON.stringify(report, null, 2));
    console.log(report.passed ? 'ALL PASS' : 'SOME CHECKS FAILED');
    process.exit(report.passed ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
