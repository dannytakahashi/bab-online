/**
 * The phone gate's screen (web roadmap item 19): the app icon, the name,
 * one line, the primary action and a small "Continue in browser anyway".
 * Kit classes and tokens only (styles/gate.css; screenStyles.test.js holds
 * this file to no hex and no inline style).
 *
 * - ios: "Get the iPhone app", a plain https link to the App Store page
 *   (iOS opens the App Store app; the page offers "Open" when installed).
 *   Not an imitation of Apple's badge artwork: a kit primary button.
 * - other (Android and other phones, no app): "made for bigger screens",
 *   no store button.
 *
 * While the gate is up the page's viewport covers the notch
 * (viewport-fit=cover, safe-area padding in gate.css); the original
 * viewport comes back when it closes, so the app sees today's page.
 */
import { el } from '../ui/kit/elements.js';
import { APP_STORE_URL, VARIANT } from './deviceGate.js';

export const GATE_ID = 'phone-gate';
const ICON_SRC = 'assets/app-icon.webp';

const COPY = {
  [VARIANT.IOS]: {
    lede: 'Back Alley Bridge plays best in the BAB Online app for iPhone.',
    note: 'Already have it? The App Store will offer to open it.',
  },
  [VARIANT.OTHER]: {
    lede: 'BAB Online is made for bigger screens.',
    note: 'Play on a computer or tablet.',
  },
};

/** Add viewport-fit=cover to the viewport meta; returns a function that restores it. */
function coverViewport(doc) {
  const meta = doc.querySelector('meta[name="viewport"]');
  if (!meta) return () => {};
  const original = meta.getAttribute('content') || '';
  if (!/viewport-fit/.test(original)) meta.setAttribute('content', `${original}, viewport-fit=cover`);
  return () => meta.setAttribute('content', original);
}

/**
 * Show the gate.
 * @param {Object} o
 * @param {'ios'|'other'} o.variant
 * @param {Function} o.onContinue - "Continue in browser anyway"; may return
 *   a promise (the app loading): the gate stays, busy, until it settles,
 *   and comes back usable if it rejects.
 * @param {Document} [o.doc]
 * @returns {{root: HTMLElement, close: Function}}
 */
export function showGate({ variant, onContinue, doc = document }) {
  const copy = COPY[variant] || COPY[VARIANT.OTHER];
  const restoreViewport = coverViewport(doc);

  const children = [
    el('img', {
      className: 'gate__icon',
      attrs: { src: ICON_SRC, alt: '', width: 96, height: 96, decoding: 'async' },
    }),
    el('h1', { className: 'gate__title', attrs: { id: 'phone-gate-title' }, text: 'BAB Online' }),
    el('p', { className: 'gate__lede', text: copy.lede }),
  ];
  if (variant === VARIANT.IOS) {
    children.push(el('a', {
      className: 'kit-btn kit-btn--primary kit-btn--lg gate__store',
      attrs: { href: APP_STORE_URL, 'data-gate': 'store' },
      text: 'Get the iPhone app',
    }));
  }
  children.push(el('p', { className: 'gate__note', text: copy.note }));

  const status = el('p', { className: 'gate__status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const continueBtn = el('button', {
    className: 'gate__continue',
    attrs: { type: 'button', 'data-gate': 'continue' },
    text: 'Continue in browser anyway',
  });
  children.push(continueBtn, status);

  const card = el('div', { className: 'gate__card', children });
  const root = el('main', {
    className: `gate gate--${variant}`,
    attrs: { id: GATE_ID, 'aria-labelledby': 'phone-gate-title', 'data-variant': variant },
    children: [card],
  });
  doc.body.appendChild(root);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.remove();
    restoreViewport();
  };

  continueBtn.addEventListener('click', () => {
    if (continueBtn.disabled) return;
    continueBtn.disabled = true;
    continueBtn.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading BAB Online…';
    Promise.resolve()
      .then(() => onContinue())
      .then(close, () => {
        continueBtn.disabled = false;
        continueBtn.removeAttribute('aria-busy');
        status.textContent = "Couldn't load the game. Check your connection and try again.";
      });
  });

  return { root, close };
}
