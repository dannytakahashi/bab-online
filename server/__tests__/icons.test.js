/**
 * The web page's icons (scripts/build-icons.js): every page fetches the
 * favicon, the phone gate included, so it stays small (it was a 176 KB
 * nine-size .ico).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CLIENT = path.join(__dirname, '..', '..', 'client');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function icoEntries(buf) {
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    const n = buf.readUInt16LE(4);
    return Array.from({ length: n }, (_, i) => {
        const e = 6 + 16 * i;
        const size = buf.readUInt32LE(e + 8);
        const offset = buf.readUInt32LE(e + 12);
        return { w: buf.readUInt8(e) || 256, h: buf.readUInt8(e + 1) || 256, data: buf.subarray(offset, offset + size) };
    });
}

test('favicon.ico: 16/32/48 px PNG entries, a few KB', async () => {
    const buf = fs.readFileSync(path.join(CLIENT, 'favicon.ico'));
    expect(buf.length).toBeLessThan(16 * 1024);
    const entries = icoEntries(buf);
    expect(entries.map((e) => [e.w, e.h])).toEqual([[16, 16], [32, 32], [48, 48]]);
    for (const e of entries) {
        expect(e.data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
        const meta = await sharp(e.data).metadata();
        expect([meta.width, meta.height]).toEqual([e.w, e.h]);
    }
});

test('the PNG icon and the apple-touch-icon exist at their sizes', async () => {
    for (const [file, size] of [['assets/icons/icon-192.png', 192], ['assets/icons/apple-touch-icon.png', 180]]) {
        const buf = fs.readFileSync(path.join(CLIENT, file));
        expect(buf.length).toBeLessThan(32 * 1024);
        const meta = await sharp(buf).metadata();
        expect([file, meta.format, meta.width, meta.height]).toEqual([file, 'png', size, size]);
    }
});

test('the page links all three', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">');
    expect(html).toContain('<link rel="icon" type="image/png" href="/assets/icons/icon-192.png" sizes="192x192">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">');
});
