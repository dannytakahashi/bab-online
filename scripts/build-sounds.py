#!/usr/bin/env python3
"""
The table's sound effects: client/assets/sounds/*.m4a (web) and the same
files in iOSClient/BABOnline/Resources/Sounds/ (bundled by the synchronized
BABOnline folder, flat at the bundle root). The names below are the contract
the web and iOS players use.

  npm run build:sounds    rebuild both copies and sounds-src/sounds.json
  npm run build:sounds -- --only bidclock[,turn]
                          rebuild only the named sounds; every other output
                          file and manifest entry stays as it is (AAC encodes
                          are not bit-reproducible across macOS versions, so a
                          full rebuild on another machine rewrites every file)
  npm run sounds:check    exit 1 when an output is missing, edited, or older
                          than its recipe or source (no decoding: plain python)

Sources are the few Kenney "Casino Audio" 1.1 samples (CC0) committed in
sounds-src/kenney-casino-audio/; the chimes and the bid clock tune
(bidclock, an original composition: BIDCLOCK_SCORE below) are synthesized
here. Each sound:
decode (afconvert), mono, window, optional pitch shift / low-pass / layer,
trim silence (10 ms RMS frames under -50 dBFS, 10 ms pre-roll), 3 ms fade-in
and a short fade-out, then one gain so the active RMS (frames within 30 dB of
the loudest) hits the target, lowered if the peak would pass -3 dBFS. Encoded
as 64 kb/s AAC, 44.1 kHz mono. The build needs macOS (afconvert) and numpy;
AAC encodes are not bit-reproducible across OS versions, so --check compares
hashes against the manifest instead of re-encoding.

Picks were made by measurement (the samples could not be auditioned): the
shortest, softest, lowest-centroid sample for each role. The levels are
moderate; the players add their own quiet default volume on top.
"""
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SRC = os.path.join(ROOT, 'sounds-src', 'kenney-casino-audio')
MANIFEST = os.path.join(ROOT, 'sounds-src', 'sounds.json')
OUT_DIRS = [
    os.path.join(ROOT, 'client', 'assets', 'sounds'),
    os.path.join(ROOT, 'iOSClient', 'BABOnline', 'Resources', 'Sounds'),
]

# Bump when the processing below changes, so --check calls every output stale
PIPELINE = 1
SR = 44100
TRIM_DB = -50.0
PREROLL = 0.010
FADE_IN = 0.003
PEAK_CAP_DB = -3.0
CARD_DB = -24.0  # table sounds
CUE_DB = -26.0   # chimes, chips and flourishes: heard less often, kept quieter
# The bid clock's 30 s bed sits under the table sounds (players add their own
# master volume on top)
TUNE_DB = -30.0

# G5, B5 (a major third) for the turn cue; C5 E5 G5 for game end, a lower
# register so the two are not confused
G5, B5, C5, E5 = 783.99, 987.77, 523.25, 659.26


# --- the bid clock tune -------------------------------------------------------
#
# bidclock.m4a: the "thinking music" the table hears while a human bidder's
# 30-second bid clock runs (server/socket/bidClock.js; the server bids 0 when
# it ends, so the file's length IS the clock: SeatState.BID_CLOCK_MS, pinned
# by a Jest test against this manifest's duration). An ORIGINAL composition
# in the playful game-show "tiptoe / thinking" style: a stepwise, syncopated
# marimba line over a walking pizzicato bass with a soft clock tick that gets
# busier toward the end, then a short friendly "time's up" bell cue that
# resolves to the tonic. It does not quote or paraphrase any existing tune
# (no alternating fifth-to-tonic leap figure, no lullaby AABA phrase).
# F major, 4/4, 120 BPM (beat 0.5 s, bar 2 s), 15 bars = exactly 30.000 s:
# bars 1-14 music, bar 15 the cue, ending on the deadline.

