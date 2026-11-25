#!/usr/bin/env node
/**
 * Tournament voice mesh measurement (docs/claude/voice.md, "Measuring the
 * mesh"). Signs N headless Chromium pages (Playwright, fake microphone) into
 * one tournament lobby on a PRIVATE local server, so they form the
 * tournament's voice room (server/voice/tournamentVoice.js), and reports:
 *
 *   - whether every admitted pair connected, per-call setup time, and how
 *     long after the last entry the whole mesh was up
 *   - the voice signaling each page sent (voiceOffer / voiceAnswer /
 *     voiceIceCandidate: totals and the busiest 10 s window) against the
 *     server's per-socket limits (server/socket/rateLimiter.js), and every
 *     'rate_limited' drop in the server's debug log
 *   - per-renderer CPU (Chromium SystemInfo.getProcessInfo)
 *   - getStats over a steady window: up / down bitrate, packet loss,
 *     jitter, concealment, which speakers each page actually heard, and the
 *     codec's fmtp line (Opus defaults, DTX on or off)
 *   - past the cap (N > --cap): that the ones waiting in line hold no call
 *     and show "Voice is full (N people)", and that the first in line gets
 *     every call once an admitted member leaves
 *
 * Usage (MONGO_URI is required; never port 3000 or 27017, never the
 * database 'babonline'):
 *
 *   export MONGO_URI=mongodb://127.0.0.1:<your test mongod port>
 *   npm run voice:measure -- --n 12 --cap 12 --speakers 3 --steady 30
 *
 * Options:
 *   --n <2..30>         pages (default 4)
 *   --cap <2..20>       TOURNAMENT_VOICE_MAX for the private server (default: n, at most 20)
 *   --speakers <k>      pages that unmute (the M key) for the steady window (default 1)
 *   --steady <s>        steady window in seconds (default 15)
 *   --entry staggered|burst   one join every --stagger-ms (default 500), or all at once
 *   --port <n>          the private server's port (default: a free one in 38100-38699)
 *   --db <name>         its database (default voicemesh_<pid>; dropped at the end unless --keep-db)
 *   --connect-timeout <s>  how long to wait for the mesh (default 30)
 *   --json <file>       also write the full report as JSON
 *   --browsers <k>      Chromium instances the pages are spread over (default ceil(n/10)):
 *                       one Chromium's audio service opens at most 50 output streams,
 *                       and 20 pages in one instance pass that, so no page plays out
 *   --headed            show the browser windows (default headless)
 *   --verbose           print every page's console lines (the built client logs little)
 *
 * One-time setup: `npx playwright install --only-shell chromium` (Playwright
 * is a devDependency; CI never downloads a browser). The server serves the
 * built client: `npm run build:client` runs first when client/dist is missing.
 * Run it with the Mac's output muted (Chromium is also started with
 * --mute-audio); one run at a time, it closes everything it started.
 *
 * Exit code: 0 when every check passed, 1 when one failed, 2 on a setup error.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- options
function parseArgs(argv) {
    const o = { n: 4, cap: null, speakers: 1, steady: 15, entry: 'staggered', staggerMs: 500, port: null, db: null, connectTimeout: 30, json: null, keepDb: false, headed: false, browsers: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === '--n') o.n = Number(v());
        else if (a === '--cap') o.cap = Number(v());
        else if (a === '--speakers') o.speakers = Number(v());
        else if (a === '--steady') o.steady = Number(v());
        else if (a === '--entry') o.entry = v();
        else if (a === '--stagger-ms') o.staggerMs = Number(v());
        else if (a === '--port') o.port = Number(v());
        else if (a === '--db') o.db = v();
        else if (a === '--connect-timeout') o.connectTimeout = Number(v());
        else if (a === '--json') o.json = v();
        else if (a === '--keep-db') o.keepDb = true;
        else if (a === '--headed') o.headed = true;
        else if (a === '--browsers') o.browsers = Number(v());
        else if (a === '--verbose') o.verbose = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else throw new Error(`unknown option ${a}`);
    }
    if (o.cap === null) o.cap = Math.min(o.n, 20);
    if (o.browsers === null) o.browsers = Math.ceil(o.n / 10);
    const bad = (m) => { throw new Error(m); };
    if (!Number.isInteger(o.n) || o.n < 2 || o.n > 30) bad('--n must be 2..30');
    if (!Number.isInteger(o.cap) || o.cap < 2 || o.cap > 20) bad('--cap must be 2..20 (the server clamps TOURNAMENT_VOICE_MAX to that)');
    if (!Number.isInteger(o.speakers) || o.speakers < 0 || o.speakers > Math.min(o.n, o.cap)) bad('--speakers must be 0..min(n, cap)');
    if (!Number.isInteger(o.browsers) || o.browsers < 1 || o.browsers > o.n) bad('--browsers must be 1..n');
    if (!(o.steady >= 3)) bad('--steady must be at least 3 seconds');
    if (!['staggered', 'burst'].includes(o.entry)) bad('--entry must be staggered or burst');
    if (o.port !== null && (!Number.isInteger(o.port) || o.port < 1024 || o.port === 3000 || o.port === 27017)) bad('--port: never 3000 or 27017');
    // the harness drops its database at the end: only one of its own names
    if (o.db !== null && !/^(voicemesh|v12)_[A-Za-z0-9_]{1,40}$/.test(o.db)) bad('--db: voicemesh_<x> or v12_<x> only (it is dropped at the end)');
    return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(2)}%`);
const kbps = (x) => (x === null || x === undefined ? '-' : `${Math.round(x / 1000)}k`);

function freePort(lo = 38100, hi = 38699) {
    return new Promise((resolve, reject) => {
        const tryOne = (left) => {
            if (left === 0) return reject(new Error('no free port in 38100-38699'));
            const p = lo + Math.floor(Math.random() * (hi - lo + 1));
            const srv = net.createServer();
            srv.once('error', () => tryOne(left - 1));
            srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)));
        };
        tryOne(50);
    });
}

// ---------------------------------------------------------------- the private server
function startServer({ port, db, cap }) {
    const lines = [];
    const drops = [];
    const tail = [];
    const env = {
        ...process.env,
        BAB_LIVE_PORT: String(port),
        BAB_LIVE_DB: db,
        DB_NAME: db,
        TOURNAMENT_VOICE_MAX: String(cap),
        LOG_LEVEL: 'debug',
        NODE_ENV: 'development',
    };
    delete env.PORT;
    const child = spawn(process.execPath, ['-r', './scripts/ios-live-resume-preload.js', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => {
        for (const raw of buf.toString().split('\n')) {
            const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
            if (!line.trim()) continue;
            tail.push(line);
            if (tail.length > 200) tail.shift();
            if (line.includes('Voice signal dropped') && line.includes('rate_limited')) drops.push(line);
            if (/Voice: tournament room|error/i.test(line)) lines.push(line);
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    return { child, lines, drops, tail };
}

async function waitReady(base, child, timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})`);
        try {
            const r = await fetch(`${base}/ready`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('server never became ready');
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
}

// ---------------------------------------------------------------- accounts
/** N users straight into the private database, each with one saved web session (sign-up's per-IP bucket allows 5). */
async function seedUsers({ mongoUri, db, n, runId }) {
    const { MongoClient } = require('mongodb');
    const bcrypt = require('bcryptjs');
    const { issueSession } = require(path.join(ROOT, 'server/utils/sessionTokens.js'));
    const client = new MongoClient(mongoUri);
    await client.connect();
    try {
        const users = client.db(db).collection('users');
        const out = [];
        for (let i = 0; i < n; i++) {
            const username = `vm${runId}_${String(i + 1).padStart(2, '0')}`;
            const session = issueSession(null);
            // a throwaway password nobody uses: the page signs in by its saved session
            const password = bcrypt.hashSync(randomBytes(12).toString('hex'), 4);
            await users.insertOne({
                username,
                password,
                sessionTokens: session.update.$set.sessionTokens,
                profilePic: 1 + (i % 8),
                tutorial: 'done',
                stats: { wins: 0, losses: 0, gamesPlayed: 0, totalPoints: 0, totalTricksBid: 0, totalTricksTaken: 0 },
            });
            out.push({ username, token: session.token });
        }
        return out;
    } finally {
        await client.close();
    }
}

