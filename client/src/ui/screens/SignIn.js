/**
 * Sign-in screen component.
 *
 * Kit classes and tokens (styles/screens.css, item 18b): a card at most
 * 440 px wide, labelled 16 px inputs (no iOS zoom), 44 px buttons. The
 * splash line animates once (none under reduced motion); messages go to
 * the one toast queue.
 */
import { el, createButton, createPanel } from '../kit/index.js';
import { showError } from '../components/Toast.js';

/** A labelled kit input (forms on the auth screens). */
export function authField({ id, label, type = 'text', name, autocomplete, autocapitalize = null, value = '' }) {
  const input = el('input', {
    className: 'kit-input',
    attrs: { id, type, name, autocomplete, autocapitalize, spellcheck: type === 'text' ? 'false' : null },
  });
  input.value = value;
  const field = el('div', {
    className: 'field',
    children: [el('label', { className: 'field__label', attrs: { for: id }, text: label }), input],
  });
  return { field, input };
}

/** The page behind the auth card (the night card room, no animation). */
export function authVignette(id) {
  return el('div', { className: 'vignette auth-vignette', attrs: { id, 'aria-hidden': 'true' } });
}

/** The logo, sized as before (26 vw). */
export function authLogo() {
  return el('img', { className: 'auth-logo', attrs: { src: 'assets/logo.png', alt: 'BAB Online' } });
}

export const SPLASH_PHRASES = [
  'he sends a boy!',
  'i got my bid...',
  'out of boolats!',
  'heartless!',
  'this one is mandatory.',
  'i bid on that one.',
  'you need to get my one.',
  'surely...',
  'no guts, no glory!',
  'the locusts descend!',
  'eat fast, kick ass!',
  "5...what's trump?",
  "this is a man's game!",
  'you should be dealing already!',
  "i did it frank's way, that bastard!",
  'alls we gotta do...',
  'coulda bored!',
];

/**
 * Create the sign-in screen.
 *
 * @param {Object} options - Screen options
 * @param {Function} options.onSignIn - Called with { username, password }
 * @param {Function} options.onCreateAccount - Called to show registration
 * @returns {Object} { container, destroy }
 */
export function createSignInScreen({ onSignIn, onCreateAccount }) {
  // Vignette background
  const vignette = authVignette('sign-in-vignette');

  // Container
  const container = el('main', { className: 'auth-screen', attrs: { id: 'sign-in-container' } });

  // Logo with the splash text (Minecraft-style), which plays in once
  const logoWrapper = el('div', { className: 'auth-logo-wrap' });
  logoWrapper.appendChild(authLogo());
  const splash = el('span', {
    className: 'auth-splash',
    attrs: { 'aria-hidden': 'true' },
    text: SPLASH_PHRASES[Math.floor(Math.random() * SPLASH_PHRASES.length)],
  });
  logoWrapper.appendChild(splash);
  container.appendChild(logoWrapper);

  const form = createPanel({ tag: 'form', elevation: 3, className: 'auth-card' });
  form.setAttribute('aria-label', 'Sign in');
  form.noValidate = true;
  form.addEventListener('submit', (e) => e.preventDefault());

  // Username / password
  const { field: userField, input: usernameInput } = authField({
    id: 'signInUsername', label: 'Username', name: 'username', autocomplete: 'username', autocapitalize: 'none',
  });
  const { field: passField, input: passwordInput } = authField({
    id: 'signInPassword', label: 'Password', type: 'password', name: 'password', autocomplete: 'current-password',
  });
  form.appendChild(userField);
  form.appendChild(passField);

  // Sign in button
  const signInButton = createButton({ label: 'Sign In', variant: 'primary' });
  form.appendChild(signInButton);

  // Divider
  form.appendChild(el('div', { className: 'auth-divider', text: 'New user?' }));

  // Create account button
  const createAccountButton = createButton({ label: 'Create Account', variant: 'secondary' });
  form.appendChild(createAccountButton);
  container.appendChild(form);

  // Event handlers
  const handleSignIn = () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
      showError('Please enter both a username and a password.');
      (username ? passwordInput : usernameInput).focus();
      return;
    }

    onSignIn({ username, password });
  };

  signInButton.onclick = handleSignIn;

  createAccountButton.onclick = () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    onCreateAccount({ username, password });
  };

  // Enter key to submit
  const handleEnterKey = (e) => {
    if (e.key === 'Enter') {
      handleSignIn();
    }
  };
  usernameInput.addEventListener('keypress', handleEnterKey);
  passwordInput.addEventListener('keypress', handleEnterKey);

  // Destroy function
  const destroy = () => {
    usernameInput.removeEventListener('keypress', handleEnterKey);
    passwordInput.removeEventListener('keypress', handleEnterKey);
    vignette.remove();
    container.remove();
  };

  // Get current values (for preserving during transitions)
  const getValues = () => ({
    username: usernameInput.value,
    password: passwordInput.value,
  });

  // Set values (for restoring during transitions)
  const setValues = ({ username = '', password = '' }) => {
    usernameInput.value = username;
    passwordInput.value = password;
  };

  return {
    vignette,
    container,
    destroy,
    getValues,
    setValues,
    usernameInput,
    passwordInput,
  };
}

/**
 * Show the sign-in screen (convenience function).
 *
 * @param {Object} options - Screen options
 * @param {Function} options.onSignIn - Called with { username, password }
 * @param {Function} options.onCreateAccount - Called to show registration
 * @param {Object} [options.prefill] - Optional prefill values
 * @param {string} [options.prefill.username] - Username to prefill
 * @param {string} [options.prefill.password] - Password to prefill
 */
export function showSignInScreen(options) {
  const screen = createSignInScreen(options);
  document.body.appendChild(screen.vignette);
  document.body.appendChild(screen.container);

  // Prefill values if provided
  if (options.prefill) {
    screen.setValues(options.prefill);
  }

  // Focus username if empty, otherwise focus password
  if (screen.usernameInput.value) {
    screen.passwordInput.focus();
  } else {
    screen.usernameInput.focus();
  }

  return screen;
}
