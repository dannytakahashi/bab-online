/**
 * server/avatar/image.js with real sharp: the canonical rendition and the
 * hostile-input gates (format allowlist by magic bytes, 4096^2 pixel cap
 * from the header, strict decode for uploads).
 */

const sharp = require('sharp');
const image = require('../image');
const fx = require('../../testUtils/avatarFixtures');

let png200;
beforeAll(async () => { png200 = await fx.avatarPng(200); });

test('a 200 px circle-masked upload becomes a 200 px WebP with alpha that the shipped iOS app decodes', async () => {
    const url = fx.dataUrl(png200);
    expect(url.length).toBeGreaterThan(40000);
    const buf = image.parseDataUrl(url);
    const r = await image.derive(buf, { strict: true });
    expect(r.status).toBe('ok');
    const m = await sharp(r.webp).metadata();
    expect({ format: m.format, width: m.width, height: m.height, hasAlpha: m.hasAlpha }).toEqual({ format: 'webp', width: 200, height: 200, hasAlpha: true });
    expect(r.webp.length).toBeLessThan(url.length / 3);
    const inline = image.toInline(r.webp);
    expect(inline).toMatch(fx.I1_RE);
    expect(await fx.iosLegacyDecodes(inline)).toBe(true);
    expect(await fx.iosLegacyDecodes(url)).toBe(true); // today's stored value too
});

test('a 612 px source comes out at 256 px; never enlarged', async () => {
    const big = await image.derive(await fx.avatarPng(612, 3, 360));
    expect([big.status, big.width, big.height]).toEqual(['ok', 256, 256]);
    const small = await image.derive(await fx.avatarPng(64));
    expect([small.status, small.width, small.height]).toEqual(['ok', 64, 64]);
});

