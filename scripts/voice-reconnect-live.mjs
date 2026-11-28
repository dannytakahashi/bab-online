#!/usr/bin/env node
// voice-reconnect-live.mjs: the host side of iOSClient/BABOnlineUITests/LiveVoiceReconnectTests
// (docs/claude/voice.md "One call per player after a reconnect"); never production. Web pages
// (headless Chromium, the fake microphone) and the iOS app at one casual table on
// scripts/persist-live-harness.sh (a real LIVE_PERSIST hand-off); counts each client's calls per
// remote player (open / connected / receiving packets) before and after a deploy, a proxy drop,
// a page reload and an app relaunch. The pages are seeded accounts (random names and passwords,
// memory only); a page hook on RTCPeerConnection and the signaling frames counts the web's
// calls, the app's DEBUG probe (-meshProbeFile <run>/ios-probe.json) the iPhone's. Results in
// <run>/results.json. MONGO_URI: the harness's mongod (never 27017).
//
//   node scripts/voice-reconnect-live.mjs --base http://127.0.0.1:<proxy> --db <db> --hctl <harness ctl>
//       --run <dir: TEST_RUNNER_BAB_LIVE_CTL> --ios-user <name> [--pages 2] [--phases deploy,blip,reload,relaunch]
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(WT, 'package.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[live ${t()}]`, ...a);

const o = { base: null, db: null, hctl: null, run: null, iosUser: null, pages: 2, phases: 'deploy,blip,reload,relaunch' };
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i += 2) {
  const k = av[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  o[k] = k === 'pages' ? Number(av[i + 1]) : av[i + 1];
}
if (!process.env.MONGO_URI || /:27017\b/.test(process.env.MONGO_URI)) throw new Error('MONGO_URI: a private mongod');
if (/:3000\b/.test(o.base)) throw new Error('never 3000');
fs.mkdirSync(o.run, { recursive: true });

async function seed(n) {
  const { MongoClient } = require('mongodb');
  const bcrypt = require('bcryptjs');
  const { issueSession } = require(path.join(WT, 'server/utils/sessionTokens.js'));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const users = client.db(o.db).collection('users');
    const runId = randomBytes(2).toString('hex');
    const out = [];
    for (let i = 0; i < n; i++) {
      const username = `web${runId}${'abc'[i]}`;
      const s = issueSession(null);
      await users.insertOne({ username, password: bcrypt.hashSync(randomBytes(12).toString('hex'), 4), sessionTokens: s.update.$set.sessionTokens,
        profilePic: 1 + i, tutorial: 'done', stats: { wins: 0, losses: 0, gamesPlayed: 0, totalPoints: 0, totalTricksBid: 0, totalTricksTaken: 0 } });
      out.push({ username, token: s.token });
    }
    return out;
  } finally { await client.close(); }
}

