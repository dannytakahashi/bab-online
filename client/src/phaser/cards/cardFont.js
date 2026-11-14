/**
 * The card index font (owner, 2026-11-13: "Feedback is arvo"): the ranks
 * and the jokers' HI / LO are drawn in "BAB Card Index", a subset of Arvo
 * Bold (client/assets/fonts: the woff2, its OFL licence and README; built
 * by scripts/build-card-font.py), with the system UI stack as the fallback.
 *
 * Loaded with the FontFace API (font-src 'self': the file is a hashed
 * /dist/assets file of the build). The load starts as soon as anything
 * imports the card faces' drawing (CardAtlas.js calls loadCardFont; main.js
 * starts it when the app chunk runs, well before a table). A canvas draws
 * with whatever face is ready at that moment, so a card drawn before the
 * font arrives is in the fallback: CardAtlas and drawSlotFaces listen
 * (onCardFontReady) and draw their faces again once it is ready. A font
 * that fails to load (or no FontFace API: jsdom) leaves the fallback.
 */
import fontUrl from '../../../assets/fonts/BABCardIndex.woff2?url';
import { FONT_UI } from '../../ui/tokens.js';

export const CARD_FONT_FAMILY = 'BAB Card Index';
/** The canvas font stack for the ranks and HI / LO: the bundled face, then the system UI font. */
export const CARD_FONT = `"${CARD_FONT_FAMILY}", ${FONT_UI}`;
export const CARD_FONT_URL = fontUrl;

let ready = false;
let loading = null;
const listeners = new Set();

/** The bundled face is loaded and in document.fonts: a canvas draws with it now. */
export const isCardFontReady = () => ready;

/**
 * Call `fn` once when the font becomes ready (never when it already is:
 * check isCardFontReady first). Returns an unsubscribe.
 */
export function onCardFontReady(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function markReady() {
  if (ready) return;
  ready = true;
  const fns = [...listeners];
  listeners.clear();
  for (const fn of fns) {
    try {
      fn();
    } catch (err) {
      console.warn('card font listener failed', err);
    }
  }
}

/**
 * Start loading the font (once; later calls return the same promise).
 * Resolves true when it is ready, false when it cannot load (no FontFace
 * API, a failed fetch): the cards then keep the system fallback.
 * @param {Object} [opts] - tests inject a FontFace and a font set
 */
export function loadCardFont({ FontFaceImpl = globalThis.FontFace, fonts = globalThis.document?.fonts, url = CARD_FONT_URL } = {}) {
  if (loading) return loading;
  if (typeof FontFaceImpl !== 'function' || !fonts || typeof fonts.add !== 'function') {
    loading = Promise.resolve(false);
    return loading;
  }
  let face;
  try {
    face = new FontFaceImpl(CARD_FONT_FAMILY, `url("${url}") format("woff2")`, { weight: '700', style: 'normal', display: 'block' });
  } catch (err) {
    console.warn('card font: FontFace failed', err);
    loading = Promise.resolve(false);
    return loading;
  }
  loading = Promise.resolve()
    .then(() => face.load())
    .then((loaded) => {
      fonts.add(loaded || face);
      markReady();
      return true;
    })
    .catch((err) => {
      console.warn('card font did not load; the cards use the system font', err);
      return false;
    });
  return loading;
}

/** Tests only: forget the load and the listeners. */
export function resetCardFontForTests() {
  ready = false;
  loading = null;
  listeners.clear();
}
