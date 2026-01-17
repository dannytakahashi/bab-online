/**
 * Registration screen component.
 */

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
  const vignette = document.createElement('div');
  vignette.id = 'register-vignette';
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
  container.id = 'register-container';
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

  // Title
  const title = document.createElement('h2');
  title.textContent = 'Create Account';
  title.style.cssText = `
    color: white;
    margin-bottom: 20px;
    font-size: 20px;
  `;
  container.appendChild(title);

  // Username input
  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.placeholder = 'Username';
  usernameInput.value = prefill.username || '';
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
  passwordInput.value = prefill.password || '';
  passwordInput.style.cssText = `
    font-size: 12px;
    padding: 10px;
    margin-bottom: 10px;
    border-radius: 5px;
    border: none;
    text-align: center;
  `;
  container.appendChild(passwordInput);

  // Confirm password input
  const confirmInput = document.createElement('input');
  confirmInput.type = 'password';
  confirmInput.placeholder = 'Confirm Password';
  confirmInput.style.cssText = `
    font-size: 12px;
    padding: 10px;
    margin-bottom: 10px;
    border-radius: 5px;
    border: none;
    text-align: center;
  `;
  container.appendChild(confirmInput);

  // Register button
  const registerButton = document.createElement('button');
  registerButton.textContent = 'Register';
  registerButton.style.cssText = `
    font-size: 14px;
    padding: 10px 20px;
    border-radius: 5px;
    border: none;
    background: #23782d;
    color: #fff;
    cursor: pointer;
    margin-bottom: 10px;
  `;
  container.appendChild(registerButton);

  // Back to sign in link
  const backLink = document.createElement('button');
  backLink.textContent = 'Back to Sign In';
  backLink.style.cssText = `
    font-size: 12px;
    padding: 8px 16px;
    border-radius: 5px;
    border: none;
    background: transparent;
    color: #aaa;
    cursor: pointer;
    text-decoration: underline;
  `;
  container.appendChild(backLink);

  // Event handlers
  const handleRegister = () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    const confirmPassword = confirmInput.value.trim();

    if (!username || !password || !confirmPassword) {
      window.alert('Please fill in all fields.');
      return;
    }

    if (password !== confirmPassword) {
      window.alert('Passwords do not match.');
      return;
    }

    if (password.length < 4) {
      window.alert('Password must be at least 4 characters.');
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