test('an EXIF-rotated JPEG comes out upright and square, with no metadata left', async () => {
    const r = await image.derive(await fx.exifRotatedJpeg(), { strict: true });
    expect(r.status).toBe('ok');
    expect([r.width, r.height]).toEqual([200, 200]);
    const m = await sharp(r.webp).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.orientation).toBeUndefined();
    // stored left half red -> displayed top half red (orientation 6 = rotate 90 CW)
    const { data, info } = await sharp(r.webp).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => [...data.slice((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(px(100, 10)[0]).toBeGreaterThan(200);
    expect(px(100, 190)[2]).toBeGreaterThan(200);
});

test('an animated GIF keeps its first frame only', async () => {
    const r = await image.derive(await fx.animatedGif(), { strict: true });
    expect(r.status).toBe('ok');
    const m = await sharp(r.webp).metadata();
    expect(m.pages || 1).toBe(1);
    const { data } = await sharp(r.webp).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // red
    expect(data[2]).toBeLessThan(50);
});

test('a 12000x12000 PNG header (under 100 B) is hostile/pixels, read from the header in under 50 ms', async () => {
    const bomb = fx.bombPng(12000, 12000);
    expect(bomb.length).toBeLessThan(100);
    await image.derive(fx.bombPng(10000, 10000)); // warm libvips' PNG loader
    const t0 = Date.now();
    const r = await image.derive(bomb);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(r).toEqual({ status: 'hostile', reason: 'pixels' });
    expect(await image.derive(fx.bombPng(4097, 4096))).toEqual({ status: 'hostile', reason: 'pixels' });
});

test('a progressive-JPEG scan bomb that passes every upload gate is hostile/scans, synchronously, without a decode', async () => {
    const bomb = await fx.scanBombJpeg(4096);
    // the upload gates (Joi max, the handler's 500 KB check, parseDataUrl) all pass
    const url = 'data:image/jpeg;base64,' + bomb.toString('base64');
    expect(bomb.length).toBeLessThanOrEqual(image.MAX_DECODED_BYTES);
    expect((url.length * 3) / 4).toBeLessThanOrEqual(500 * 1024);
    expect(image.parseDataUrl(url)).not.toBeNull();
    expect(image.jpegScanCount(bomb)).toBeGreaterThan(10000);
    const sharpSpy = jest.spyOn(image._sharp().prototype, 'metadata');
    for (const strict of [true, false]) {
        const t0 = Date.now();
        expect(await image.derive(bomb, { strict })).toEqual({ status: 'hostile', reason: 'scans' });
        expect(Date.now() - t0).toBeLessThan(100);
    }
    expect(sharpSpy).not.toHaveBeenCalled(); // never reaches libvips
    sharpSpy.mockRestore();
    // just over the cap is hostile; real progressive / mozjpeg / baseline files are far below it
    const over = await fx.scanBombJpeg(256, { scans: image.MAX_JPEG_SCANS }); // 10 + 64 scans
    expect((await image.derive(over)).status).toBe('hostile');
    const under = await fx.scanBombJpeg(256, { scans: image.MAX_JPEG_SCANS - 10 }); // exactly 64
    expect(image.jpegScanCount(under)).toBe(image.MAX_JPEG_SCANS);
    expect((await image.derive(under)).status).toBe('ok');
    for (const opts of [{ progressive: true }, { progressive: true, mozjpeg: true }, {}]) {
        const j = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#358' } }).jpeg(opts).toBuffer();
        expect(image.jpegScanCount(j)).toBeLessThanOrEqual(10);
        expect((await image.derive(j, { strict: true })).status).toBe('ok');
    }
    expect((await image.derive(await fx.exifRotatedJpeg(), { strict: true })).status).toBe('ok');
});

test('new uploads (strict) stop at 2048^2 pixels; stored pictures (lenient) keep the 4096^2 cap', async () => {
    const big = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#0a0' } }).png().toBuffer();
    expect(await image.derive(big, { strict: true })).toEqual({ status: 'hostile', reason: 'pixels' });
    expect((await image.derive(big, { strict: false })).status).toBe('ok');
    const ok = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#0a0' } }).png().toBuffer();
    expect((await image.derive(ok, { strict: true })).status).toBe('ok');
});

test('a libvips timeout is a transient error, not an undecodable verdict', async () => {
    const proto = image._sharp().prototype;
    const spy = jest.spyOn(proto, 'toBuffer').mockRejectedValueOnce(new Error('VipsImage: killed for image "temp-60"'));
    expect(await image.derive(png200, { strict: true })).toEqual({ status: 'error' });
    spy.mockRejectedValueOnce(new Error('VipsJpeg: Premature end of input file'));
    expect(await image.derive(png200, { strict: true })).toEqual({ status: 'undecodable' });
    spy.mockRestore();
});

test('toPng: the PNG rendition (non-WebP browsers) keeps size and alpha', async () => {
    const r = await image.derive(png200, { strict: true });
    const png = await image.toPng(r.webp);
    const m = await sharp(png).metadata();
    expect([m.format, m.width, m.height, m.hasAlpha]).toEqual(['png', 200, 200, true]);
});

test('SVG (or HTML) behind an image/png prefix is hostile/format; garbage is rejected synchronously', async () => {
    const svg = image.parseDataUrl(fx.dataUrl(fx.SVG));
    expect(svg).not.toBeNull();
    expect(await image.derive(svg)).toEqual({ status: 'hostile', reason: 'format' });
    expect(await image.derive(fx.HTML)).toEqual({ status: 'hostile', reason: 'format' });
    // 'AAAA' decodes to 3 zero bytes: no magic, no threadpool hop
    const p = image.derive(Buffer.from('AAAA', 'base64'));
    expect(image.sniff(Buffer.from('AAAA', 'base64'))).toBeNull();
    expect(await p).toEqual({ status: 'hostile', reason: 'format' });
    // a TIFF (allowed by libvips, not by us)
    const tiff = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f00' } }).tiff().toBuffer();
    expect(await image.derive(tiff)).toEqual({ status: 'hostile', reason: 'format' });
});

test('a truncated PNG is undecodable when strict (uploads); tiny images are undecodable', async () => {
    const cut = png200.subarray(0, Math.floor(png200.length * 0.6));
    expect(await image.derive(cut, { strict: true })).toEqual({ status: 'undecodable' });
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#0000' } }).png().toBuffer();
    expect(await image.derive(tiny)).toEqual({ status: 'undecodable' });
});

test('parseDataUrl: prefix allowlist and size caps', () => {
    expect(image.parseDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(image.parseDataUrl('data:text/html;base64,PGI+')).toBeNull();
    expect(image.parseDataUrl(12)).toBeNull();
    expect(image.parseDataUrl('data:image/png;base64,')).toBeNull();
    expect(image.parseDataUrl('data:image/png;base64,' + 'A'.repeat(700004))).toBeNull();
    expect(image.parseDataUrl('data:image/png;base64,' + 'A'.repeat(690000))).toBeNull(); // 517,500 B decoded
    expect(image.parseDataUrl('data:image/jpg;base64,' + 'A'.repeat(680000))).toHaveLength(510000);
});

test('without sharp the pipeline is unavailable and derive never throws', async () => {
    let img;
    let errors;
    jest.isolateModules(() => {
        jest.doMock('sharp', () => { throw new Error('Could not load the "sharp" module'); });
        const { logger } = require('../../utils/logger');
        errors = jest.spyOn(logger, 'error').mockImplementation(() => {});
        img = require('../image');
    });
    jest.dontMock('sharp');
    expect(img.available()).toBe(false);
    expect(errors).toHaveBeenCalled();
    expect(await img.derive(Buffer.from('x'))).toEqual({ status: 'undecodable' });
    expect(image.available()).toBe(true);
});

test('sharp is pinned exactly and the lockfile carries the prebuilt binaries for Railway, CI, alpine and macOS', () => {
    const root = require('path').join(__dirname, '..', '..', '..');
    const pkg = require(`${root}/package.json`);
    const lock = require(`${root}/package-lock.json`);
    expect(pkg.dependencies.sharp).toBe('0.34.5');
    expect(pkg.engines.node).toBe('>=18.17.0');
    expect(lock.packages['node_modules/sharp'].version).toBe('0.34.5');
    for (const p of ['sharp-linux-x64', 'sharp-libvips-linux-x64', 'sharp-linuxmusl-x64', 'sharp-libvips-linuxmusl-x64',
        'sharp-darwin-arm64', 'sharp-libvips-darwin-arm64', 'sharp-darwin-x64', 'sharp-libvips-darwin-x64']) {
        expect({ p, locked: !!lock.packages[`node_modules/@img/${p}`] }).toEqual({ p, locked: true });
    }
});
