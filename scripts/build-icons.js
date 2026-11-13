#!/usr/bin/env node
/**
 * The web page's icons, from the iOS app icon (the same art as the phone
 * gate's assets/app-icon.webp):
 *
 *   client/favicon.ico                 16, 32 and 48 px PNG entries (every
 *                                      page fetches it, the phone gate and
 *                                      /privacy included; was a 176 KB
 *                                      nine-size .ico of older art)
 *   client/assets/icons/icon-192.png   <link rel=icon type=image/png> for
 *                                      high-DPI tabs and Android
 *   client/assets/icons/apple-touch-icon.png  180 px (iOS home screen)
 *   client/assets/app-icon.webp        288 px, the phone gate's 96 px icon
 *                                      at 3x
 *
 *   node scripts/build-icons.js         write them
 *   node scripts/build-icons.js --check fail when a committed file differs
 *                                       from a fresh render
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'iOSClient/BABOnline/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png');
const ICO_SIZES = [16, 32, 48];

const png = (size) => sharp(SOURCE)
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, palette: size >= 180, quality: 100, effort: 10 })
    .toBuffer();

/** An .ico of PNG entries (ICONDIR + ICONDIRENTRY per image, then the PNGs). */
function ico(images) {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, data }, i) => {
        const e = 6 + 16 * i;
        header.writeUInt8(size, e); // width (< 256)
        header.writeUInt8(size, e + 1); // height
        header.writeUInt8(0, e + 2); // no palette
        header.writeUInt8(0, e + 3); // reserved
        header.writeUInt16LE(1, e + 4); // colour planes
        header.writeUInt16LE(32, e + 6); // bits per pixel
        header.writeUInt32LE(data.length, e + 8);
        header.writeUInt32LE(offset, e + 12);
        offset += data.length;
    });
    return Buffer.concat([header, ...images.map((im) => im.data)]);
}

async function render() {
    const entries = await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await png(size) })));
    return {
        'client/favicon.ico': ico(entries),
        'client/assets/icons/icon-192.png': await png(192),
        'client/assets/icons/apple-touch-icon.png': await png(180),
        'client/assets/app-icon.webp': await sharp(SOURCE)
            .resize(288, 288, { kernel: 'lanczos3' })
            .webp({ quality: 90, effort: 6 })
            .toBuffer(),
    };
}

async function main() {
    const check = process.argv.includes('--check');
    const files = await render();
    let stale = 0;
    for (const [rel, data] of Object.entries(files)) {
        const file = path.join(ROOT, rel);
        if (check) {
            const same = fs.existsSync(file) && fs.readFileSync(file).equals(data);
            if (!same) { stale++; console.error(`stale: ${rel}`); }
            continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
        console.log(`${rel}  ${data.length} bytes`);
    }
    if (stale) process.exit(1);
}

if (require.main === module) {
    main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { ico, ICO_SIZES };
