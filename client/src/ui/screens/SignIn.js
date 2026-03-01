/**
 * Sign-in screen component.
 */

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
  const vignette = document.createElement('div');
  vignette.id = 'sign-in-vignette';
  vignette.className = 'vignette';
  vignette.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    background: radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%);
    z-index: 50;
  `;

  // Container
  const container = document.createElement('div');
  container.id = 'sign-in-container';
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    z-index: 100;
  `;

  // Logo wrapper (for splash text positioning)
  const logoWrapper = document.createElement('div');
  logoWrapper.style.cssText = `
    position: relative;
    margin-bottom: 2vh;
  `;

  const logo = document.createElement('img');
  logo.src = 'assets/logo.png';
  logo.alt = 'Game Logo';
  logo.style.cssText = `
    width: 26vw;
    position: relative;
    left: 2vw;
  `;
  logoWrapper.appendChild(logo);

  // Splash text (Minecraft-style)
  const splashPhrases = [
    'he sends a boy!',
    'i got my bid...',
    'out of boolats!',
    'heartless!',
    'this one is mandatory.',
    'i bid on that one.',
    'you need to get my one.',
    'surely...',
  ];
  const splash = document.createElement('span');
  splash.textContent = splashPhrases[Math.floor(Math.random() * splashPhrases.length)];
  splash.style.cssText = `
    position: absolute;
    left: 80%;
    top: 70%;
    color: #ffff00;
    font-weight: bold;
    font-size: 1.4vw;
    font-style: italic;
    white-space: nowrap;
    transform-origin: center;
    transform: rotate(-15deg);
    animation: splashPulse 2s ease-in-out infinite;
    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  `;
  logoWrapper.appendChild(splash);

  // Inject splash pulse keyframes
  if (!document.getElementById('splash-keyframes')) {
    const style = document.createElement('style');
    style.id = 'splash-keyframes';
    style.textContent = `
      @keyframes splashPulse {
        0%, 100% { transform: rotate(-15deg) scale(1); }
        50% { transform: rotate(-15deg) scale(1.04); }
      }
    `;
    document.head.appendChild(style);
  }

  container.appendChild(logoWrapper);

  // Username input
  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.placeholder = 'Username';
  usernameInput.style.cssText = `
    font-size: 12px;
    padding: 10px;
    margin-bottom: 10px;
    border-radius: 5px;
    border: none;
    text-align: center;
  `;
  container.appendChild(usernameInput);

  // Password input
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = 'Password';
  passwordInput.style.cssText = `
    font-size: 12px;
    padding: 10px;
    margin-bottom: 10px;
    border-radius: 5px;
    border: none;
    text-align: center;
  `;
  container.appendChild(passwordInput);

  // Sign in button
  const signInButton = document.createElement('button');
  signInButton.textContent = 'Sign In';
  signInButton.style.cssText = `
    font-size: 14px;
    padding: 10px 20px;
    border-radius: 5px;
    border: none;
    background: #23782d;
    color: #fff;
    cursor: pointer;
  `;
  container.appendChild(signInButton);

  // Divider
  const divider = document.createElement('div');
  divider.style.cssText = `
    display: flex;
    align-items: center;
    width: 80%;
    margin: 15px 0 10px 0;
  `;
  divider.innerHTML = `
    <div style="flex: 1; height: 1px; background: rgba(255,255,255,0.3);"></div>
    <span style="padding: 0 10px; color: rgba(255,255,255,0.7); font-size: 12px;">New user?</span>
    <div style="flex: 1; height: 1px; background: rgba(255,255,255,0.3);"></div>
  `;
  container.appendChild(divider);

  // Create account button
  const createAccountButton = document.createElement('button');
  createAccountButton.textContent = 'Create Account';
  createAccountButton.style.cssText = `
    font-size: 14px;
    padding: 10px 20px;
    border-radius: 5px;
    border: none;
    background: #007bff;
    color: #fff;
    cursor: pointer;
  `;
  container.appendChild(createAccountButton);

  // Event handlers
  const handleSignIn = () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
      // Could use showError from Toast here
      window.alert('Please enter both a username and a password.');
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
