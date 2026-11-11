/**
 * The reset page (/reset#<token>): a player who got a one-time link by
 * text sets a new password here. Standalone (client/reset.html, its own
 * small entry): no phone gate, no game bundle, no socket; the kit's
 * element factories and the design tokens only.
 *
 * The token is read from the URL fragment and dropped from the address bar
 * at once (history.replaceState), then sent only in the POST body to
 * /api/password-reset (server/routes/passwordReset.js). The password rule
 * is sign-up's: 1-100 characters; the two fields must match.
 *
 * Accessible: labelled fields, one status line (role=status, polite;
 * errors role=alert), focus moves to the message after a result, the
 * button says when it is working.
 */
// The kit's element factories, as their own copy for this page: the
// ?page=reset query makes it a separate module in the build, so the boot
// entry (which also uses them, for the phone gate) keeps its single
// chunk and this page never loads the boot entry (vite.config.js checks)
import { el, createButton } from '../ui/kit/elements.js?page=reset';

export const RESET_API = '/api/password-reset';

export const COPY = {
  title: 'Choose a new password',
  lede: 'Pick something you will remember. Every device that was signed in will need it.',
  noToken: 'This link is incomplete. Open the whole link you were sent, or ask for a new one.',
  mismatch: 'The two passwords do not match.',
  empty: 'Type a new password.',
  tooLong: 'Use at most 100 characters.',
  working: 'Saving...',
  network: 'Could not reach the server. Check your connection and try again.',
  success: 'Password changed. Sign in with your new password on the app or the website.',
};

/** The token from a location hash (the fragment without its '#'), or null. */
export function tokenFromHash(hash) {
  const t = String(hash || '').replace(/^#/, '').trim();
  return t ? t : null;
}

function field({ id, label, autocomplete }) {
  const input = el('input', {
    className: 'kit-input',
    attrs: { id, type: 'password', name: id, autocomplete, autocapitalize: 'none', spellcheck: 'false', maxlength: '100', required: true },
  });
  const wrap = el('div', {
    className: 'reset__field',
    children: [el('label', { className: 'reset__label', attrs: { for: id }, text: label }), input],
  });
  return { wrap, input };
}

/**
 * Render the page into `root`.
 * @param {Object} o
 * @param {HTMLElement} o.root
 * @param {Window} [o.win=window]
 * @param {Function} [o.fetchImpl=fetch]
 * @returns {{form: HTMLFormElement|null, status: HTMLElement, alert: HTMLElement|null}}
 *          status: role=status (progress, success, and the final "link not
 *          valid" message, focused); alert: role=alert for the errors that
 *          keep the form. Both exist from the start: a live region added or
 *          re-roled later is often not announced.
 */
export function renderResetPage({ root, win = window, fetchImpl = (...a) => win.fetch(...a) }) {
  const token = tokenFromHash(win.location.hash);
  // Out of the address bar (and this history entry) right away
  if (token) {
    try { win.history.replaceState(null, '', win.location.pathname + win.location.search); } catch { /* old browser */ }
  }

  root.replaceChildren();
  const card = el('section', { className: 'reset__card kit-panel kit-elev-3', attrs: { 'aria-labelledby': 'reset-title' } });
  card.appendChild(el('img', { className: 'reset__icon', attrs: { src: '/assets/icons/icon-192.png', alt: '', width: '72', height: '72' } }));
  card.appendChild(el('h1', { className: 'reset__title', attrs: { id: 'reset-title', tabindex: '-1' }, text: COPY.title }));
  const status = el('p', { className: 'reset__status', attrs: { id: 'reset-status', role: 'status', tabindex: '-1' } });

  if (!token) {
    status.textContent = COPY.noToken;
    status.classList.add('is-error');
    card.appendChild(status);
    root.appendChild(card);
    return { form: null, status, alert: null };
  }

  const lede = el('p', { className: 'reset__lede', text: COPY.lede });
  card.appendChild(lede);
  const form = el('form', { className: 'reset__form', attrs: { novalidate: true, 'aria-describedby': 'reset-status reset-alert' } });
  const alertLine = el('p', { className: 'reset__status is-error', attrs: { id: 'reset-alert', role: 'alert' } });
  const pw = field({ id: 'reset-password', label: 'New password', autocomplete: 'new-password' });
  const again = field({ id: 'reset-confirm', label: 'Type it again', autocomplete: 'new-password' });
  const submit = createButton({ label: 'Set new password', variant: 'primary', type: 'submit', className: 'reset__submit' });
  form.append(pw.wrap, again.wrap, submit, status, alertLine);
  card.appendChild(form);
  root.appendChild(card);

  // Errors that keep the form: the alert line. Everything else, and the
  // final "not valid" message (focused, so it is read): the status line
  const say = (text, kind = 'info', { final = false } = {}) => {
    const inAlert = kind === 'error' && !final;
    alertLine.textContent = inAlert ? text : '';
    status.textContent = inAlert ? '' : text;
    status.classList.toggle('is-error', kind === 'error' && final);
    status.classList.toggle('is-success', kind === 'success');
  };

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const password = pw.input.value;
    if (!password) { say(COPY.empty, 'error'); pw.input.focus(); return; }
    if (password.length > 100) { say(COPY.tooLong, 'error'); pw.input.focus(); return; }
    if (password !== again.input.value) { say(COPY.mismatch, 'error'); again.input.focus(); return; }

    busy = true;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    say(COPY.working);
    let body = null;
    try {
      const res = await fetchImpl(RESET_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      body = await res.json().catch(() => null);
    } catch {
      body = null;
    }
    busy = false;
    submit.disabled = false;
    submit.removeAttribute('aria-busy');

    if (body && body.ok) {
      // Done: the form goes (the link is used); the message stays, focused
      pw.input.value = '';
      again.input.value = '';
      lede.remove();
      form.replaceWith(status);
      say(body.message || COPY.success, 'success');
      card.appendChild(el('a', { className: 'kit-btn kit-btn--secondary reset__home', attrs: { href: '/' }, text: 'Go to BAB Online' }));
      status.focus();
      return;
    }
    if (body && body.error === 'invalid_link') {
      lede.remove();
      form.replaceWith(status);
      say(body.message, 'error', { final: true });
      status.focus();
      return;
    }
    say((body && body.message) || COPY.network, 'error');
    (body && body.error === 'invalid_password' ? pw.input : submit).focus();
  });

  pw.input.focus();
  return { form, status, alert: alertLine };
}
