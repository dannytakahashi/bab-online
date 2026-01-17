import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSignInScreen, showSignInScreen } from './SignIn.js';

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

  it('does not call onSignIn if fields are empty', () => {
    // Mock window.alert
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
    expect(alertSpy).toHaveBeenCalled();

    alertSpy.mockRestore();
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