async function dropDb({ mongoUri, db }) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(mongoUri);
    await client.connect();
    try { await client.db(db).dropDatabase(); } finally { await client.close(); }
}

// ---------------------------------------------------------------- in-page instrumentation
// Runs before the page's own scripts: the saved session (so the page signs
// in by restoreSession), every RTCPeerConnection recorded, every c2s voice
// signal counted (websocket frames and polling bodies)
function instrument({ username, token }) {
    try { localStorage.setItem('bab.savedSession', JSON.stringify({ username, sessionToken: token })); } catch { /* storage blocked */ }
    const pcs = [];
    const sig = [];
    window.__mesh = { pcs, sig };
    const Orig = window.RTCPeerConnection;
    function Wrapped(...args) {
        const pc = new Orig(...args);
        const rec = { pc, created: Date.now(), connected: null, states: [], localCandidates: 0 };
        pcs.push(rec);
        pc.addEventListener('connectionstatechange', () => {
            rec.states.push([pc.connectionState, Date.now()]);
            if (pc.connectionState === 'connected' && rec.connected === null) rec.connected = Date.now();
        });
        pc.addEventListener('icecandidate', (e) => { if (e.candidate) rec.localCandidates++; });
        return pc;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
    const count = (data) => {
        if (typeof data !== 'string') return;
        for (const packet of data.split('\x1e')) {
            const m = /^42\["(voiceOffer|voiceAnswer|voiceIceCandidate)"/.exec(packet);
            if (m) sig.push([m[1], Date.now()]);
        }
    };
    const wsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) { count(data); return wsSend.call(this, data); };
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) { count(body); return xhrSend.call(this, body); };
}

