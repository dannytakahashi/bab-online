/**
 * Registration screen component.
 *
 * The sign-in screen's card (styles/screens.css, item 18b): labelled
 * 16 px inputs, 44 px buttons, at most 440 px wide; validation messages
 * go to the one toast queue.
 */
import { el, createButton, createPanel } from '../kit/index.js';
import { showError } from '../components/Toast.js';
import { authField, authVignette, authLogo } from './SignIn.js';

/**
 * Create the registration screen.
 *
 * @param {Object} options - Screen options
 * @param {Function} options.onRegister - Called with { username, password, confirmPassword }
 * @param {Function} options.onBackToSignIn - Called to return to sign-in
 * @param {Object} options.prefill - Optional { username, password } to prefill
 * @returns {Object} { container, destroy }
 */
export function createRegisterScreen({ onRegister, onBackToSignIn, prefill = {} }) {
  // Vignette background
  const vignette = authVignette('register-vignette');

  // Container
  const container = el('main', { className: 'auth-screen', attrs: { id: 'register-container' } });

  // Logo
  container.appendChild(el('div', { className: 'auth-logo-wrap', children: [authLogo()] }));

  const form = createPanel({ tag: 'form', elevation: 3, className: 'auth-card' });
  form.setAttribute('aria-labelledby', 'registerTitle');
  form.noValidate = true;
  form.addEventListener('submit', (e) => e.preventDefault());

  // Title
  form.appendChild(el('h2', { className: 'auth-title', attrs: { id: 'registerTitle' }, text: 'Create Account' }));

  const { field: userField, input: usernameInput } = authField({
    id: 'registerUsername', label: 'Username', name: 'username', autocomplete: 'username', autocapitalize: 'none',
    value: prefill.username || '',
  });
  const { field: passField, input: passwordInput } = authField({
    id: 'registerPassword', label: 'Password', type: 'password', name: 'new-password', autocomplete: 'new-password',
    value: prefill.password || '',
  });
  const { field: confirmField, input: confirmInput } = authField({
    id: 'registerConfirm', label: 'Confirm Password', type: 'password', name: 'confirm-password', autocomplete: 'new-password',
  });
  form.appendChild(userField);
  form.appendChild(passField);
  form.appendChild(confirmField);

  // Register button
  const registerButton = createButton({ label: 'Register', variant: 'primary' });
  form.appendChild(registerButton);

  // Terms acceptance notice (UGC apps must require agreement to terms)
  const termsNote = el('div', { className: 'auth-terms' });
  termsNote.append('By creating an account you agree to the ');
  termsNote.appendChild(el('a', { attrs: { href: '/terms', target: '_blank', rel: 'noopener' }, text: 'Terms of Use' }));
  termsNote.append(', including zero tolerance for abusive content.');
  form.appendChild(termsNote);

  // Back to sign in link
  const backLink = createButton({ label: 'Back to Sign In', variant: 'ghost', size: 'sm' });
  form.appendChild(backLink);
  container.appendChild(form);

  // Event handlers
  const handleRegister = () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    const confirmPassword = confirmInput.value.trim();

    if (!username || !password || !confirmPassword) {
      showError('Please fill in all fields.');
      return;
    }

    if (password !== confirmPassword) {
      showError('Passwords do not match.');
      confirmInput.focus();
      return;
    }

    if (password.length < 4) {
      showError('Password must be at least 4 characters.');
      passwordInput.focus();
      return;
    }

    onRegister({ username, password });
  };

  registerButton.onclick = handleRegister;
  backLink.onclick = onBackToSignIn;

  // Enter key to submit
  const handleEnterKey = (e) => {
    if (e.key === 'Enter') {
      handleRegister();
    }
  };
  usernameInput.addEventListener('keypress', handleEnterKey);
  passwordInput.addEventListener('keypress', handleEnterKey);
  confirmInput.addEventListener('keypress', handleEnterKey);

  // Destroy function
  const destroy = () => {
    usernameInput.removeEventListener('keypress', handleEnterKey);
    passwordInput.removeEventListener('keypress', handleEnterKey);
    confirmInput.removeEventListener('keypress', handleEnterKey);
    vignette.remove();
    container.remove();
  };

  return {
    vignette,
    container,
    destroy,
    usernameInput,
    passwordInput,
    confirmInput,
  };
}

/**
 * Show the registration screen (convenience function).
 */
export function showRegisterScreen(options) {
  const screen = createRegisterScreen(options);
  document.body.appendChild(screen.vignette);
  document.body.appendChild(screen.container);
  screen.usernameInput.focus();
  return screen;
}