def _hz(name):
    """'Bb4' -> Hz (12-TET, A4 = 440)."""
    steps = {'C': -9, 'D': -7, 'E': -5, 'F': -4, 'G': -2, 'A': 0, 'B': 2}
    letter, rest = name[0], name[1:]
    acc = 0
    while rest and rest[0] in 'b#':
        acc += -1 if rest[0] == 'b' else 1
        rest = rest[1:]
    n = steps[letter] + acc + 12 * (int(rest) - 4)
    return round(440.0 * 2 ** (n / 12), 3)


BEAT, BAR = 0.5, 2.0
# Melody per bar: (offset in beats from the bar's start, pitch, length in beats)
_MEL = {
    1: [(1.0, 'A4', .5), (1.5, 'Bb4', .5), (2.0, 'C5', 1), (3.0, 'A4', 1)],
    2: [(1.0, 'Bb4', .5), (1.5, 'C5', .5), (2.0, 'D5', 1), (3.0, 'Bb4', 1)],
    3: [(0, 'C5', .5), (.5, 'D5', .5), (1.0, 'C5', .5), (1.5, 'A4', .5), (2.0, 'F4', 1)],
    4: [(0, 'E4', .5), (.5, 'G4', .5), (1.0, 'Bb4', .5), (1.5, 'G4', .5), (2.0, 'C5', 2)],
    8: [(0, 'Bb4', .5), (.5, 'A4', .5), (1.0, 'G4', .5), (1.5, 'E4', .5), (2.0, 'F4', 2)],
    13: [(0, 'G4', .5), (.5, 'A4', .5), (1.0, 'Bb4', .5), (1.5, 'C5', .5), (2.0, 'D5', 1), (3.0, 'Bb4', 1)],
    14: [(0, 'C5', .5), (.5, 'E5', .5), (1.0, 'G5', .5), (1.5, 'Bb5', .5), (2.0, 'C6', 1)],
}
for _b in (5, 6, 7):
    _MEL[_b] = _MEL[_b - 4]
for _b in (9, 10, 11, 12):
    _MEL[_b] = _MEL[_b - 8]
# bars 9-12: a second voice a diatonic third below
_THIRD = {'A4': 'F4', 'Bb4': 'G4', 'C5': 'A4', 'D5': 'Bb4', 'F4': 'D4', 'E4': 'C4', 'G4': 'E4'}
_BASS = {
    'F': ['F2', 'A2', 'C3', 'A2'], 'Bb': ['Bb2', 'D3', 'F3', 'D3'], 'C7': ['C3', 'E3', 'G3', 'Bb2'],
    'Gm7': ['G2', 'Bb2', 'D3', 'F3'], 'C7b': ['C3', 'E3', 'G3', 'E3'],
}
_CHORDS = {1: 'F', 2: 'Bb', 3: 'F', 4: 'C7', 5: 'F', 6: 'Bb', 7: 'F', 8: 'C7',
           9: 'F', 10: 'Bb', 11: 'F', 12: 'C7', 13: 'Gm7', 14: 'C7b'}
TICK, TOCK = 1750.0, 1500.0


