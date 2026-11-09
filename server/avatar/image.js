/**
 * Avatar image derivation (roadmap item 10; docs/avatars.md).
 *
 * Untrusted input: a custom profile picture is a data URL a client
 * uploaded (today's users.customProfilePic, up to ~683 K base64 chars).
 * derive() turns its bytes into one canonical rendition: a WebP, square,
 * at most 256 px, metadata (EXIF, GPS) stripped. Safety, in order:
 *   1. a synchronous magic-byte sniff: PNG / JPEG / GIF / WebP only (SVG,
 *      HEIC, TIFF, garbage never reach libvips) -> hostile 'format';
 *   2. the header (sharp metadata, ~1 ms even for a 12000x12000 bomb):
 *      format allowlist again, width x height <= 4096^2 -> else hostile
 *      'pixels'; smaller than 8 px -> undecodable;
 *   3. the decode itself under limitInputPixels (4096^2), first frame only
 *      (pages: 1), a 3 s libvips timeout, and failOn 'error' for new
 *      uploads (strict) / 'none' for stored pictures (lenient: a slightly
 *      truncated stored PNG still renders today, so it should still derive).
 *
 * sharp (prebuilt libvips, pinned 0.34.5: the last release whose engines
 * include Node 18) is optional at runtime: if it fails to load the whole
 * pipeline is off (available() false) and every payload keeps today's
 * shape. sharp's own cache is off (we cache renditions ourselves, by
 * bytes) and libvips runs one thread per image; avatarStore bounds how
 * many derives run at once.
 */

'use strict';

const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('avatar');

let sharp = null;
try {
    sharp = require('sharp');
    sharp.cache(false);
    sharp.concurrency(1);
} catch (e) {
    sharp = null;
    logger.error('avatar pipeline disabled: sharp unavailable', { error: e.message });
}

/** Can this process derive renditions at all? */
const available = () => !!sharp;

const MAX_PIXELS = 4096 * 4096;
const MIN_SIDE = 8;
/** Rendition edge (px): iOS 40 pt @3x needs 120, web in-game 80 CSS px @3x 240. */
const RENDITION_PX = 256;
/** Base64 chars accepted from a stored/uploaded data URL (uploads stop at ~682,666). */
const MAX_B64_CHARS = 700000;
const MAX_DECODED_BYTES = 512000;
const ALLOWED = new Set(['png', 'jpeg', 'gif', 'webp']);
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
const WEBP_OPTS = { quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true };

/**
 * The image bytes of a data URL, or null when it is not one we accept
 * (wrong prefix, too long, too large decoded).
 * @param {string} str
 * @returns {Buffer|null}
 */
function parseDataUrl(str) {
    if (typeof str !== 'string') return null;
    const m = DATA_URL_RE.exec(str);
    if (!m) return null;
    const b64 = str.slice(m[0].length);
    if (b64.length === 0 || b64.length > MAX_B64_CHARS) return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 || buf.length > MAX_DECODED_BYTES) return null;
    return buf;
}

/** Format by magic bytes (never trust the data URL's MIME text), or null. */
function sniff(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
}

/**
 * Derive the canonical rendition of untrusted image bytes.
 * @param {Buffer} buf
 * @param {Object} [opts]
 * @param {boolean} [opts.strict=false] - fail on any decode warning (uploads)
 * @returns {Promise<{status:'ok', webp:Buffer, width:number, height:number, ms:number}
 *   | {status:'hostile', reason:'format'|'pixels'} | {status:'undecodable'}>}
 */
async function derive(buf, { strict = false } = {}) {
    if (!sharp) return { status: 'undecodable' };
    if (!sniff(buf)) return { status: 'hostile', reason: 'format' };
    const t0 = process.hrtime.bigint();
    try {
        const input = () => sharp(buf, {
            limitInputPixels: MAX_PIXELS,
            failOn: strict ? 'error' : 'none',
            pages: 1,
            sequentialRead: true,
        });
        let meta;
        try {
            meta = await input().metadata();
        } catch (e) {
            return /pixel limit/i.test(e.message) ? { status: 'hostile', reason: 'pixels' } : { status: 'undecodable' };
        }
        if (!ALLOWED.has(meta.format)) return { status: 'hostile', reason: 'format' };
        const w = meta.width || 0;
        const h = meta.pageHeight || meta.height || 0;
        if (w * h > MAX_PIXELS) return { status: 'hostile', reason: 'pixels' };
        if (w < MIN_SIDE || h < MIN_SIDE) return { status: 'undecodable' };
        // EXIF orientation: the upright size decides the square edge
        const upright = (meta.orientation || 1) >= 5 ? [h, w] : [w, h];
        const side = Math.min(RENDITION_PX, upright[0], upright[1]);
        const { data, info } = await input()
            .timeout({ seconds: 3 })
            .rotate()
            .resize(side, side, { fit: 'cover', position: 'centre' })
            .webp(WEBP_OPTS)
            .toBuffer({ resolveWithObject: true });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return { status: 'ok', webp: data, width: info.width, height: info.height, ms };
    } catch (e) {
        if (/pixel limit/i.test(e.message)) return { status: 'hostile', reason: 'pixels' };
        return { status: 'undecodable' };
    }
}

/** The data URL a legacy client gets inline (standard padded base64, no newlines). */
function toInline(webp) {
    return 'data:image/webp;base64,' + webp.toString('base64');
}

module.exports = {
    available,
    parseDataUrl,
    sniff,
    derive,
    toInline,
    MAX_PIXELS,
    RENDITION_PX,
    MAX_B64_CHARS,
    MAX_DECODED_BYTES,
    _sharp: () => sharp,
};