// One sample of a page: every call's getStats digest, its audio elements, the over-cap notice
async function sample(page) {
    return page.evaluate(async () => {
        const ufrag = (sdp) => (sdp ? (/a=ice-ufrag:(\S+)/.exec(sdp) || [])[1] || null : null);
        const calls = [];
        for (const r of window.__mesh.pcs) {
            const pc = r.pc;
            const c = { state: pc.connectionState, created: r.created, connected: r.connected, localCandidates: r.localCandidates, restarts: r.states.filter(([s]) => s === 'disconnected' || s === 'failed').length, lu: ufrag(pc.localDescription?.sdp), ru: ufrag(pc.remoteDescription?.sdp), tx: pc.getTransceivers?.().map((t) => [t.direction, t.currentDirection, t.sender.track ? `${t.sender.track.kind}:${t.sender.track.enabled ? 'on' : 'off'}:${t.sender.track.readyState}:${t.sender.track.label}` : 'no-track']) };
            if (pc.connectionState !== 'closed') {
                const rep = await pc.getStats();
                const codecs = {};
                let selected = null;
                rep.forEach((s) => {
                    if (s.type === 'codec') codecs[s.id] = { mimeType: s.mimeType, fmtp: s.sdpFmtpLine };
                    if (s.type === 'transport' && s.selectedCandidatePairId) selected = s.selectedCandidatePairId;
                });
                rep.forEach((s) => {
                    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                        c.in = { packetsReceived: s.packetsReceived || 0, packetsLost: s.packetsLost || 0, jitter: s.jitter || 0, bytesReceived: s.bytesReceived || 0, concealedSamples: s.concealedSamples || 0, totalSamplesReceived: s.totalSamplesReceived || 0, totalAudioEnergy: s.totalAudioEnergy || 0, codec: codecs[s.codecId] || null };
                    }
                    if (s.type === 'outbound-rtp' && s.kind === 'audio') {
                        c.out = { bytesSent: s.bytesSent || 0, packetsSent: s.packetsSent || 0, codec: codecs[s.codecId] || null };
                    }
                    if (s.type === 'candidate-pair' && s.id === selected) c.rtt = s.currentRoundTripTime ?? null;
                });
            }
            calls.push(c);
        }
        return {
            t: Date.now(),
            calls,
            sig: window.__mesh.sig.slice(),
            audioEls: document.querySelectorAll('audio').length,
            voiceFull: document.getElementById('tournamentVoiceFull')?.textContent ?? null,
            screen: document.getElementById('tournamentLobbyContainer') ? 'tournamentLobby' : (document.getElementById('mainRoomContainer') ? 'mainRoom' : 'other'),
        };
    });
}

const liveCalls = (s) => s.calls.filter((c) => c.state !== 'closed');
const connectedCalls = (s) => s.calls.filter((c) => c.state === 'connected');