def _bidclock_score():
    """Plain data (so the fingerprint sees every note): per instrument a list
    of [Hz, start s, length s, amplitude, tau s] plus the timbres' numbers."""
    marimba, bass, wood, bell = [], [], [], []
    for bar in range(1, 15):
        t0 = (bar - 1) * BAR
        amp = 1.1 if bar >= 9 else 1.0
        for off, pitch, length in _MEL[bar]:
            tau = 0.30 if length <= 0.5 else 0.45
            note = [t0 + off * BEAT, length * BEAT, tau]
            marimba.append([_hz(pitch), note[0], note[1], amp, tau])
            if 9 <= bar <= 12:
                marimba.append([_hz(_THIRD[pitch]), note[0], note[1], 0.6, tau])
        for beat, pitch in enumerate(_BASS[_CHORDS[bar]]):
            bass.append([_hz(pitch), t0 + beat * BEAT, BEAT, 0.7, 0.18])
        if bar <= 8:
            ticks = [1.0, 3.0]
        elif bar <= 12:
            ticks = [0.0, 1.0, 2.0, 3.0]
        else:
            ticks = [k * 0.5 for k in range(8)]
        for k, off in enumerate(ticks):
            wood.append([TICK if k % 2 == 0 else TOCK, t0 + off * BEAT, 0.040, 0.2, 0.010])
    # bar 15, the "time's up" cue (28.000 s): two short C6 strikes, then a
    # soft F major bell chord over the bass F2 and a low marimba F3, ringing
    # to the end (the render's 50 ms fade-out closes it)
    cue, end = 14 * BAR, 15 * BAR
    bell.append([_hz('C6'), cue, 0.18, 0.9, 0.12])
    bell.append([_hz('C6'), cue + 0.20, 0.25, 0.9, 0.12])
    for pitch in ('F5', 'A5', 'C6'):
        bell.append([_hz(pitch), cue + 0.50, end - cue - 0.50, 0.9 / 3 * 1.6, 0.6])
    bass.append([_hz('F2'), cue + 0.50, end - cue - 0.50, 0.7, 0.18 * 3])
    marimba.append([_hz('F3'), cue + 0.50, end - cue - 0.50, 0.8, 0.6])
    r = lambda notes: [[round(v, 4) for v in n] for n in notes]
    return {
        'tracks': {'marimba': r(marimba), 'bass': r(bass), 'wood': r(wood), 'bell': r(bell)},
        'timbres': {
            # partial: [ratio, amplitude, decay divisor of tau (0 = the note's own envelope)]
            'marimba': {'partials': [[1, 1, 0], [3.93, 0.18, 4], [9.2, 0.05, 10]], 'attack': 0.003, 'release': 0.060},
            'bass': {'partials': [[1, 1, 0], [2, 0.35, 'x0.08'], [3, 0.12, 'x0.05']], 'attack': 0.004, 'release': 0.060},
            'wood': {'partials': [[1, 1, 0], [1.51, 0.5, 0]], 'attack': 0.001, 'release': 0.0},
            'bell': {'partials': [[1, 1, 0], [2.76, 0.5, 2], [5.4, 0.25, 3]], 'attack': 0.002, 'release': 0.060},
        },
    }


BIDCLOCK_SCORE = _bidclock_score()

