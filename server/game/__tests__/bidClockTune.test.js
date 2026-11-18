/**
 * The bid clock's length IS the tune's length (scripts/build-sounds.py
 * 'bidclock', 30.000 s): clients end-align the tune with the server's
 * deadline, so the two must not drift apart.
 */

const fs = require('fs');
const path = require('path');
const SeatState = require('../SeatState');

const ROOT = path.join(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'sounds-src', 'sounds.json'), 'utf8'));

test('BID_CLOCK_MS equals bidclock.m4a\'s duration in sounds-src/sounds.json', () => {
    const entry = manifest.sounds.bidclock;
    expect(entry).toBeDefined();
    expect(entry.source).toBe('synthesized');
    expect(SeatState.BID_CLOCK_MS).toBe(Math.round(entry.duration * 1000));
});

test('the tune is in both outputs (web and iOS) with the manifest\'s hash', () => {
    const crypto = require('crypto');
    for (const dir of ['client/assets/sounds', 'iOSClient/BABOnline/Resources/Sounds']) {
        const file = path.join(ROOT, dir, 'bidclock.m4a');
        expect(fs.existsSync(file)).toBe(true);
        expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(manifest.sounds.bidclock.sha256);
    }
});
