/**
 * Profile-related socket event handlers.
 *
 * Handles: profileResponse, profilePicUpdateResponse
 */

/**
 * Register profile handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 * @param {Function} callbacks.onProfileReceived - Called when profile data is received
 * @param {Function} callbacks.onProfileError - Called on profile fetch error
 * @param {Function} callbacks.onProfilePicUpdated - Called when profile pic is updated
 * @param {Function} callbacks.onProfilePicUpdateError - Called on profile pic update error
 */
export function registerProfileHandlers(socketManager, callbacks = {}) {
  const {
    onProfileReceived,
    onProfileError,
    onProfilePicUpdated,
    onProfilePicUpdateError,
  } = callbacks;

  // Profile response
  socketManager.on('profileResponse', (data) => {
    if (data.success) {
      console.log('Profile received:', data.profile);
      onProfileReceived?.(data.profile);
    } else {
      console.warn('Profile fetch failed:', data.message);
      onProfileError?.(data.message || 'Failed to fetch profile');
    }
  });

  // Profile pic update response
  socketManager.on('profilePicUpdateResponse', (data) => {
    if (data.success) {
      console.log('Profile pic updated:', data.profilePic);
      onProfilePicUpdated?.(data.profilePic);
    } else {
      console.warn('Profile pic update failed:', data.message);
      onProfilePicUpdateError?.(data.message || 'Failed to update profile picture');
    }
  });
}
