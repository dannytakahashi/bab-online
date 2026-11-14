/**
 * The card index font's loader (cardFont.js): one FontFace load of the
 * bundled woff2, added to the page's fonts; listeners hear once when it is
 * ready; no FontFace API (or a failed fetch) keeps the system fallback.
 * Drawing never waits for it: the atlas and the draw slots draw with the
 * fallback and redraw once when it lands (CardAtlas, drawSlotFaces).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CARD_FONT, CARD_FONT_FAMILY, CARD_FONT_URL, loadCardFont, isCardFontReady, onCardFontReady, resetCardFontForTests,
} from './cardFont.js';
import { FONT_UI } from '../../ui/tokens.js';

function fakeFont() {
  const added = [];
  const made = [];
  let settle;
  const fetched = new Promise((res, rej) => { settle = (ok) => (ok ? res() : rej(new Error('404'))); });
  class FakeFontFace {
    constructor(family, src, desc) {
      Object.assign(this, { family, src, desc });
      made.push(this);
    }
    load() { return fetched.then(() => this); }
  }
  return { opts: { FontFaceImpl: FakeFontFace, fonts: { add: (f) => added.push(f) } }, added, made, settle: (ok) => settle(ok) };
}

describe('cardFont', () => {
  beforeEach(() => resetCardFontForTests());

  it('the face: "BAB Card Index", the bundled woff2 (a same-origin url: font-src \'self\'), bold; the stack falls back to the UI font', () => {
    expect(CARD_FONT).toBe(`"${CARD_FONT_FAMILY}", ${FONT_UI}`);
    expect(CARD_FONT_URL).toMatch(/^\/[^/].*BABCardIndex[^/]*\.woff2$/);
  });

  it('loads once, adds the face, then tells every listener once', async () => {
    const f = fakeFont();
    const heard = vi.fn();
    onCardFontReady(heard);
    const a = loadCardFont(f.opts);
    expect(loadCardFont(f.opts)).toBe(a);
    expect(f.made).toHaveLength(1);
    expect(f.made[0]).toMatchObject({ family: 'BAB Card Index', desc: { weight: '700', style: 'normal' } });
    expect(isCardFontReady()).toBe(false);
    f.settle(true);
    expect(await a).toBe(true);
    expect(isCardFontReady()).toBe(true);
    expect(f.added).toEqual([f.made[0]]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('no FontFace API (jsdom, an old browser) or a failed fetch: false, the fallback stays, no listener fires', async () => {
    const heard = vi.fn();
    onCardFontReady(heard);
    expect(await loadCardFont({ FontFaceImpl: undefined, fonts: { add() {} } })).toBe(false);
    resetCardFontForTests();
    onCardFontReady(heard);
    const f = fakeFont();
    const p = loadCardFont(f.opts);
    f.settle(false);
    expect(await p).toBe(false);
    expect(isCardFontReady()).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

});
