import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSignInScreen, showSignInScreen } from './SignIn.js';
import { clearToasts } from '../kit/index.js';
import { readClientFile } from '../../testing/files.js';

describe('createSignInScreen', () => {
  let screen;
  const mockOnSignIn = vi.fn();
  const mockOnCreateAccount = vi.fn();

  beforeEach(() => {
    mockOnSignIn.mockClear();
    mockOnCreateAccount.mockClear();
  });

  afterEach(() => {
    if (screen) {
      screen.destroy();
      screen = null;
    }
  });

  it('creates vignette and container', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    expect(screen.vignette).toBeDefined();
    expect(screen.container).toBeDefined();
    expect(screen.vignette.id).toBe('sign-in-vignette');
    expect(screen.container.id).toBe('sign-in-container');
  });

  it('has username and password inputs', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    expect(screen.usernameInput).toBeDefined();
    expect(screen.passwordInput).toBeDefined();
    expect(screen.usernameInput.type).toBe('text');
    expect(screen.passwordInput.type).toBe('password');
  });

  it('marks inputs so browsers offer to save and fill the password', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    expect(screen.usernameInput.getAttribute('autocomplete')).toBe('username');
    expect(screen.passwordInput.getAttribute('autocomplete')).toBe('current-password');
  });

  it('calls onSignIn with credentials when sign in clicked', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.usernameInput.value = 'testuser';
    screen.passwordInput.value = 'testpass';

    // Find and click sign in button
    const signInBtn = screen.container.querySelector('button');
    signInBtn.click();

    expect(mockOnSignIn).toHaveBeenCalledWith({
      username: 'testuser',
      password: 'testpass',
    });
  });

  it('does not call onSignIn if fields are empty (an error toast, never window.alert)', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.usernameInput.value = '';
    screen.passwordInput.value = '';

    const signInBtn = screen.container.querySelector('button');
    signInBtn.click();

    expect(mockOnSignIn).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    const toast = document.querySelector('.kit-toast.toast-error');
    expect(toast?.textContent).toBe('Please enter both a username and a password.');
    expect(toast.getAttribute('role')).toBe('alert');

    clearToasts();
    alertSpy.mockRestore();
  });

  it('labels every input and keeps them at 16 px (no iOS zoom) in a card at most 440 px wide', () => {
    screen = createSignInScreen({ onSignIn: mockOnSignIn, onCreateAccount: mockOnCreateAccount });
    for (const input of [screen.usernameInput, screen.passwordInput]) {
      expect(input.classList.contains('kit-input')).toBe(true);
      const label = screen.container.querySelector(`label[for="${input.id}"]`);
      expect(label?.textContent, input.name).toBeTruthy();
    }
    expect(screen.container.querySelector('.auth-card')).not.toBeNull();
    const kit = readClientFile('styles/kit.css');
    expect(kit).toMatch(/\.kit-input \{[^}]*font-size: var\(--type-md\)/);
    const screens = readClientFile('styles/screens.css');
    expect(screens).toMatch(/\.auth-card \{[^}]*max-width: 440px/);
  });

  it('the splash animates once (never infinite) and not at all under reduced motion', () => {
    screen = createSignInScreen({ onSignIn: mockOnSignIn, onCreateAccount: mockOnCreateAccount });
    const splash = screen.container.querySelector('.auth-splash');
    expect(splash).not.toBeNull();
    expect(splash.getAttribute('style')).toBeNull();
    // no keyframes injected from JS any more
    expect(document.getElementById('splash-keyframes')).toBeNull();
    const css = readClientFile('styles/screens.css');
    const rule = css.slice(css.indexOf('.auth-splash {'), css.indexOf('}', css.indexOf('.auth-splash {')));
    expect(rule).toMatch(/animation: auth-splash-in var\(--dur-slow\) var\(--ease-emphasized\) 1 backwards/);
    expect(rule).not.toMatch(/infinite/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.auth-splash \{\s*animation: none/);
  });

  it('calls onCreateAccount when create account clicked', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.usernameInput.value = 'testuser';
    screen.passwordInput.value = 'testpass';

    // Find create account button (second button)
    const buttons = screen.container.querySelectorAll('button');
    const createAccountBtn = buttons[1];
    createAccountBtn.click();

    expect(mockOnCreateAccount).toHaveBeenCalledWith({
      username: 'testuser',
      password: 'testpass',
    });
  });

  it('submits on Enter key in username field', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.usernameInput.value = 'testuser';
    screen.passwordInput.value = 'testpass';

    const enterEvent = new KeyboardEvent('keypress', { key: 'Enter' });
    screen.usernameInput.dispatchEvent(enterEvent);

    expect(mockOnSignIn).toHaveBeenCalled();
  });

  it('submits on Enter key in password field', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.usernameInput.value = 'testuser';
    screen.passwordInput.value = 'testpass';

    const enterEvent = new KeyboardEvent('keypress', { key: 'Enter' });
    screen.passwordInput.dispatchEvent(enterEvent);

    expect(mockOnSignIn).toHaveBeenCalled();
  });

  it('destroy removes elements', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    document.body.appendChild(screen.vignette);
    document.body.appendChild(screen.container);

    expect(document.getElementById('sign-in-vignette')).toBeTruthy();
    expect(document.getElementById('sign-in-container')).toBeTruthy();

    screen.destroy();
    screen = null; // Prevent afterEach from calling destroy again

    expect(document.getElementById('sign-in-vignette')).toBeFalsy();
    expect(document.getElementById('sign-in-container')).toBeFalsy();
  });

  it('getValues returns current input values', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.usernameInput.value = 'myuser';
    screen.passwordInput.value = 'mypass';

    const values = screen.getValues();

    expect(values).toEqual({
      username: 'myuser',
      password: 'mypass',
    });
  });

  it('setValues sets input values', () => {
    screen = createSignInScreen({
      onSignIn: mockOnSignIn,
      onCreateAccount: mockOnCreateAccount,
    });

    screen.setValues({ username: 'preset', password: 'secret' });

    expect(screen.usernameInput.value).toBe('preset');
    expect(screen.passwordInput.value).toBe('secret');
  });
});

describe('showSignInScreen', () => {
  afterEach(() => {
    document.querySelectorAll('.vignette').forEach((el) => el.remove());
    document.getElementById('sign-in-container')?.remove();
  });

  it('appends screen to body', () => {
    const screen = showSignInScreen({
      onSignIn: vi.fn(),
      onCreateAccount: vi.fn(),
    });

    expect(document.getElementById('sign-in-vignette')).toBeTruthy();
    expect(document.getElementById('sign-in-container')).toBeTruthy();

    screen.destroy();
  });
});