/** The busiest 10 s window of each signal event in a page's send log. */
function busiest(sig, windowMs = 10000) {
    const out = {};
    for (const ev of ['voiceOffer', 'voiceAnswer', 'voiceIceCandidate']) {
        const ts = sig.filter(([e]) => e === ev).map(([, t]) => t).sort((a, b) => a - b);
        let best = 0;
        for (let i = 0, j = 0; i < ts.length; i++) {
            while (ts[i] - ts[j] >= windowMs) j++;
            best = Math.max(best, i - j + 1);
        }
        out[ev] = { total: ts.length, max10s: best };
    }
    return out;
}

/** Pairs (by ICE ufrags) seen connected from both sides. */
function pairsUp(samples) {
    const halves = new Map();
    samples.forEach((s, page) => {
        for (const c of connectedCalls(s)) {
            if (!c.lu || !c.ru) continue;
            const key = [c.lu, c.ru].sort().join('|');
            if (!halves.has(key)) halves.set(key, new Set());
            halves.get(key).add(page);
        }
    });
    const pairs = new Set();
    for (const pages of halves.values()) if (pages.size === 2) pairs.add([...pages].sort((a, b) => a - b).join('-'));
    return pairs;
}

async function cpuTimes(cdp) {
    try {
        const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
        return processInfo.map((p) => ({ type: p.type, id: p.id, cpu: p.cpuTime }));
    } catch {
        return null;
    }
}

function cpuReport(before, after, seconds) {
    if (!before || !after) return null;
    const prev = new Map(before.map((p) => [p.id, p.cpu]));
    const rows = after.filter((p) => prev.has(p.id)).map((p) => ({ type: p.type, pct: ((p.cpu - prev.get(p.id)) / seconds) * 100 }));
    const by = (type) => rows.filter((r) => r.type === type).map((r) => r.pct).sort((a, b) => b - a);
    const renderers = by('renderer');
    return {
        renderers: renderers.map((x) => Math.round(x * 10) / 10),
        rendererMean: renderers.length ? renderers.reduce((a, b) => a + b, 0) / renderers.length : null,
        rendererMax: renderers.length ? renderers[0] : null,
        other: rows.filter((r) => r.type !== 'renderer').map((r) => `${r.type} ${r.pct.toFixed(1)}%`),
    };
}

// ---------------------------------------------------------------- the run
/**
 * Why a MONGO_URI is refused, or null. Every host must carry an explicit
 * port other than 27017 (no port means 27017), and mongodb+srv (a cluster,
 * never a private test mongod) is refused outright.
 */
