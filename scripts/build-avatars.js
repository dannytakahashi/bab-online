#!/usr/bin/env node
/**
 * Stock avatar art (roadmap item 10; docs/avatars.md). Reproducible: the
 * masters are read from git (`git show <rev>:client/assets/...`, default
 * fcdd885, the last commit with the original 612 px / 2048 px PNGs), so
 * running it again after the files were overwritten gives the same output.
 *
 *   npm run build:avatars                 write everything below
 *   node scripts/build-avatars.js --check verify the committed files decode
 *                                         and have the stated size/format
 *   --rev <commit>                        masters from another commit
 *
 * Outputs
 *   client/assets/profile{1..82}.png       192x192 PNG, same paths: what the
 *                                          App Store iOS build (40 pt @3x =
 *                                          120 px) and cached old web bundles
 *                                          load. 256-colour palette with alpha
 *                                          (libimagequant, quality 100,
 *                                          dithered): ~0.9 MB for all 82
 *                                          instead of ~2.5 MB lossless; any
 *                                          file under 38 dB PSNR vs the
 *                                          lossless 192 px render stays
 *                                          lossless
 *   client/assets/avatars/v1/profile{N}.webp  256x256 WebP for new clients
 *                                          (web 80-100 CSS px); quality 82,
 *                                          raised to 90 for any file under
 *                                          36 dB PSNR vs a lossless 256 px
 *                                          render (flattened on white), and
 *                                          to near-lossless if still under
 *   client/assets/frog.png                 120 px lossless (dealer button,
 *                                          40 CSS px @3x)
 *   client/assets/avatars/v1/frog.webp     120 px
 *   server/avatar/placeholder.js           default_avatar.png, 120 px WebP
 *                                          data URL (hostile stored pictures)
 *
 * avatars/v1 is immutable once published (served with a one-year
 * immutable cache): new art goes into avatars/v2, never over v1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'client', 'assets');
const V1 = path.join(ASSETS, 'avatars', 'v1');
const PLACEHOLDER = path.join(ROOT, 'server', 'avatar', 'placeholder.js');
const COUNT = 82;
const LEGACY_PX = 192;
const WEBP_PX = 256;
const FROG_PX = 120;
const PSNR_MIN = 36;
const PNG_PSNR_MIN = 38;
const PALETTE = { palette: true, quality: 100, effort: 10, dither: 1, compressionLevel: 9 };
const WEBP = (quality) => ({ quality, alphaQuality: 90, effort: 6, smartSubsample: true });
const PNG = { compressionLevel: 9, adaptiveFiltering: true };

const args = process.argv.slice(2);
const rev = args.includes('--rev') ? args[args.indexOf('--rev') + 1] : 'fcdd885';

sharp.cache(false);

function master(rel) {
    return execFileSync('git', ['show', `${rev}:${rel}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

/** RGB on white of an RGBA image at `px`, as raw bytes. */
async function onWhite(buf, px) {
    return sharp(buf).resize(px, px).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
}

function psnr(a, b) {
    let se = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        se += d * d;
    }
    const mse = se / a.length;
    return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

async function expectImage(file, { format, px, alpha = true }) {
    const m = await sharp(file).metadata();
    const ok = m.format === format && m.width === px && m.height === px && (!alpha || m.hasAlpha);
    const name = typeof file === 'string' ? path.relative(ROOT, file) : 'buffer';
    if (!ok) throw new Error(`${name}: expected ${format} ${px}x${px}${alpha ? ' with alpha' : ''}, got ${m.format} ${m.width}x${m.height} alpha=${m.hasAlpha}`);
    return typeof file === 'string' ? fs.statSync(file).size : file.length;
}

