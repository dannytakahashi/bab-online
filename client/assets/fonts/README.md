# BAB Card Index (the web cards' rank font)

`BABCardIndex.woff2` is a subset of **Arvo Bold** (version 1.006) by
Anton Koovit, licensed under the SIL Open Font License 1.1 (`OFL.txt`,
with the original copyright notice and the Reserved Font Name "Arvo").

It keeps only the glyphs the card faces draw (`A 2-9 0 J Q K` and `H I L O`
for the jokers' HI / LO). A subset is a Modified Version under the OFL, and
the OFL forbids a Modified Version to use a Reserved Font Name, so the
font's name table calls it "BAB Card Index" (family), `BABCardIndex-Bold`
(PostScript). Its copyright string and licence fields are kept.

The web client loads it with the FontFace API (`client/src/phaser/cards/cardFont.js`);
the build emits it as a hashed `/dist/assets` file (the CSP's `font-src 'self'`).

## Regenerate

Arvo-Bold.ttf comes from https://github.com/google/fonts/tree/main/ofl/arvo.

```bash
python3 -m venv /tmp/fontvenv
/tmp/fontvenv/bin/pip install fonttools==4.55.3 brotli==1.1.0
/tmp/fontvenv/bin/python scripts/build-card-font.py path/to/Arvo-Bold.ttf
```

The script writes this woff2 and `client/src/testing/cardFontMetrics.json`
(the glyph metrics `cardFaces.test.js` draws the index with).
