#!/usr/bin/env node
/**
 * Read-only report of the stored custom profile pictures (roadmap item 10;
 * docs/avatars.md "Before enabling the pipeline"). Run by the owner against
 * production BEFORE turning the avatar pipeline on, to see what the server
 * will meet:
 *
 *   node scripts/avatar-report.js            summary
 *   node scripts/avatar-report.js --list     plus one line per picture
 *
 * NEVER writes: one find() with a projection (username, customProfilePic),
 * streamed. Each picture goes through the same parse + derive the server
 * uses (server/avatar/image.js) in this process only; nothing is stored.
 * Uses MONGO_URI from the environment or .env (same as the other scripts).
 */

'use strict';

const { connect } = require('../server/admin/cli');
const image = require('../server/avatar/image');

const LIST = process.argv.includes('--list');

async function main() {
    if (!image.available()) {
        console.error('sharp could not be loaded here: cannot derive (the server would run with the pipeline off)');
        process.exit(1);
    }
    const { client, uri, db } = await connect();
    console.log(`Database: ${uri} (read-only report)`);
    const counts = { users: 0, custom: 0, ok: 0, hostile: 0, undecodable: 0, notDataUrl: 0 };
    const reasons = {};
    const formats = {};
    const sizes = [];
    const inline = [];
    let maxMs = 0;
    try {
        const cursor = db.users.find(
            { customProfilePic: { $exists: true, $nin: [null, ''] } },
            { projection: { _id: 0, username: 1, customProfilePic: 1 } }
        );
        for await (const doc of cursor) {
            counts.users++;
            const raw = doc.customProfilePic;
            if (typeof raw !== 'string' || !raw.startsWith('data:image')) {
                counts.notDataUrl++;
                continue;
            }
            counts.custom++;
            sizes.push(raw.length);
            const mime = (/^data:image\/([a-z0-9.+-]+)/i.exec(raw) || [])[1] || '?';
            formats[mime] = (formats[mime] || 0) + 1;
            const buf = image.parseDataUrl(raw);
            const t0 = Date.now();
            const r = buf ? await image.derive(buf) : { status: 'hostile', reason: 'prefix-or-size' };
            maxMs = Math.max(maxMs, Date.now() - t0);
            counts[r.status]++;
            if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
            if (r.status === 'ok') inline.push(image.toInline(r.webp).length);
            if (LIST) console.log(`${doc.username}\t${mime}\t${raw.length} chars\t${r.status}${r.reason ? ` (${r.reason})` : ''}${r.status === 'ok' ? `\t-> ${r.width}px, ${image.toInline(r.webp).length} chars inline` : ''}`);
        }
    } finally {
        await client.close();
    }
    const stat = (a) => (a.length ? { min: Math.min(...a), median: a.slice().sort((x, y) => x - y)[a.length >> 1], max: Math.max(...a), total: a.reduce((x, y) => x + y, 0) } : null);
    console.log(JSON.stringify({ counts, hostileReasons: reasons, declaredFormats: formats, storedChars: stat(sizes), derivedInlineChars: stat(inline), slowestDeriveMs: maxMs }, null, 2));
    console.log('Hostile and undecodable pictures get no /avatar URL: every client shows its neutral picture for them (no inline copy since V1_REMOVALS #19).');
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