SOUNDS = {
    # card-fan-1: 0.72 s, power centroid ~1.1 kHz; the riffle (card-shuffle) is 5-7 kHz
    'deal': {'src': 'card-fan-1', 'max': 0.9, 'target': CARD_DB, 'fade': 0.020},
    # three short placements with near-equal centroid (1.0-1.24 kHz) and crest (15-18 dB)
    'card-1': {'src': 'card-slide-1', 'max': 0.30, 'target': CARD_DB, 'fade': 0.015},
    'card-2': {'src': 'card-place-1', 'max': 0.30, 'target': CARD_DB, 'fade': 0.015},
    'card-3': {'src': 'card-slide-3', 'max': 0.25, 'target': CARD_DB, 'fade': 0.015},
    # card-shove-4 from its thump: the lowest centroid and crest of the shoves
    'trick': {'src': 'card-shove-4', 'start': 0.15, 'max': 0.45, 'target': CARD_DB, 'fade': 0.020},
    # the same sweep 2 semitones up with a quiet low chip tick on its peak;
    # normalized to the same RMS, so it differs without being louder
    'trick-ours': {'src': 'card-shove-4', 'start': 0.15, 'pitch': 2, 'max': 0.45,
                   'layers': [{'src': 'chip-lay-3', 'gain_db': -15, 'align': 'peak'}],
                   'target': CARD_DB, 'fade': 0.020},
    # soft sine notes with a little 2nd harmonic that dies first; tails end
    # ~28 dB down, under the fade
    'turn': {'synth': [[G5, 0.0, 0.08], [B5, 0.13, 0.10]], 'max': 0.45, 'target': CUE_DB, 'fade': 0.020},
    # the multi-click stack, its brightest edge rolled off
    'made': {'src': 'chips-stack-3', 'lowpass': 7000, 'max': 0.6, 'target': CUE_DB, 'fade': 0.015},
    # one chip clack a fourth lower and muffled: neutral, not a buzzer
    'set': {'src': 'chips-collide-2', 'pitch': -5, 'lowpass': 3500, 'max': 0.4, 'target': CUE_DB, 'fade': 0.015},
    # the neutral game end: a tie, or no team (a spectator); a soft rising C E G
    'gameend': {'synth': [[C5, 0.0, 0.25], [E5, 0.12, 0.25], [G5, 0.24, 0.30]], 'max': 1.1,
                'target': CUE_DB, 'fade': 0.020},
    # a won game (my team's final score above the other's; owner 2026-11-22): a
    # short brass fanfare, the trombone's pair, an original figure: two quick
    # pickups (G4, C5) into a held, open C major chord with a little vibrato
    'gameend-win': {'brass': {'length': 1.4, 'partials': 14, 'tilt': 0.5, 'cutoff': [1400, 3600], 'open': 0.035,
                              'close': 0.9, 'attack': 0.012, 'release': 0.12,
                              'notes': [[_hz('G4'), 0.00, 0.13, 0, None],
                                        [_hz('C5'), 0.15, 0.13, 0, None],
                                        [_hz('C5'), 0.30, 1.05, 0, [5.0, 10, 0.35]],
                                        [_hz('E5'), 0.30, 1.05, 0, [5.0, 10, 0.35]],
                                        [_hz('G5'), 0.30, 1.05, 0, [5.0, 10, 0.35]]]},
                    'brass_v': 1, 'max': 1.4, 'target': CUE_DB, 'fade': 0.120},
    # a lost game (my team's final score below the other's): the "sad trombone"
    # wah, wah, wah, waaah, a stock comedy cue, four chromatic steps down from
    # Bb3, the last held with a sag and vibrato; brass_v: bump when render_brass
    # changes
    'gameend-lose': {'brass': {'length': 2.5, 'partials': 14, 'tilt': 0.55, 'cutoff': [650, 2600], 'open': 0.07,
                               'close': 0.40, 'attack': 0.025, 'release': 0.07,
                               'notes': [[_hz('Bb3'), 0.00, 0.38, -15, None],
                                         [_hz('A3'), 0.44, 0.38, -15, None],
                                         [_hz('Ab3'), 0.88, 0.38, -15, None],
                                         [_hz('G3'), 1.32, 1.12, -45, [5.5, 22, 0.25]]]},
                     'brass_v': 1, 'max': 2.5, 'target': CUE_DB, 'fade': 0.080},
    # the one short bright snap (centroid ~3.6 kHz vs ~1.1 kHz for card-N)
    'overtrump': {'src': 'card-slide-4', 'max': 0.20, 'target': CARD_DB, 'fade': 0.010},
    # the bid clock's tune (30.000 s exactly, never trimmed); tune_v: bump
    # when render_tune changes (the fingerprint only sees recipe data)
    'bidclock': {'tune': BIDCLOCK_SCORE, 'tune_v': 1, 'length': 30.0, 'target': TUNE_DB, 'fade': 0.050},
}


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def sources(recipe):
    names = [recipe['src']] if 'src' in recipe else []
    return names + [layer['src'] for layer in recipe.get('layers', [])]


def fingerprint(recipe):
    """What an output depends on: the pipeline, the recipe and its source files."""
    data = {'pipeline': PIPELINE, 'recipe': recipe,
            'sources': {s: sha256(os.path.join(SRC, s + '.ogg')) for s in sources(recipe)}}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]


