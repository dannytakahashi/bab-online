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

  // Logo
  const logo = document.createElement('img');
  logo.src = 'assets/logo.png';
  logo.alt = 'Game Logo';
  logo.style.cssText = `
    width: 26vw;
    margin-bottom: 2vh;
    position: relative;
    left: 2vw;
  `;
  container.appendChild(logo);

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
 */
export function showSignInScreen(options) {
  const screen = createSignInScreen(options);
  document.body.appendChild(screen.vignette);
  document.body.appendChild(screen.container);
  screen.usernameInput.focus();
  return screen;
}
