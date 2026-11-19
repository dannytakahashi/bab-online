#!/usr/bin/env node
// The router in front of the deploy-survival live harness (scripts/persist-live-harness.sh),
// standing in for Railway's: one public port, the active instance behind it.
//
//   node scripts/persist-live-proxy.js --listen <port> --ctl <dir> [--target <port>]
//
// - HTTP requests (pages, /health, /ready, Socket.IO long-polling) go to the CURRENT target,
//   per request (no keep-alive to the upstream), so a deploy switches them at once. A polling
//   session that started on the old instance gets the new one's "Session ID unknown" and the
//   client reconnects, as on Railway.
// - A websocket upgrade is pinned to the target it was made to: it stays on the old instance
//   until that instance closes it (io.close at shutdown, an engine close, the process dying).
// - The target is the port number in <dir>/proxy-target, re-read every 100 ms; each switch is
//   logged and acknowledged in <dir>/proxy-target.ack. --target sets the first one.
// - <dir>/proxy-cut (the harness verb proxy-drop): every open websocket is cut at once, a
//   network blip that leaves the instances alone; acknowledged in <dir>/proxy-cut.ack.
// - Upstreams are 127.0.0.1 only. Refuses port 3000 (the real server's) for both sides.
//   Listens on 127.0.0.1 and, when the machine has it, ::1 (so http://localhost:<port> works
//   whichever the client resolves first).
// Logs '[proxy]' lines (target switches, websocket open / close with the upstream port, upstream
// errors): never a request body, a header value or a URL query.
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

function arg(name, def = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const die = (msg) => {
    console.error(`persist-live-proxy: ${msg}`);
    process.exit(2);
};
const port = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) die(`${what} must be a port number from 1024`);
    if (n === 3000) die(`${what} 3000 is the real server's: use another`);
    return n;
};

const listen = port(arg('listen'), '--listen');
const ctl = arg('ctl');
if (!ctl) die('--ctl <dir> is required');
const targetFile = path.join(ctl, 'proxy-target');
const ackFile = path.join(ctl, 'proxy-target.ack');
let target = arg('target') ? port(arg('target'), '--target') : null;

const t = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log('[proxy]', t(), ...a);
const pathOnly = (url) => String(url || '').split('?')[0];

function readTarget() {
    let raw;
    try {
        raw = fs.readFileSync(targetFile, 'utf8').trim();
    } catch {
        return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1024 || n > 65535 || n === 3000 || n === listen) {
        log(`ignoring proxy-target ${JSON.stringify(raw.slice(0, 10))}`);
        return;
    }
    if (n !== target) {
        log(`HTTP target ${target ?? '-'} -> ${n} (websockets stay where they are)`);
        target = n;
    }
    try { fs.writeFileSync(ackFile, `${n}\n`); } catch { /* best effort */ }
}
let wsOpen = 0;
let wsSeq = 0;
// Open websockets: id -> close(why)
const tunnels = new Map();

// <dir>/proxy-cut (written by the harness verb proxy-drop): cut every open websocket now (a network blip: both ends see the TCP
// connection go, the clients reconnect), then remove the file and ack in proxy-cut.ack
const dropFile = path.join(ctl, 'proxy-cut');
function readDrop() {
    if (!fs.existsSync(dropFile)) return;
    try { fs.unlinkSync(dropFile); } catch { /* raced */ }
    const n = tunnels.size;
    for (const close of [...tunnels.values()]) close('dropped (proxy-drop)');
    log(`dropped ${n} websocket(s)`);
    try { fs.writeFileSync(path.join(ctl, 'proxy-cut.ack'), `${n}\n`); } catch { /* best effort */ }
}

readTarget();
setInterval(() => {
    readTarget();
    readDrop();
}, 100).unref();

const server = http.createServer((req, res) => {
    if (!target) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('no target yet\n');
        return;
    }
    const upstreamPort = target;
    const up = http.request({
        host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url,
        headers: { ...req.headers, connection: 'close' }, agent: false,
    }, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
    });
    up.on('error', (err) => {
        log(`HTTP ${req.method} ${pathOnly(req.url)} -> ${upstreamPort} failed: ${err.code || err.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end('upstream unavailable\n');
        } else {
            res.destroy();
        }
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
});

server.on('upgrade', (req, client, head) => {
    if (!target) {
        client.destroy();
        return;
    }
    const upstreamPort = target;
    const id = ++wsSeq;
    let opened = false;
    const up = net.connect(upstreamPort, '127.0.0.1', () => {
        let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(`${raw}\r\n`);
        if (head && head.length) up.write(head);
        client.pipe(up);
        up.pipe(client);
        opened = true;
        wsOpen++;
        log(`ws #${id} open -> ${upstreamPort} (${wsOpen} open)`);
    });
    let closed = false;
    const close = (why) => {
        if (closed) return;
        closed = true;
        tunnels.delete(id);
        if (opened) wsOpen--;
        log(`ws #${id} closed (${why}) on ${upstreamPort} (${wsOpen} open)`);
        client.destroy();
        up.destroy();
    };
    tunnels.set(id, close);
    up.on('error', (err) => close(`upstream ${err.code || err.message}`));
    up.on('close', () => close('upstream closed'));
    client.on('error', (err) => close(`client ${err.code || err.message}`));
    client.on('close', () => close('client closed'));
});

server.listen(listen, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${listen}, target ${target ?? '(none yet)'}`);
    const v6 = http.createServer();
    v6.on('request', (req, res) => server.emit('request', req, res));
    v6.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
    v6.on('error', () => log('no ::1 listener (IPv6 loopback unavailable); 127.0.0.1 only'));
    v6.listen(listen, '::1', () => log(`listening on [::1]:${listen}`));
});
server.on('error', (err) => die(`cannot listen on ${listen}: ${err.code || err.message}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        log(`stopping (${sig})`);
        process.exit(0);
    });
}