# --- build (macOS + numpy) ---------------------------------------------------

def read_wav(path, np):
    """16-bit PCM or 32-bit float WAV (incl. WAVE_FORMAT_EXTENSIBLE) → mono float64."""
    with open(path, 'rb') as f:
        b = f.read()
    i, fmt, data = 12, None, None
    while i + 8 <= len(b):
        cid, size = b[i:i + 4], struct.unpack('<I', b[i + 4:i + 8])[0]
        body = b[i + 8:i + 8 + size]
        if cid == b'fmt ':
            fmt = struct.unpack('<HHIIHH', body[:16])
        elif cid == b'data':
            data = body
        i += 8 + size + (size & 1)
    tag, channels, rate, _, _, bits = fmt
    if rate != SR:
        sys.exit(f'{path}: {rate} Hz, expected {SR}')
    if bits == 16:
        x = np.frombuffer(data, dtype='<i2').astype(np.float64) / 32768.0
    elif bits == 32:
        x = np.frombuffer(data, dtype='<f4').astype(np.float64)
    else:
        sys.exit(f'{path}: {bits}-bit samples (tag {tag})')
    return x.reshape(-1, channels).mean(axis=1)


def write_wav_float(path, x, np):
    data = x.astype('<f4').tobytes()
    fmt = struct.pack('<HHIIHH', 3, 1, SR, SR * 4, 4, 32)
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 4 + 8 + len(fmt) + 8 + len(data)) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<I', len(fmt)) + fmt)
        f.write(b'data' + struct.pack('<I', len(data)) + data)


def decode(path, tmp, np):
    wav = os.path.join(tmp, os.path.basename(path) + '.wav')
    subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16', path, wav], check=True)
    return read_wav(wav, np)


def frame_db(x, np, f=441):
    n = len(x) // f
    if n == 0:
        return np.array([-200.0])
    rms = np.sqrt((x[:n * f].reshape(n, f) ** 2).mean(axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-10))


