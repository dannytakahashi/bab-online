#!/usr/bin/env python3
"""
The web cards' index font (client/assets/fonts/BABCardIndex.woff2): Arvo Bold
(Anton Koovit, SIL OFL 1.1, Reserved Font Name "Arvo") subset to the glyphs
the card faces draw, renamed "BAB Card Index" (a subset is a Modified Version,
which the OFL forbids to carry the reserved name), as WOFF2.

  python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools==4.55.3 brotli==1.1.0
  /tmp/fontvenv/bin/python scripts/build-card-font.py path/to/Arvo-Bold.ttf

Arvo-Bold.ttf comes from https://github.com/google/fonts/tree/main/ofl/arvo
(version 1.006). The script also writes client/src/testing/cardFontMetrics.json,
the subset's glyph metrics that cardFaces.test.js measures the index with
(jsdom has no canvas), so the font and the tests stay in step.
"""
import json
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
OUT = os.path.join(ROOT, 'client', 'assets', 'fonts', 'BABCardIndex.woff2')
METRICS = os.path.join(ROOT, 'client', 'src', 'testing', 'cardFontMetrics.json')

# Every character the card faces draw in this font: the ranks (the "1" of
# the 10 is a system sans "I", drawn in the UI font) and the jokers' HI / LO
TEXT = 'A234567890JQKHILO'
FAMILY = 'BAB Card Index'
PS_NAME = 'BABCardIndex-Bold'


def rename(font):
    name = font['name']
    copyright_ = name.getDebugName(0)
    version = name.getDebugName(5)
    name.names = []
    entries = {
        0: copyright_,
        1: FAMILY,
        2: 'Bold',
        3: f'{PS_NAME};subset of Arvo Bold 1.006',
        4: f'{FAMILY} Bold',
        5: version,
        6: PS_NAME,
        10: 'A subset of Arvo Bold by Anton Koovit (Modified Version under the SIL OFL 1.1) for the BAB Online card faces.',
        13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
        14: 'https://openfontlicense.org',
    }
    for name_id, value in entries.items():
        name.setName(value, name_id, 3, 1, 0x409)


def metrics(font):
    cmap = font.getBestCmap()
    glyf = font['glyf']
    hmtx = font['hmtx']
    upem = font['head'].unitsPerEm
    glyphs = {}
    for ch in TEXT:
        gname = cmap[ord(ch)]
        g = glyf[gname]
        g.recalcBounds(glyf)
        glyphs[ch] = {'advance': hmtx[gname][0], 'xMin': g.xMin, 'xMax': g.xMax, 'yMin': g.yMin, 'yMax': g.yMax}
    kern = {}
    if 'kern' in font:
        for table in font['kern'].kernTables:
            for (a, b), v in table.kernTable.items():
                ca = next((c for c in TEXT if cmap[ord(c)] == a), None)
                cb = next((c for c in TEXT if cmap[ord(c)] == b), None)
                if ca and cb and v:
                    kern[ca + cb] = v
    return {'family': FAMILY, 'unitsPerEm': upem, 'glyphs': glyphs, 'kern': kern}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    font = subset.load_font(sys.argv[1], options)
    sub = subset.Subsetter(options)
    sub.populate(text=TEXT)
    sub.subset(font)
    rename(font)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subset.save_font(font, OUT, options)
    with open(METRICS, 'w') as f:
        json.dump(metrics(TTFont(OUT)), f, indent=1, sort_keys=True)
        f.write('\n')
    print(f'{os.path.relpath(OUT, ROOT)}: {os.path.getsize(OUT)} bytes')
    print(f'{os.path.relpath(METRICS, ROOT)}')


if __name__ == '__main__':
    main()
