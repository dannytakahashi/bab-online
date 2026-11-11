/**
 * The reset page (client/reset.html, src/reset/resetPage.js): the token
 * leaves the address bar at once and goes only into the POST body; the
 * fields are labelled; the result is announced and focused. The phone
 * gate: /reset is its own page whose entry never loads the gate or the
 * app (so a phone gets the form), while the app page stays gated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderResetPage, tokenFromHash, RESET_API, COPY } from './resetPage.js';
import { decideBoot } from '../boot/deviceGate.js';
import { readClientFile } from '../testing/files.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';

function fakeWin(hash = `#${TOKEN}`) {
  const loc = { hash, pathname: '/reset', search: '' };
  return {
    location: loc,
    history: {
      replaceState: vi.fn((_s, _t, url) => {
        loc.hash = '';
        loc.href = url;
      }),
    },
  };
}

function reply(body) {
  return vi.fn(async () => ({ json: async () => body }));
}

let root;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('main');
  document.body.appendChild(root);
});

async function submit(form) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function fill(pw, confirm = pw) {
  document.getElementById('reset-password').value = pw;
  document.getElementById('reset-confirm').value = confirm;
}

describe('the reset page', () => {
  it('drops the token from the address bar and sends it only in the JSON body', async () => {
    const win = fakeWin();
    const fetchImpl = reply({ ok: true, message: COPY.success });
    const { form } = renderResetPage({ root, win, fetchImpl });
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/reset');
    expect(win.location.hash).toBe('');
    fill('new-pass');
    await submit(form);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(RESET_API);
    expect(url).not.toContain(TOKEN);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN, password: 'new-pass' });
  });

  it('labelled fields, the new password focused first, a submit button', () => {
    renderResetPage({ root, win: fakeWin(), fetchImpl: reply({}) });
    for (const id of ['reset-password', 'reset-confirm']) {
      const input = document.getElementById(id);
      expect(input.type).toBe('password');
      expect(input.getAttribute('autocomplete')).toBe('new-password');
      expect(document.querySelector(`label[for="${id}"]`).textContent.length).toBeGreaterThan(3);
    }
    expect(document.activeElement.id).toBe('reset-password');
    expect(root.querySelector('button[type="submit"]').textContent).toBe('Set new password');
    expect(root.querySelector('h1').textContent).toBe(COPY.title);
  });

  it('checks the two fields and the 1-100 rule before sending', async () => {
    const fetchImpl = reply({ ok: true });
    const { form, status } = renderResetPage({ root, win: fakeWin(), fetchImpl });
    fill('');
    await submit(form);
    expect(status.textContent).toBe(COPY.empty);
    fill('abc', 'abd');
    await submit(form);
    expect(status.textContent).toBe(COPY.mismatch);
    expect(status.getAttribute('role')).toBe('alert');
    expect(document.activeElement.id).toBe('reset-confirm');
    fill('p'.repeat(101));
    await submit(form);
    expect(status.textContent).toBe(COPY.tooLong);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('success: the form goes, the message is announced and focused, a link to the site', async () => {
    const { form, status } = renderResetPage({ root, win: fakeWin(), fetchImpl: reply({ ok: true, message: COPY.success }) });
    fill('new-pass');
    await submit(form);
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('.reset__lede')).toBeNull(); // the "pick a password" line goes with the form
    expect(status.textContent).toBe('Password changed. Sign in with your new password on the app or the website.');
    expect(status.classList.contains('is-success')).toBe(true);
    expect(document.activeElement).toBe(status);
    expect(root.querySelector('a[href="/"]').textContent).toBe('Go to BAB Online');
  });

  it('a used or expired link: the server\'s one message, no form left', async () => {
    const message = 'This reset link is not valid any more.';
    const { form, status } = renderResetPage({ root, win: fakeWin(), fetchImpl: reply({ ok: false, error: 'invalid_link', message }) });
    fill('x');
    await submit(form);
    expect(root.querySelector('form')).toBeNull();
    expect(status.textContent).toBe(message);
    expect(status.getAttribute('role')).toBe('alert');
  });

  it('a network failure keeps the form for another try', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); });
    const { form, status } = renderResetPage({ root, win: fakeWin(), fetchImpl });
    fill('x');
    await submit(form);
    expect(status.textContent).toBe(COPY.network);
    expect(root.querySelector('form')).toBe(form);
    expect(root.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  it('no token in the link: says so, no form', () => {
    const win = fakeWin('');
    const { form, status } = renderResetPage({ root, win, fetchImpl: reply({}) });
    expect(form).toBeNull();
    expect(status.textContent).toBe(COPY.noToken);
    expect(win.history.replaceState).not.toHaveBeenCalled();
    expect(tokenFromHash('#')).toBeNull();
    expect(tokenFromHash('#abc')).toBe('abc');
  });
});

describe('phone gate: /reset passes it, the app page does not', () => {
  const iPhone = {
    matchMedia: (q) => ({ matches: /pointer: coarse|hover: none/.test(q) && !/min-device|hover: hover|pointer: fine|pointer: none/.test(q), media: q }),
    screen: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
  };

  it('the app page (/) still gates an iPhone', () => {
    expect(decideBoot({ env: iPhone, search: '', storage: null })).toMatchObject({ gate: true, reason: 'phone' });
  });

  it('reset.html loads only its own entry: no boot gate, no app, no app stylesheets', () => {
    const html = readClientFile('reset.html');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(['/src/reset/resetEntry.js']);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(sheets).toEqual(['/styles/reset.css']);
    const entry = readClientFile('src/reset/resetEntry.js');
    const page = readClientFile('src/reset/resetPage.js');
    for (const src of [entry, page]) {
      const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
      for (const i of imports) expect(i).not.toMatch(/boot|main\.js|vendor|socket|phaser/i);
    }
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">/);
  });

  it('on a phone the page renders the form (nothing gates it)', () => {
    const win = { ...fakeWin(), matchMedia: iPhone.matchMedia, screen: iPhone.screen, navigator: { userAgent: iPhone.userAgent } };
    renderResetPage({ root, win, fetchImpl: reply({}) });
    expect(document.getElementById('reset-password')).toBeTruthy();
    expect(document.querySelector('.gate')).toBeNull();
  });
});