async function build() {
    fs.mkdirSync(V1, { recursive: true });
    const rows = [];
    let before = 0;
    let legacyTotal = 0;
    let webpTotal = 0;
    for (let n = 1; n <= COUNT; n++) {
        const src = master(`client/assets/profile${n}.png`);
        before += src.length;
        const lossless = await sharp(src).resize(LEGACY_PX, LEGACY_PX, { kernel: 'lanczos3' }).png(PNG).toBuffer();
        let png = await sharp(src).resize(LEGACY_PX, LEGACY_PX, { kernel: 'lanczos3' }).png(PALETTE).toBuffer();
        const pngDb = psnr(await onWhite(lossless, LEGACY_PX), await onWhite(png, LEGACY_PX));
        if (pngDb < PNG_PSNR_MIN) png = lossless;
        fs.writeFileSync(path.join(ASSETS, `profile${n}.png`), png);
        legacyTotal += png.length;

        const ref = await onWhite(await sharp(src).resize(WEBP_PX, WEBP_PX, { kernel: 'lanczos3' }).png().toBuffer(), WEBP_PX);
        let q = 82;
        let webp = await sharp(src).resize(WEBP_PX, WEBP_PX, { kernel: 'lanczos3' }).webp(WEBP(q)).toBuffer();
        let db = psnr(ref, await onWhite(webp, WEBP_PX));
        if (db < PSNR_MIN) {
            q = 90;
            webp = await sharp(src).resize(WEBP_PX, WEBP_PX, { kernel: 'lanczos3' }).webp(WEBP(q)).toBuffer();
            db = psnr(ref, await onWhite(webp, WEBP_PX));
        }
        if (db < PSNR_MIN) {
            q = 'nl';
            webp = await sharp(src).resize(WEBP_PX, WEBP_PX, { kernel: 'lanczos3' }).webp({ nearLossless: true, quality: 60, effort: 6 }).toBuffer();
            db = psnr(ref, await onWhite(webp, WEBP_PX));
        }
        fs.writeFileSync(path.join(V1, `profile${n}.webp`), webp);
        webpTotal += webp.length;
        rows.push({ n, srcBytes: src.length, pngBytes: png.length, pngPsnr: png === lossless ? 'lossless' : Number(pngDb.toFixed(2)), webpBytes: webp.length, q, psnr: Number(db.toFixed(2)) });
    }

    const frogSrc = master('client/assets/frog.png');
    const frogPng = await sharp(frogSrc).resize(FROG_PX, FROG_PX, { kernel: 'lanczos3' }).png(PNG).toBuffer();
    fs.writeFileSync(path.join(ASSETS, 'frog.png'), frogPng);
    const frogWebp = await sharp(frogSrc).resize(FROG_PX, FROG_PX, { kernel: 'lanczos3' }).webp(WEBP(90)).toBuffer();
    fs.writeFileSync(path.join(V1, 'frog.webp'), frogWebp);

    const ph = await sharp(master('client/assets/default_avatar.png')).resize(120, 120).webp({ ...WEBP(82), effort: 6 }).toBuffer();
    fs.writeFileSync(PLACEHOLDER, placeholderSource('data:image/webp;base64,' + ph.toString('base64')));

    console.log('  N   master B   192 png B  png dB   256 webp B   q  webp dB');
    for (const r of rows) {
        console.log(`${String(r.n).padStart(3)} ${String(r.srcBytes).padStart(10)} ${String(r.pngBytes).padStart(10)} ${String(r.pngPsnr).padStart(8)} ${String(r.webpBytes).padStart(10)} ${String(r.q).padStart(4)} ${String(r.psnr).padStart(8)}`);
    }
    const worst = rows.reduce((a, r) => (r.psnr < a.psnr ? r : a));
    const worstPng = rows.filter((r) => r.pngPsnr !== 'lossless').reduce((a, r) => (r.pngPsnr < a.pngPsnr ? r : a), { pngPsnr: Infinity });
    console.log(`profile*.png: ${before} B -> ${legacyTotal} B (192 px palette; min ${worstPng.pngPsnr} dB vs lossless; ${rows.filter((r) => r.pngPsnr === 'lossless').length} kept lossless)`);
    console.log(`avatars/v1/profile*.webp: ${webpTotal} B (256 px; min PSNR ${worst.psnr} dB on ${worst.n}; ${rows.filter((r) => r.q === 90).length} at q90, ${rows.filter((r) => r.q === 'nl').length} near-lossless)`);
    console.log(`frog.png: ${frogSrc.length} B -> ${frogPng.length} B; frog.webp ${frogWebp.length} B; placeholder ${ph.length} B`);
    await check();
}

function placeholderSource(url) {
    return `/**
 * GENERATED by scripts/build-avatars.js from client/assets/default_avatar.png
 * (120 px WebP) — do not edit. The generic silhouette a legacy client gets
 * inline instead of a stored custom picture that is not a safe image
 * (hostile: SVG/HTML behind an image MIME, or over 4096x4096 pixels).
 */

'use strict';

module.exports = {
    PLACEHOLDER_INLINE: '${url}',
};
`;
}

async function check() {
    for (let n = 1; n <= COUNT; n++) {
        await expectImage(path.join(ASSETS, `profile${n}.png`), { format: 'png', px: LEGACY_PX });
        await expectImage(path.join(V1, `profile${n}.webp`), { format: 'webp', px: WEBP_PX });
    }
    await expectImage(path.join(ASSETS, 'frog.png'), { format: 'png', px: FROG_PX });
    await expectImage(path.join(V1, 'frog.webp'), { format: 'webp', px: FROG_PX });
    const { PLACEHOLDER_INLINE } = require(PLACEHOLDER);
    await expectImage(Buffer.from(PLACEHOLDER_INLINE.split(',')[1], 'base64'), { format: 'webp', px: 120 });
    console.log('build-avatars: all outputs decode with the stated size and format');
}

if (require.main === module) {
    (args.includes('--check') ? check() : build()).catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { build, check };
