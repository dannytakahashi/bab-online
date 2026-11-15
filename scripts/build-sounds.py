#!/usr/bin/env python3
"""
The table's sound effects: client/assets/sounds/*.m4a (web) and the same
files in iOSClient/BABOnline/Resources/Sounds/ (bundled by the synchronized
BABOnline folder, flat at the bundle root). The names below are the contract
the web and iOS players use.

  npm run build:sounds    rebuild both copies and sounds-src/sounds.json
  npm run sounds:check    exit 1 when an output is missing, edited, or older
                          than its recipe or source (no decoding: plain python)

Sources are the few Kenney "Casino Audio" 1.1 samples (CC0) committed in
sounds-src/kenney-casino-audio/; the chimes are synthesized here. Each sound:
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

# G5, B5 (a major third) for the turn cue; C5 E5 G5 for game end, a lower
# register so the two are not confused
G5, B5, C5, E5 = 783.99, 987.77, 523.25, 659.26

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
    'gameend': {'synth': [[C5, 0.0, 0.25], [E5, 0.12, 0.25], [G5, 0.24, 0.30]], 'max': 1.1,
                'target': CUE_DB, 'fade': 0.020},
    # the one short bright snap (centroid ~3.6 kHz vs ~1.1 kHz for card-N)
    'overtrump': {'src': 'card-slide-4', 'max': 0.20, 'target': CARD_DB, 'fade': 0.010},
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


def render_part(recipe, tmp, np, cache):
    if 'synth' in recipe:
        return synth(recipe['synth'], recipe['max'], np)
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


def build():
    import numpy as np
    for d in OUT_DIRS:
        os.makedirs(d, exist_ok=True)
        for old in os.listdir(d):
            if old.endswith('.m4a') and old[:-4] not in SOUNDS:
                os.remove(os.path.join(d, old))
    manifest = {'pipeline': PIPELINE, 'sounds': {}}
    cache = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, recipe in SOUNDS.items():
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
            manifest['sounds'][name] = entry
            print(f"{name + '.m4a':16s} {entry['duration']:.3f}s  rms {entry['rms_dbfs']:6.1f}  "
                  f"peak {entry['peak_dbfs']:5.1f}  centroid {entry['centroid_hz']:5d} Hz  "
                  f"gain {entry['gain_db']:+5.1f} dB  {entry['bytes']:6d} B  <- {entry['source']}")
    with open(MANIFEST, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    total = sum(e['bytes'] for e in manifest['sounds'].values())
    print(f'{len(SOUNDS)} sounds, {total} bytes per copy; wrote {os.path.relpath(MANIFEST, ROOT)}')


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
    if '--check' in sys.argv[1:]:
        sys.exit(check())
    build()