export function mongoUriRefusal(uri) {
    const m = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]*)/.exec(String(uri));
    if (!m) return 'not a mongodb:// URI';
    if (m[1]) return 'mongodb+srv is never a private test mongod';
    const hosts = m[2].split(',').filter(Boolean);
    if (hosts.length === 0) return 'no host';
    for (const h of hosts) {
        const port = /:(\d+)$/.exec(h);
        if (!port) return `${h} has no port (that is 27017)`;
        if (Number(port[1]) === 27017) return `${h} is port 27017`;
    }
    return null;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`voice-mesh-measure: ${e.message} (--help for usage)`);
        process.exit(2);
    }
    if (opts.help) {
        console.log('See the header of scripts/voice-mesh-measure.mjs and docs/claude/voice.md "Measuring the mesh".');
        return 0;
    }
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('voice-mesh-measure: set MONGO_URI to a test mongod (never 27017)');
        return 2;
    }
    const refused = mongoUriRefusal(mongoUri);
    if (refused) {
        console.error(`voice-mesh-measure: MONGO_URI refused: ${refused} (use a private test mongod on its own port)`);
        return 2;
    }
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch {
        console.error('voice-mesh-measure: Playwright is missing (npm ci), then npx playwright install --only-shell chromium');
        return 2;
    }
    if (!existsSync(path.join(ROOT, 'client/dist/index.html'))) {
        console.log('client/dist missing: npm run build:client');
        const b = spawnSync('npm', ['run', 'build:client'], { cwd: ROOT, stdio: 'inherit' });
        if (b.status !== 0) return 2;
    }

    const runId = randomBytes(3).toString('hex');
    const port = opts.port ?? await freePort();
    const db = opts.db ?? `voicemesh_${process.pid}`;
    const base = `http://127.0.0.1:${port}`;
    const admittedCount = Math.min(opts.n, opts.cap);
    const expectedPairs = (admittedCount * (admittedCount - 1)) / 2;
    const rateLimiter = require(path.join(ROOT, 'server/socket/rateLimiter.js'));
    const limits = {
        voiceOffer: rateLimiter.limits.voiceOffer.max,
        voiceAnswer: rateLimiter.limits.voiceAnswer.max,
        voiceIceCandidate: rateLimiter.limits.voiceIceCandidate.max,
    };

    console.log(`voice mesh: n=${opts.n} cap=${opts.cap} (admitted ${admittedCount}, ${expectedPairs} pairs) speakers=${opts.speakers} entry=${opts.entry} browsers=${opts.browsers} steady=${opts.steady}s server=${base} db=${db}`);

    let server = null;
    let browser = null;
    const report = { opts: { ...opts, port, db }, limits, checks: [] };
    const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); };
    let exitCode = 2;
    const cleanup = async () => {
        try { await browser?.close(); } catch { /* already gone */ }
        await stopServer(server?.child);
        if (!opts.keepDb) { try { await dropDb({ mongoUri, db }); } catch (e) { console.warn(`could not drop ${db}: ${e.message}`); } }
    };
    process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });

    try {
        server = startServer({ port, db, cap: opts.cap });
        await waitReady(base, server.child);
        const accounts = await seedUsers({ mongoUri, db, n: opts.n, runId });

        // Pages spread over --browsers instances: one Chromium's audio
        // service opens at most 50 output streams (audio_manager_base.cc), and
        // 20 pages in one instance pass it, so none of them plays out (a real
        // client is one page and never comes near it)
        const browsers = [];
        for (let b = 0; b < opts.browsers; b++) {
            browsers.push(await chromium.launch({
                headless: !opts.headed,
                args: [
                    '--use-fake-device-for-media-stream',
                    '--use-fake-ui-for-media-stream',
                    '--autoplay-policy=no-user-gesture-required',
                    '--mute-audio',
                ],
            }));
        }
        browser = { close: async () => { await Promise.all(browsers.map((b) => b.close())); } };
        const cdps = await Promise.all(browsers.map((b) => b.newBrowserCDPSession()));
        const cdp = { send: async (m) => ({ processInfo: (await Promise.all(cdps.map((c) => c.send(m)))).flatMap((r) => r.processInfo) }) };
        let pages = [];
        for (const acct of accounts) {
            const context = await browsers[pages.length % browsers.length].newContext({ permissions: ['microphone'] });
            await context.addInitScript(instrument, acct);
            const page = await context.newPage();
            page.on('pageerror', (e) => console.warn(`[page ${acct.username}] ${e.message}`));
            const pageNo = pages.length + 1;
            if (opts.verbose) page.on('console', (m) => { console.log(`[page ${pageNo} ${m.type()}] ${m.text().slice(0, 300)}`); });
            pages.push(page);
        }
        await Promise.all(pages.map((p) => p.goto(base, { waitUntil: 'domcontentloaded' })));
        await Promise.all(pages.map((p) => p.waitForSelector('#mainRoomContainer', { timeout: 30000 })));
        console.log(`signed in: ${pages.length} pages`);

        // the first page creates the tournament; the rest join it
        const tournamentId = await pages[0].evaluate(() => new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('no tournamentCreated')), 10000);
            window.socket.once('tournamentCreated', (d) => { clearTimeout(t); resolve(d.tournamentId); });
            window.socket.emit('createTournament');
        }));
        await pages[0].waitForSelector('#tournamentLobbyContainer', { timeout: 10000 });
        const join = (p) => p.evaluate((id) => window.socket.emit('joinTournament', { tournamentId: id }), tournamentId);
        const entryStart = Date.now();
        if (opts.entry === 'burst') {
            await Promise.all(pages.slice(1).map(join));
        } else {
            for (const p of pages.slice(1)) {
                await join(p);
                await sleep(opts.staggerMs);
            }
        }
        const lastEntry = Date.now();
        await Promise.all(pages.map((p) => p.waitForSelector('#tournamentLobbyContainer', { timeout: 15000 })));
        console.log(`entered: ${opts.entry}, ${((lastEntry - entryStart) / 1000).toFixed(1)}s from the first join to the last`);

        // the mesh: every admitted page with admittedCount-1 connected calls,
        // the ones in line (the server's order, not the pages': a burst
        // entry races) with none and the notice
        let samples = [];
        let meshUpAt = null;
        const deadline = lastEntry + opts.connectTimeout * 1000;
        const inLine = (s) => s.voiceFull !== null;
        while (Date.now() < deadline) {
            samples = await Promise.all(pages.map(sample));
            const waitingNow = samples.filter(inLine);
            const admittedNow = samples.filter((x) => !inLine(x));
            const up = waitingNow.length === opts.n - admittedCount
                && waitingNow.every((x) => liveCalls(x).length === 0)
                && admittedNow.every((x) => connectedCalls(x).length === admittedCount - 1);
            if (up && pairsUp(admittedNow).size === expectedPairs) { meshUpAt = Date.now(); break; }
            await sleep(250);
        }
        // from here on the admitted pages come first (page numbers in the report are the join order)
        const order = [...samples.keys()].sort((a, b) => Number(inLine(samples[a])) - Number(inLine(samples[b])) || a - b);
        const label = order.map((i) => i + 1);
        pages = order.map((i) => pages[i]);
        samples = order.map((i) => samples[i]);
        const setupTimes = samples.slice(0, admittedCount).flatMap((s) => connectedCalls(s).map((c) => c.connected - c.created));
        const pairs = pairsUp(samples.slice(0, admittedCount));
        report.connect = {
            pairs: pairs.size,
            expectedPairs,
            meshUpAfterLastEntryMs: meshUpAt === null ? null : meshUpAt - lastEntry,
            setupMedianMs: median(setupTimes),
            setupMaxMs: setupTimes.length ? Math.max(...setupTimes) : null,
            perPageConnected: samples.map((s) => connectedCalls(s).length),
            restarts: samples.reduce((a, s) => a + s.calls.reduce((b, c) => b + c.restarts, 0), 0),
            localCandidatesPerCall: median(samples.flatMap((s) => s.calls.map((c) => c.localCandidates))),
        };
        console.log(`mesh: ${pairs.size}/${expectedPairs} pairs, up ${meshUpAt === null ? 'NEVER' : `${((meshUpAt - lastEntry) / 1000).toFixed(1)}s after the last entry`}; per-call setup median ${report.connect.setupMedianMs ?? '-'} ms, max ${report.connect.setupMaxMs ?? '-'} ms; ${report.connect.localCandidatesPerCall ?? '-'} local candidates per call (median)`);
        check('every admitted pair connected (both sides)', pairs.size === expectedPairs, `${pairs.size}/${expectedPairs}`);
        check('mesh up within 10 s of the last entry', meshUpAt !== null && meshUpAt - lastEntry <= 10000, report.connect.meshUpAfterLastEntryMs);
        check('median per-call setup under 3 s', report.connect.setupMedianMs !== null && report.connect.setupMedianMs < 3000, report.connect.setupMedianMs);
        check('no call restarted or failed', report.connect.restarts === 0, report.connect.restarts);

        // Every page gets a gesture first (Shift: no hotkey), as a real
        // player has clicked by now: it unlocks the page's audio (the voice
        // manager's first-gesture unlock resumes its AudioContext, so a
        // muted page sends its silent track like a real one). Then the
        // speakers unmute (the M key) and the steady window starts once
        // every speaker's calls carry its microphone (getUserMedia and the
        // re-offer to each call)
        for (const p of pages) {
            await p.bringToFront();
            await p.evaluate(() => document.activeElement?.blur?.());
            await p.keyboard.press('Shift');
        }
        const unmuteAt = Date.now();
        for (const p of pages.slice(0, opts.speakers)) {
            await p.bringToFront();
            await p.keyboard.press('m');
        }
        const micOn = (s) => liveCalls(s).length > 0 && liveCalls(s).every((c) => (c.tx || []).some(([, , t]) => /^audio:on:live/.test(t) && !/MediaStreamAudioDestinationNode/.test(t)));
        let speaking = opts.speakers === 0;
        while (!speaking && Date.now() - unmuteAt < 15000) {
            await sleep(250);
            speaking = (await Promise.all(pages.slice(0, opts.speakers).map(sample))).every(micOn);
        }
        report.unmuteMs = speaking ? Date.now() - unmuteAt : null;
        check('every speaker\'s calls carry its microphone after the unmute', speaking, report.unmuteMs);
        await sleep(2000);
        const cpu0 = await cpuTimes(cdp);
        const first = await Promise.all(pages.map(sample));
        const jitterMax = [];
        const t0 = Date.now();
        while (Date.now() - t0 < opts.steady * 1000) {
            await sleep(1000);
            const mid = await Promise.all(pages.slice(0, admittedCount).map(sample));
            for (const s of mid) for (const c of s.calls) if (c.in) jitterMax.push(c.in.jitter);
        }
        const last = await Promise.all(pages.map(sample));
        const cpu1 = await cpuTimes(cdp);
        const secs = (last[0].t - first[0].t) / 1000;

        const perPage = [];
        let worstLoss = 0;
        let worstConceal = 0;
        let notPlayingOut = 0;
        for (let i = 0; i < admittedCount; i++) {
            const a = new Map(first[i].calls.filter((c) => c.lu).map((c) => [c.lu, c]));
            let up = 0; let down = 0; let heard = 0; let lost = 0; let recv = 0; let conceal = 0; let samplesIn = 0;
            for (const c of last[i].calls) {
                const b = a.get(c.lu);
                if (!b || c.state !== 'connected') continue;
                if (c.out && b.out) up += ((c.out.bytesSent - b.out.bytesSent) * 8) / secs;
                if (c.in && b.in) {
                    down += ((c.in.bytesReceived - b.in.bytesReceived) * 8) / secs;
                    const dl = c.in.packetsLost - b.in.packetsLost;
                    const dr = c.in.packetsReceived - b.in.packetsReceived;
                    lost += Math.max(0, dl); recv += Math.max(0, dr);
                    const dc = c.in.concealedSamples - b.in.concealedSamples;
                    const ds = c.in.totalSamplesReceived - b.in.totalSamplesReceived;
                    conceal += Math.max(0, dc); samplesIn += Math.max(0, ds);
                    if (c.in.totalAudioEnergy - b.in.totalAudioEnergy > 1e-6) heard++;
                    const callLoss = dl + dr > 0 ? dl / (dl + dr) : 0;
                    const callConceal = ds > 0 ? dc / ds : 0;
                    // packets in but no samples out: nothing plays it, and concealment would read 0
                    if (dr > 0 && ds <= 0) notPlayingOut++;
                    worstLoss = Math.max(worstLoss, callLoss);
                    worstConceal = Math.max(worstConceal, callConceal);
                }
            }
            perPage.push({ page: label[i], speaker: i < opts.speakers, upBps: up, downBps: down, loss: recv + lost > 0 ? lost / (recv + lost) : 0, conceal: samplesIn > 0 ? conceal / samplesIn : 0, heardSpeakers: heard, audioEls: last[i].audioEls, calls: liveCalls(last[i]).length });
        }
        const fmtp = last.flatMap((s) => s.calls.map((c) => c.out?.codec?.fmtp)).find(Boolean) || null;
        const cpu = cpuReport(cpu0, cpu1, secs);
        report.steady = { seconds: secs, perPage, worstLoss, worstConceal, notPlayingOut, jitterMaxMs: jitterMax.length ? Math.max(...jitterMax) * 1000 : null, fmtp, cpu };
        report.samples = { first: first.map((x) => ({ ...x, sig: undefined })), last: last.map((x) => ({ ...x, sig: undefined })) };

        console.log(`\nsteady ${secs.toFixed(1)}s, ${opts.speakers} speaking (Opus fmtp: ${fmtp ?? '-'})`);
        console.log('page  speaker  up      down    loss     conceal  heard  calls  <audio>');
        for (const r of perPage) {
            console.log(`${String(r.page).padEnd(6)}${(r.speaker ? 'yes' : '').padEnd(9)}${kbps(r.upBps).padEnd(8)}${kbps(r.downBps).padEnd(8)}${pct(r.loss).padEnd(9)}${pct(r.conceal).padEnd(9)}${String(r.heardSpeakers).padEnd(7)}${String(r.calls).padEnd(7)}${r.audioEls}`);
        }
        console.log(`worst call: loss ${pct(worstLoss)}, concealment ${pct(worstConceal)}, max jitter ${report.steady.jitterMaxMs === null ? '-' : report.steady.jitterMaxMs.toFixed(1)} ms`);
        if (cpu) console.log(`CPU per renderer (% of one core): mean ${cpu.rendererMean?.toFixed(1)}, max ${cpu.rendererMax?.toFixed(1)} [${cpu.renderers.join(', ')}]; ${cpu.other.join(', ')}`);
        check('every call with packets in plays them out (inbound totalSamplesReceived grows)', notPlayingOut === 0, notPlayingOut);
        check('inbound loss under 1% on every call', worstLoss < 0.01, pct(worstLoss));
        check('concealment under 2% on every call', worstConceal < 0.02, pct(worstConceal));
        check('jitter under 30 ms', report.steady.jitterMaxMs !== null && report.steady.jitterMaxMs < 30, report.steady.jitterMaxMs);
        const shouldHear = (i) => (i < opts.speakers ? opts.speakers - 1 : opts.speakers);
        check('every page heard every speaker', perPage.every((r, i) => r.heardSpeakers >= shouldHear(i)), perPage.map((r) => r.heardSpeakers).join(','));
        check('audio elements at most the pool (20) plus the calls', perPage.every((r) => r.audioEls <= 20 + r.calls), perPage.map((r) => r.audioEls).join(','));

        // past the cap: the ones in line hold no call and show the notice; one leaves and the first in line gets every call
        if (opts.n > opts.cap) {
            const waiting = last.slice(admittedCount);
            const note = `Voice is full (${opts.cap} people)`;
            check('the ones waiting in line hold no call', waiting.every((s) => liveCalls(s).length === 0), waiting.map((s) => liveCalls(s).length).join(','));
            check(`the ones waiting in line show "${note}"`, waiting.every((s) => s.voiceFull === note), waiting.map((s) => s.voiceFull).join(' | '));
            await pages[admittedCount - 1].evaluate(() => window.socket.emit('leaveTournament'));
            let joinedOk = false;
            const until = Date.now() + opts.connectTimeout * 1000;
            let line = [];
            while (Date.now() < until) {
                line = await Promise.all(pages.slice(admittedCount).map(sample));
                const inNow = line.filter((x) => x.voiceFull === null);
                const still = line.filter((x) => x.voiceFull !== null);
                if (inNow.length === 1 && connectedCalls(inNow[0]).length === admittedCount - 1 && still.every((x) => liveCalls(x).length === 0)) { joinedOk = true; break; }
                await sleep(250);
            }
            check('a leave lets exactly the first in line in (every call up, its notice gone; the rest still wait)', joinedOk, line.map((x) => `${connectedCalls(x).length} calls, notice ${x.voiceFull}`).join(' | '));
        }

        // signaling against the limits, and the server's drops
        const finalSig = await Promise.all(pages.map(sample));
        const sig = finalSig.map((s) => busiest(s.sig));
        const peak = (ev) => Math.max(...sig.map((x) => x[ev].max10s));
        const total = (ev) => sig.reduce((a, x) => a + x[ev].total, 0);
        report.signaling = { perPage: sig, peak: { voiceOffer: peak('voiceOffer'), voiceAnswer: peak('voiceAnswer'), voiceIceCandidate: peak('voiceIceCandidate') }, rateLimitedDrops: server.drops.length };
        console.log(`\nsignaling (all pages): offers ${total('voiceOffer')}, answers ${total('voiceAnswer')}, ICE ${total('voiceIceCandidate')}; busiest 10 s of one page: offers ${peak('voiceOffer')}/${limits.voiceOffer}, answers ${peak('voiceAnswer')}/${limits.voiceAnswer}, ICE ${peak('voiceIceCandidate')}/${limits.voiceIceCandidate}; server rate_limited drops: ${server.drops.length}`);
        check('every page under the signaling limits', ['voiceOffer', 'voiceAnswer', 'voiceIceCandidate'].every((ev) => peak(ev) <= limits[ev]), report.signaling.peak);
        check("zero 'rate_limited' voice drops in the server log", server.drops.length === 0, server.drops.slice(0, 3));

        console.log('\nchecks:');
        for (const c of report.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail === undefined ? '' : `  (${typeof c.detail === 'object' ? JSON.stringify(c.detail) : c.detail})`}`);
        exitCode = report.checks.every((c) => c.ok) ? 0 : 1;
        console.log(exitCode === 0 ? '\nALL PASS' : '\nSOME CHECKS FAILED');
    } catch (e) {
        console.error(`voice-mesh-measure: ${e.stack || e.message}`);
        if (server?.tail?.length) console.error(`--- last server lines\n${server.tail.slice(-30).join('\n')}`);
        exitCode = 2;
    } finally {
        if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
        await cleanup();
    }
    return exitCode;
}

main().then((code) => process.exit(code));
