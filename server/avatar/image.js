/**
 * Avatar image derivation (roadmap item 10; docs/avatars.md).
 *
 * Untrusted input: a custom profile picture is a data URL a client
 * uploaded (today's users.customProfilePic, up to ~683 K base64 chars).
 * derive() turns its bytes into one canonical rendition: a WebP, square,
 * at most 256 px, metadata (EXIF, GPS) stripped. Safety, in order:
 *   1. a synchronous magic-byte sniff: PNG / JPEG / GIF / WebP only (SVG,
 *      HEIC, TIFF, garbage never reach libvips) -> hostile 'format';
 *   2. JPEG only, also synchronous: more than 64 SOS markers -> hostile
 *      'scans'. libjpeg walks every block of the image once per scan, so a
 *      progressive JPEG that repeats a tiny Ah=0/Al=0 scan ~28,000 times
 *      inside the 500 KB budget costs 5-9 s of CPU at 4096^2 (no libjpeg
 *      warning, and libvips' timeout is only checked between scanlines,
 *      after the whole scan run). Real files carry ~10 scans (plus ~10 for
 *      an EXIF thumbnail). The count is of raw FF DA byte pairs, an upper
 *      bound on the SOS markers libjpeg can see (entropy data stuffs FF);
 *   3. the header (sharp metadata, ~1 ms even for a 12000x12000 bomb):
 *      format allowlist again, width x height <= 4096^2 (2048^2 for new
 *      uploads: the web client sends 200 px) -> else hostile 'pixels';
 *      smaller than 8 px -> undecodable;
 *   4. the decode itself under limitInputPixels, first frame only
 *      (pages: 1), a 3 s libvips timeout, and failOn 'error' for new
 *      uploads (strict) / 'none' for stored pictures (lenient: a slightly
 *      truncated stored PNG still renders today, so it should still derive).
 *      A timeout is reported as status 'error' (transient: avatarStore
 *      retries it later), never as undecodable.
 * Callers run derive() through avatarStore's semaphore (2 at once), so at
 * most 2 of libuv's 4 threadpool threads ever decode.
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
/** New uploads (strict): the web client uploads 200 px squares (older bundles 612 px). */
const MAX_UPLOAD_PIXELS = 2048 * 2048;
/** More SOS markers than this in a JPEG is a scan bomb (real files: ~10, ~20 with an EXIF thumbnail). */
const MAX_JPEG_SCANS = 64;
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
 * Upper bound on the SOS (start of scan) markers in a JPEG: raw FF DA byte
 * pairs anywhere after SOI. Stops counting past `stopAfter`.
 */
function jpegScanCount(buf, stopAfter = Infinity) {
    let n = 0;
    for (let i = buf.indexOf(0xff, 2); i !== -1 && i + 1 < buf.length; i = buf.indexOf(0xff, i + 1)) {
        if (buf[i + 1] === 0xda && ++n > stopAfter) break;
    }
    return n;
}

/**
 * Derive the canonical rendition of untrusted image bytes.
 * @param {Buffer} buf
 * @param {Object} [opts]
 * @param {boolean} [opts.strict=false] - fail on any decode warning (uploads)
 * @returns {Promise<{status:'ok', webp:Buffer, width:number, height:number, ms:number}
 *   | {status:'hostile', reason:'format'|'pixels'|'scans'} | {status:'undecodable'}
 *   | {status:'error'}>} 'error' = transient (libvips timeout): try again later
 */
async function derive(buf, { strict = false } = {}) {
    if (!sharp) return { status: 'undecodable' };
    const fmt = sniff(buf);
    if (!fmt) return { status: 'hostile', reason: 'format' };
    if (fmt === 'jpeg' && jpegScanCount(buf, MAX_JPEG_SCANS) > MAX_JPEG_SCANS) return { status: 'hostile', reason: 'scans' };
    const maxPixels = strict ? MAX_UPLOAD_PIXELS : MAX_PIXELS;
    const t0 = process.hrtime.bigint();
    try {
        const input = () => sharp(buf, {
            limitInputPixels: maxPixels,
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
        if (w * h > maxPixels) return { status: 'hostile', reason: 'pixels' };
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
        // sharp's .timeout() kills the pipeline: "VipsImage: killed for image ..."
        if (/killed|timeout/i.test(e.message)) return { status: 'error' };
        return { status: 'undecodable' };
    }
}

/**
 * A PNG of a rendition, for browsers that cannot show WebP (Safari 14/15
 * on macOS 10.15 and older): GET /avatar picks it by the Accept header.
 */
async function toPng(webp) {
    if (!sharp) throw new Error('sharp unavailable');
    return sharp(webp, { limitInputPixels: RENDITION_PX * RENDITION_PX, failOn: 'error' })
        .timeout({ seconds: 3 })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
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
    jpegScanCount,
    toInline,
    toPng,
    MAX_PIXELS,
    MAX_UPLOAD_PIXELS,
    MAX_JPEG_SCANS,
    RENDITION_PX,
    MAX_B64_CHARS,
    MAX_DECODED_BYTES,
    _sharp: () => sharp,
};