// in the page, before its scripts: every RTCPeerConnection and the voice signaling on the wire
function instrument({ username, token }) {
  try {
    if (!sessionStorage.getItem('sessionToken')) {
      sessionStorage.setItem('username', username);
      sessionStorage.setItem('sessionToken', token);
    }
  } catch { /* none */ }
  const P = window.__probe = { pcs: [], sid: null, names: {}, ev: [] };
  const Orig = window.RTCPeerConnection;
  const Wrapped = function (...a) { const pc = new Orig(...a); P.pcs.push({ pc, created: Date.now(), remote: null }); return pc; };
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  window.RTCPeerConnection = Wrapped;
  const parse = (data) => {
    if (typeof data !== 'string') return null;
    const c = /^40(\{.*)$/s.exec(data);
    if (c) { try { P.sid = JSON.parse(c[1]).sid; P.ev.push([Date.now(), 'sid', P.sid]); } catch { /* */ } return null; }
    const m = /^42\d*(\[.*)$/s.exec(data);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  const onIn = (ev) => {
    const a = parse(ev.data); if (!a) return;
    const [name, d] = a; if (!d || typeof d !== 'object') return;
    if (name === 'voicePeerList') { (d.peers || []).forEach((p) => { P.names[p.socketId] = p.username; }); P.ev.push([Date.now(), 'list', (d.peers || []).map((p) => `${p.username}@${p.socketId}`).join(',')]); }
    else if (name === 'voicePeerJoined' || name === 'voicePeerLeft') { if (d.username) P.names[d.socketId] = d.username; P.ev.push([Date.now(), name, `${d.username || '?'}@${d.socketId}`]); }
    else if (name === 'voiceOffer') { if (d.username) P.names[d.fromSocketId] = d.username; P.ev.push([Date.now(), 'offerIn', `${d.username || '?'}@${d.fromSocketId}`]); }
    else if (name === 'voiceAnswer') P.ev.push([Date.now(), 'answerIn', d.fromSocketId]);
  };
  const OrigWS = window.WebSocket;
  const send = OrigWS.prototype.send;
  OrigWS.prototype.send = function (data) {
    const a = parse(data);
    if (a && (a[0] === 'voiceOffer' || a[0] === 'voiceAnswer') && a[1]) {
      const sdp = (a[1].offer || a[1].answer)?.sdp;
      const rec = P.pcs.find((r) => r.pc.localDescription && r.pc.localDescription.sdp === sdp);
      if (rec) rec.remote = a[1].targetSocketId;
      P.ev.push([Date.now(), a[0] === 'voiceOffer' ? 'offerOut' : 'answerOut', a[1].targetSocketId]);
    }
    return send.call(this, data);
  };
  const WS = function (...a) { const ws = new OrigWS(...a); ws.addEventListener('message', onIn); return ws; };
  WS.prototype = OrigWS.prototype;
  Object.assign(WS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = WS;
  window.__sample = async () => {
    const rows = [];
    for (let i = 0; i < P.pcs.length; i++) {
      const r = P.pcs[i];
      const pc = r.pc;
      let packets = 0, energy = 0, streams = 0;
      if (pc.signalingState !== 'closed') {
        try {
          const st = await pc.getStats();
          st.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') { streams++; packets += s.packetsReceived || 0; energy += s.totalAudioEnergy || 0; } });
        } catch { /* closed meanwhile */ }
      }
      rows.push({ i, remote: r.remote, user: P.names[r.remote] || null, conn: pc.connectionState, sig: pc.signalingState, packets, energy, streams });
    }
    return { sid: P.sid, rows };
  };
}

const pagesInfo = [];
async function samplePage(p) {
  try { return await p.page.evaluate(() => window.__sample()); } catch (e) { return { error: e.message, rows: [] }; }
}
function readIos() {
  try { return JSON.parse(fs.readFileSync(path.join(o.run, 'ios-probe.json'), 'utf8')); } catch { return null; }
}

// one measurement: per client, per remote user, live calls (not closed) and flowing calls
// (inbound packets grew over 2 s)
async function measure(label) {
  const a = await Promise.all(pagesInfo.map(samplePage));
  const ia = readIos();
  await sleep(2000);
  const b = await Promise.all(pagesInfo.map(samplePage));
  const ib = readIos();
  const result = { label, at: new Date().toISOString(), clients: {} };
  pagesInfo.forEach((p, k) => {
    const per = {};
    for (const rb of b[k].rows) {
      if (rb.sig === 'closed') continue;
      const ra = a[k].rows.find((x) => x.i === rb.i);
      const user = rb.user || `?${rb.remote}`;
      per[user] = per[user] || { live: 0, flowing: 0, connected: 0, calls: [] };
      per[user].live++;
      if (rb.conn === 'connected') per[user].connected++;
      const dp = rb.packets - (ra ? ra.packets : 0);
      if (dp > 0) per[user].flowing++;
      per[user].calls.push({ remote: rb.remote, conn: rb.conn, dPackets: dp, dEnergy: +(rb.energy - (ra ? ra.energy : 0)).toFixed(4) });
    }
    result.clients[p.username] = { sid: b[k].sid, totalCreated: b[k].rows.length, per };
  });
  if (ib) {
    const per = {};
    for (const c of ib.calls || []) {
      const ca = (ia?.calls || []).find((x) => x.id === c.id);
      per[c.user] = per[c.user] || { live: 0, flowing: 0, connected: 0, calls: [] };
      if (c.sig === 5 /* closed */) continue;
      per[c.user].live++;
      const dp = c.packets - (ca ? ca.packets : 0);
      if (dp > 0) per[c.user].flowing++;
      if (c.ice === 2 || c.ice === 3) per[c.user].connected++;
      per[c.user].calls.push({ remote: c.id, ice: c.ice, dPackets: dp });
    }
    result.clients[`${o.iosUser} (iOS)`] = { sid: ib.me, probeAge: +(Date.now() / 1000 - ib.t).toFixed(1), per };
  }
  const all = (() => { try { return JSON.parse(fs.readFileSync(path.join(o.run, 'results.json'), 'utf8')); } catch { return []; } })();
  all.push(result);
  fs.writeFileSync(path.join(o.run, 'results.json'), JSON.stringify(all, null, 1));
  log(`== ${label}`);
  for (const [who, c] of Object.entries(result.clients)) {
    log(`  ${who} sid=${c.sid}: ` + Object.entries(c.per).map(([u, v]) => `${u}: live ${v.live} flowing ${v.flowing} connected ${v.connected}`).join(' | '));
  }
  return result;
}

const harness = (verb, ...kv) => {
  log(`harness ${verb} ${kv.join(' ')}`);
  const out = execFileSync(path.join(WT, 'scripts/persist-live-harness.sh'), ['--ctl', o.hctl, '--do', verb, ...kv], { encoding: 'utf8', timeout: 180000 });
  log(`harness ${verb}: ${out.trim().split('\n').slice(-1)[0]}`);
};

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(500); }
  throw new Error(`timed out: ${what}`);
}

async function main() {
  const { chromium } = require('playwright');
  const accounts = await seed(o.pages);
  fs.writeFileSync(path.join(o.run, 'pages.json'), JSON.stringify(accounts.map((a) => a.username)));
  log('pages', accounts.map((a) => a.username).join(','));
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  try {
    for (const acct of accounts) {
      const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(instrument, acct);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => log(`[${acct.username}] pageerror ${e.message}`));
      page.on('console', (m) => { const s = m.text(); if (/\[Voice\]/.test(s) && /replac|duplicate|already|Closed|connectToPeer|handleOffer|re-key|rekey|one call/i.test(s)) fs.appendFileSync(path.join(o.run, `console-${acct.username}.log`), `${t()} ${s}\n`); });
      await page.goto(o.base);
      pagesInfo.push({ page, username: acct.username, ctx });
    }
    for (const p of pagesInfo) await p.page.waitForSelector('#createGameBtn', { timeout: 30000 });
    log('pages in the main room; waiting for the iOS lobby');
    await waitFor(() => fs.existsSync(path.join(o.run, 'ios-lobby')), 400000, 'the iOS lobby');
    for (const p of pagesInfo) {
      const join = p.page.locator('#mainRoomLobbyList button', { hasText: 'Join' }).first();
      await join.waitFor({ timeout: 30000 });
      await join.click();
      await p.page.waitForSelector('#lobbyReadyBtn', { timeout: 20000 });
      await sleep(1000);
    }
    await pagesInfo[0].page.click('#lobbyAddBotBtn');
    await sleep(1500);
    for (const p of pagesInfo) await p.page.click('#lobbyReadyBtn');
    log('pages ready; waiting for the game');
    await waitFor(() => fs.existsSync(path.join(o.run, 'ios-game')), 200000, 'the game');
    // a dealt game is saved (a pre-deal table never is: the hand-off would end it)
    const { MongoClient } = require('mongodb');
    const mc = new MongoClient(process.env.MONGO_URI); await mc.connect();
    await waitFor(async () => (await mc.db(o.db).collection('liveGames').countDocuments({ kind: 'live' })) > 0, 120000, 'a saved live game');
    await mc.close();
    log('the game is dealt and saved');
    // unmute every page (M): the fake device's beep on every call
    await sleep(3000);
    for (const p of pagesInfo) { await p.page.keyboard.press('m'); }
    await sleep(15000);
    await measure('before (game running)');
    const phases = o.phases.split(',').filter(Boolean);
    for (const ph of phases) {
      if (ph === 'deploy') { harness('deploy', 'overlap=3'); await sleep(25000); await measure('after LIVE_PERSIST hand-off (deploy)'); await sleep(20000); await measure('after deploy +45 s'); }
      else if (ph === 'blip') { harness('proxy-drop'); await sleep(25000); await measure('after proxy-drop (network blip)'); }
      else if (ph === 'reload') { log(`reload ${pagesInfo[1].username}`); await pagesInfo[1].page.reload(); await sleep(25000); await measure(`after a reload of ${pagesInfo[1].username}`); }
      else if (ph === 'relaunch') {
        fs.writeFileSync(path.join(o.run, 'relaunch'), '1');
        await waitFor(() => fs.existsSync(path.join(o.run, 'relaunch.done')), 120000, 'relaunch');
        await sleep(30000); await measure('after the iOS app relaunch');
      }
    }
    for (const p of pagesInfo) fs.writeFileSync(path.join(o.run, `events-${p.username}.json`), JSON.stringify(await p.page.evaluate(() => window.__probe.ev), null, 0));
  } finally {
    fs.writeFileSync(path.join(o.run, 'stop'), '1');
    await browser.close();
  }
}
main().catch((e) => { console.error(e); fs.writeFileSync(path.join(o.run, 'stop'), '1'); process.exit(1); });