def resample(x, ratio, np):
    """Band-limited (FFT) resample; ratio > 1 shortens and raises the pitch."""
    pad = np.concatenate([x, np.zeros(2048)])
    n, m = len(pad), int(round(len(pad) / ratio))
    X = np.fft.rfft(pad)
    Y = np.zeros(m // 2 + 1, dtype=complex)
    k = min(len(X), len(Y))
    Y[:k] = X[:k]
    return np.fft.irfft(Y, m) * (m / n)


def lowpass(x, fc, np, order=2):
    """Zero-phase Butterworth-shaped roll-off applied in the frequency domain."""
    pad = np.concatenate([x, np.zeros(4096)])
    X = np.fft.rfft(pad)
    f = np.fft.rfftfreq(len(pad), 1 / SR)
    return np.fft.irfft(X / np.sqrt(1 + (f / fc) ** (2 * order)), len(pad))[:len(x)]


def trim(x, np):
    r = frame_db(x, np)
    on = np.nonzero(r > TRIM_DB)[0]
    if len(on) == 0:
        sys.exit('a sound is silent after processing')
    a = max(0, on[0] * 441 - int(PREROLL * SR))
    return x[a:(on[-1] + 1) * 441]


def synth(notes, dur, np):
    t = np.arange(int(dur * SR)) / SR
    y = np.zeros_like(t)
    for f, t0, tau in notes:
        tt = np.maximum(t - t0, 0)
        on = t >= t0
        attack = np.where(tt < 0.006, 0.5 - 0.5 * np.cos(np.pi * tt / 0.006), 1.0)
        tone = (np.sin(2 * np.pi * f * tt)
                + 0.06 * np.exp(-tt / (tau / 2)) * np.sin(2 * np.pi * 2 * f * tt)
                + 0.015 * np.exp(-tt / (tau / 3)) * np.sin(2 * np.pi * 3 * f * tt))
        y += np.where(on, attack * np.exp(-tt / tau) * tone, 0.0)
    return y


def render_tune(score, length, np):
    """The bid clock score -> exactly round(length * SR) samples. Each note:
    raised-cosine attack, e^(-t/tau) body, partials that may decay faster
    (tau / divisor, or a fixed 'x<seconds>' time constant), raised-cosine
    release over its last `release` seconds."""
    n_total = int(round(length * SR))
    y = np.zeros(n_total)
    for inst, notes in score['tracks'].items():
        tim = score['timbres'][inst]
        for f, start, dur, amp, tau in notes:
            a = int(round(start * SR))
            n = min(int(round(dur * SR)), n_total - a)
            if n <= 0:
                continue
            t = np.arange(n) / SR
            tone = np.zeros(n)
            for ratio, pamp, dec in tim['partials']:
                part = pamp * np.sin(2 * np.pi * f * ratio * t)
                if isinstance(dec, str):
                    part *= np.exp(-t / float(dec[1:]))
                elif dec:
                    part *= np.exp(-t / (tau / dec))
                tone += part
            env = np.exp(-t / tau)
            at = tim['attack']
            env *= np.where(t < at, 0.5 - 0.5 * np.cos(np.pi * t / at), 1.0)
            rel = tim['release']
            if rel > 0:
                r0 = dur - rel
                env *= np.where(t > r0, 0.5 + 0.5 * np.cos(np.pi * np.clip((t - r0) / rel, 0, 1)), 1.0)
            y[a:a + n] += amp * env * tone
    return y


def render_brass(spec, np):
    """The defeat sound's muted trombone (owner 2026-11-22, "wah, wah, wah"):
    per note a brass-like stack of `partials` harmonics (n ** -tilt) through a
    cutoff that opens over `open` s and closes again (a plunger mute's
    "wah"), a raised-cosine attack and release, an optional pitch sag in
    cents over the note, and vibrato from `onset` s into the note."""
    n_total = int(round(spec['length'] * SR))
    y = np.zeros(n_total)
    lo, hi = spec['cutoff']
    for f0, start, dur, sag, vib in spec['notes']:
        a = int(round(start * SR))
        n = min(int(round(dur * SR)), n_total - a)
        t = np.arange(n) / SR
        cents = sag * (t / dur) ** 1.5
        if vib:
            rate, depth, onset = vib
            ramp = np.clip((t - onset) / 0.15, 0, 1)
            cents = cents + depth * ramp * np.sin(2 * np.pi * rate * np.maximum(t - onset, 0))
        f = f0 * 2 ** (cents / 1200)
        phase = 2 * np.pi * np.cumsum(f) / SR
        op = spec['open']
        shape = np.where(t < op, 0.5 - 0.5 * np.cos(np.pi * t / op), np.exp(-(t - op) / spec['close']))
        fc = lo + (hi - lo) * shape
        tone = np.zeros(n)
        for k in range(1, spec['partials'] + 1):
            tone += k ** -spec.get('tilt', 1.0) / (1 + (k * f / fc) ** 4) * np.sin(k * phase)
        at, rel = spec['attack'], spec['release']
        env = np.where(t < at, 0.5 - 0.5 * np.cos(np.pi * t / at), 1.0)
        env *= np.where(t > dur - rel, 0.5 + 0.5 * np.cos(np.pi * np.clip((t - (dur - rel)) / rel, 0, 1)), 1.0)
        y[a:a + n] += env * tone
    return y


def render_part(recipe, tmp, np, cache):
    if 'tune' in recipe:
        return render_tune(recipe['tune'], recipe['length'], np)
    if 'synth' in recipe:
        return synth(recipe['synth'], recipe['max'], np)
    if 'brass' in recipe:
        return render_brass(recipe['brass'], np)
    name = recipe['src']
    if name not in cache:
        cache[name] = decode(os.path.join(SRC, name + '.ogg'), tmp, np)
    x = cache[name]
    x = x - x.mean()
    x = x[int(recipe.get('start', 0) * SR):]
    if recipe.get('pitch'):
        x = resample(x, 2 ** (recipe['pitch'] / 12), np)
    if recipe.get('lowpass'):
        x = lowpass(x, recipe['lowpass'], np)
    return trim(x, np)


def active_rms_db(x, np):
    r = frame_db(x, np)
    act = r[r > r.max() - 30]
    return 10 * np.log10(np.mean(10 ** (act / 10)))


def render(recipe, tmp, np, cache):
    x = render_part(recipe, tmp, np, cache)
    for layer in recipe.get('layers', []):
        y = render_part(layer, tmp, np, cache) * 10 ** (layer['gain_db'] / 20)
        # put the layer's loudest frame on the base's loudest frame
        off = max(0, (int(np.argmax(frame_db(x, np))) - int(np.argmax(frame_db(y, np)))) * 441)
        if off + len(y) > len(x):
            x = np.concatenate([x, np.zeros(off + len(y) - len(x))])
        x[off:off + len(y)] += y
    if 'tune' in recipe:
        # never trimmed: its length is the bid clock's length
        n = int(round(recipe['length'] * SR))
        x = np.concatenate([x, np.zeros(max(0, n - len(x)))])[:n].copy()
    else:
        x = trim(x, np)[:int(recipe['max'] * SR)].copy()
    fi, fo = int(FADE_IN * SR), int(recipe['fade'] * SR)
    x[:fi] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(fi) / fi)
    x[-fo:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(fo) / fo)
    gain = recipe['target'] - active_rms_db(x, np)
    peak = 20 * np.log10(np.abs(x).max())
    gain = min(gain, PEAK_CAP_DB - peak)
    return x * 10 ** (gain / 20), gain


