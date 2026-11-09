/**
 * Deterministic avatar test images (built with real sharp) and the
 * shipped-iOS inline decoder check.
 *
 * iosLegacyDecodes(pic) is ported from the App Store build's only custom
 * picture decoder, cc9059f iOSClient/BABOnline/SpriteKit/Nodes/
 * OpponentHandNode.swift:123-130 (loadProfilePic):
 *
 *   if pic.starts(with: "data:image"), let commaIndex = pic.firstIndex(of: ",") {
 *       let base64 = String(pic[pic.index(after: commaIndex)...])
 *       if let data = Data(base64Encoded: base64), let image = UIImage(data: data) { ... }
 *
 * Data(base64Encoded:) without options is strict (only the base64 alphabet,
 * padded to a multiple of 4, no whitespace); UIImage(data:) is ImageIO,
 * which reads PNG, JPEG, GIF and (iOS 14+, deployment target 17.0) WebP.
 * The MIME text before the comma is never read. Here: the same string
 * checks, a magic-byte check for those four formats and sharp reading the
 * dimensions stand in for UIImage.
 */

'use strict';

const sharp = require('sharp');

const STRICT_B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Would the shipped iOS app (cc9059f) decode this pic string into an image? */
async function iosLegacyDecodes(pic) {
    if (typeof pic !== 'string' || !pic.startsWith('data:image')) return false;
    const comma = pic.indexOf(',');
    if (comma < 0) return false;
    const b64 = pic.slice(comma + 1);
    if (!STRICT_B64.test(b64) || b64.length % 4 !== 0 || b64.length === 0) return false;
    const buf = Buffer.from(b64, 'base64');
    const magic = buf.toString('latin1', 0, 4);
    const ok = (buf[0] === 0x89 && magic.slice(1) === 'PNG') || (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
        magic === 'GIF8' || (magic === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP');
    if (!ok) return false;
    try {
        const m = await sharp(buf).metadata();
        return m.width > 0 && m.height > 0;
    } catch {
        return false;
    }
}

/** LCG noise (deterministic). */
function noise(n, seed = 12345) {
    const out = Buffer.alloc(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        out[i] = s >>> 24;
    }
    return out;
}

/**
 * A web-uploader-like avatar: `size` px square PNG, blurred noise "photo"
 * inside a circle with 16% transparent padding (ProfilePage.resizeImage).
 * `patch` < size keeps the noise to a centred patch over a smooth vertical
 * gradient: a large picture that still fits today's 500 KB upload cap
 * (avatarPng(612, seed, 360) is ~0.5 M base64 chars, like the old 612 px
 * uploads).
 */
async function avatarPng(size = 200, seed = 12345, patch = size) {
    let rgb = await sharp(noise(patch * patch * 3, seed), { raw: { width: patch, height: patch, channels: 3 } })
        .blur(1.2).raw().toBuffer();
    if (patch < size) {
        const full = Buffer.alloc(size * size * 3);
        const off = Math.floor((size - patch) / 2);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = (y * size + x) * 3;
                const inside = x >= off && x < off + patch && y >= off && y < off + patch;
                if (inside) rgb.copy(full, i, ((y - off) * patch + (x - off)) * 3, ((y - off) * patch + (x - off)) * 3 + 3);
                else { full[i] = 40 + (y * 150 / size) | 0; full[i + 1] = 90; full[i + 2] = 200 - (y * 120 / size) | 0; }
            }
        }
        rgb = full;
    }
    const rgba = Buffer.alloc(size * size * 4);
    const r = (size - size * 0.32) / 2;
    const c = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            rgba[i * 4] = rgb[i * 3];
            rgba[i * 4 + 1] = rgb[i * 3 + 1];
            rgba[i * 4 + 2] = rgb[i * 3 + 2];
            rgba[i * 4 + 3] = Math.hypot(x + 0.5 - c, y + 0.5 - c) <= r ? 255 : 0;
        }
    }
    return sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

/** Landscape JPEG (left half red, right half blue) with EXIF orientation 6 and GPS. */
async function exifRotatedJpeg() {
    const w = 300;
    const h = 200;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            if (x < w / 2) raw[i] = 255; else raw[i + 2] = 255;
        }
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
        .jpeg({ quality: 90 })
        .withMetadata({ orientation: 6 })
        .withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 0/1' } })
        .toBuffer();
}

/** Two-frame animated GIF: frame 1 red, frame 2 blue (64 px). */
async function animatedGif() {
    const frame = (r, b) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
    const frames = [await frame(255, 0), await frame(0, 255)];
    return sharp(frames, { join: { animated: true } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** A handcrafted PNG whose IHDR claims width x height (< 100 B: a decode bomb). */
function bombPng(width = 12000, height = 12000) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const idat = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]); // empty zlib stream
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64"/></svg>');
const HTML = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');

module.exports = {
    iosLegacyDecodes,
    avatarPng,
    dataUrl,
    exifRotatedJpeg,
    animatedGif,
    bombPng,
    SVG,
    HTML,
    I1_RE: /^data:image\/[a-z]+;base64,[A-Za-z0-9+/]+={0,2}$/,
};
