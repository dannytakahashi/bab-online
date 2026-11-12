/**
 * Authentication-related socket event handlers.
 *
 * Handles: signInResponse, signUpResponse, forceLogout, sessionSuperseded, activeGameFound
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';
import { rememberSession } from '../utils/sessionPersistence.js';

/**
 * Register authentication handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 * @param {Function} callbacks.onSignInSuccess - Called on successful sign in
 * @param {Function} callbacks.onSignInError - Called on sign in error
 * @param {Function} callbacks.onSignUpSuccess - Called on successful sign up
 * @param {Function} callbacks.onSignUpError - Called on sign up error
 * @param {Function} callbacks.onForceLogout - Called when force logged out
 * @param {Function} callbacks.onActiveGameFound - Called when user has active game
 * @param {Function} callbacks.onSessionSuperseded - Another tab took the session
 */
export function registerAuthHandlers(socketManager, callbacks = {}) {
  const {
    onSignInSuccess,
    onSignInError,
    onSignUpSuccess,
    onSignUpError,
    onForceLogout,
    onActiveGameFound,
    onSessionSuperseded,
  } = callbacks;

  const state = getGameState();

  // Sign in response
  socketManager.on(SERVER_EVENTS.SIGN_IN_RESPONSE, (data) => {
    if (data.success) {
      // Store in sessionStorage for reconnection
      sessionStorage.setItem('username', data.username);
      if (data.sessionToken) {
        sessionStorage.setItem('sessionToken', data.sessionToken);
        rememberSession(data.username, data.sessionToken);
      }

      // Update state
      state.username = data.username;
      state.playerId = socketManager.id; // Use getter, not method

      console.log(`✅ Signed in as: ${data.username}`);
      onSignInSuccess?.(data);
    } else {
      console.warn('❌ Sign in failed:', data.message);
      onSignInError?.(data.message || 'Sign in failed');
    }
  });

  // Sign up response
  socketManager.on(SERVER_EVENTS.SIGN_UP_RESPONSE, (data) => {
    if (data.success) {
      // Store in sessionStorage
      sessionStorage.setItem('username', data.username);
      if (data.sessionToken) {
        sessionStorage.setItem('sessionToken', data.sessionToken);
        rememberSession(data.username, data.sessionToken);
      }

      // Update state
      state.username = data.username;

      console.log(`✅ Registered as: ${data.username}`);
      onSignUpSuccess?.(data);
    } else {
      console.warn('❌ Registration failed:', data.message);
      onSignUpError?.(data.message || 'Registration failed');
    }
  });

  // Force logout (another session signed in)
  socketManager.on(SERVER_EVENTS.FORCE_LOGOUT, (data) => {
    console.warn('⚠️ Force logout:', data?.reason);

    // Clear this tab's credentials. The device's saved session is kept:
    // reloading the page resumes it here (taking over from the other device).
    // onForceLogout leaves any table (exitTable clears the gameId copies)
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('sessionToken');

    // Forget the identity too (username, tournament)
    state.resetSession();

    onForceLogout?.(data);
  });

  // Another tab / window of this browser took the session (the server
  // keeps one live connection per user). The tab's credentials stay: Use
  // here restores them. Repeated as the answer to anything this tab sends
  // meanwhile ({refused}), which changes nothing more
  socketManager.on(SERVER_EVENTS.SESSION_SUPERSEDED, (data) => {
    console.log('Session is live in another tab:', data?.refused ? `refused ${data.refused}` : 'paused');
    onSessionSuperseded?.(data);
  });

  // Active game found (user has a game in progress)
  socketManager.on(SERVER_EVENTS.ACTIVE_GAME_FOUND, (data) => {
    console.log('🎮 Active game found:', data.gameId);
    onActiveGameFound?.(data);
  });
}