def measure(x, np):
    w = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return {
        'rms_dbfs': round(float(active_rms_db(x, np)), 1),
        'peak_dbfs': round(float(20 * np.log10(np.abs(x).max())), 1),
        'centroid_hz': int(round(float((w * f).sum() / w.sum()))),
    }


def strip_times(blob):
    """Zero the encode-time stamps in mvhd/tkhd/mdhd (all afconvert varies
    between runs), so a rebuild of unchanged recipes is byte-identical."""
    b = bytearray(blob)
    for box in (b'mvhd', b'tkhd', b'mdhd'):
        i = b.find(box)
        if i < 0 or b[i + 4] != 0:  # version 0: 32-bit creation + modification
            sys.exit(f'unexpected {box.decode()} box from afconvert')
        b[i + 8:i + 16] = bytes(8)
    return bytes(b)


def build(only=None):
    """Render every sound, or with `only` (a list of names) just those: the
    other outputs and their manifest entries are kept as they are."""
    import numpy as np
    if only:
        unknown = [n for n in only if n not in SOUNDS]
        if unknown:
            sys.exit(f'--only: not in SOUNDS: {", ".join(unknown)}')
        with open(MANIFEST) as f:
            old = json.load(f)
        kept = old.get('sounds', {})
        if old.get('pipeline') != PIPELINE:
            sys.exit('--only: the manifest is from another PIPELINE; run a full build')
    for d in OUT_DIRS:
        os.makedirs(d, exist_ok=True)
        if only:
            continue
        for old in os.listdir(d):
            if old.endswith('.m4a') and old[:-4] not in SOUNDS:
                os.remove(os.path.join(d, old))
    built = {}
    cache = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, recipe in SOUNDS.items():
            if only and name not in only:
                continue
            x, gain = render(recipe, tmp, np, cache)
            wav, m4a = os.path.join(tmp, name + '.wav'), os.path.join(tmp, name + '.m4a')
            # measure what players will hear, the AAC decoded again; AAC can
            # overshoot a peak-capped input by a few tenths of a dB, so pull
            # those back under the cap
            for _ in range(3):
                write_wav_float(wav, x, np)
                subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', '-q', '127', wav, m4a],
                               check=True)
                heard = decode(m4a, tmp, np)
                over = 20 * np.log10(np.abs(heard).max()) - (PEAK_CAP_DB - 0.05)
                if over <= 0:
                    break
                x = x * 10 ** (-over / 20)
                gain -= over
            with open(m4a, 'rb') as f:
                blob = strip_times(f.read())
            for d in OUT_DIRS:
                with open(os.path.join(d, name + '.m4a'), 'wb') as f:
                    f.write(blob)
            entry = {
                'source': '+'.join(s + '.ogg' for s in sources(recipe)) or 'synthesized',
                'gain_db': round(float(gain), 1),
                'duration': round(len(x) / SR, 3),
                **measure(heard, np),
                'bytes': len(blob),
                'sha256': hashlib.sha256(blob).hexdigest(),
                'recipe': fingerprint(recipe),
            }
            built[name] = entry
            print(f"{name + '.m4a':16s} {entry['duration']:.3f}s  rms {entry['rms_dbfs']:6.1f}  "
                  f"peak {entry['peak_dbfs']:5.1f}  centroid {entry['centroid_hz']:5d} Hz  "
                  f"gain {entry['gain_db']:+5.1f} dB  {entry['bytes']:6d} B  <- {entry['source']}")
    manifest = {'pipeline': PIPELINE, 'sounds': {}}
    for name in SOUNDS:
        entry = built.get(name) or (kept.get(name) if only else None)
        if entry:
            manifest['sounds'][name] = entry
    with open(MANIFEST, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    total = sum(e['bytes'] for e in manifest['sounds'].values())
    print(f'{len(built)} built, {len(manifest["sounds"])} sounds, {total} bytes per copy; '
          f'wrote {os.path.relpath(MANIFEST, ROOT)}')


# --- check (plain python) ----------------------------------------------------

def check():
    try:
        with open(MANIFEST) as f:
            manifest = json.load(f)
    except (OSError, ValueError) as e:
        print(f'{os.path.relpath(MANIFEST, ROOT)}: {e} (run npm run build:sounds)', file=sys.stderr)
        return 1
    problems = []
    listed = manifest.get('sounds', {})
    if manifest.get('pipeline') != PIPELINE:
        problems.append(f'manifest pipeline {manifest.get("pipeline")} != {PIPELINE}')
    for name in sorted(set(listed) ^ set(SOUNDS)):
        problems.append(f'{name}: in {"the manifest" if name in listed else "SOUNDS"} only')
    for name, recipe in SOUNDS.items():
        entry = listed.get(name)
        if not entry:
            continue
        if entry.get('recipe') != fingerprint(recipe):
            problems.append(f'{name}: recipe or source changed since the build')
        for d in OUT_DIRS:
            path = os.path.join(d, name + '.m4a')
            rel = os.path.relpath(path, ROOT)
            if not os.path.exists(path):
                problems.append(f'{rel}: missing')
            elif sha256(path) != entry.get('sha256'):
                problems.append(f'{rel}: differs from the manifest')
    for d in OUT_DIRS:
        for extra in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if extra.endswith('.m4a') and extra[:-4] not in SOUNDS:
                problems.append(f'{os.path.relpath(os.path.join(d, extra), ROOT)}: not in SOUNDS')
    for p in problems:
        print(f'stale: {p} (run npm run build:sounds)', file=sys.stderr)
    if not problems:
        print(f'{len(SOUNDS)} sounds match {os.path.relpath(MANIFEST, ROOT)}')
    return 1 if problems else 0


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--check' in args:
        sys.exit(check())
    only = None
    if '--only' in args:
        i = args.index('--only')
        if i + 1 >= len(args):
            sys.exit('--only needs a name (e.g. --only bidclock)')
        only = [n for n in args[i + 1].split(',') if n]
    build(only)
