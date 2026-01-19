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
 * @param {Function} callbacks.onCustomProfilePicUploaded - Called when custom pic is uploaded
 * @param {Function} callbacks.onCustomProfilePicUploadError - Called on custom pic upload error
 */
export function registerProfileHandlers(socketManager, callbacks = {}) {
  const {
    onProfileReceived,
    onProfileError,
    onProfilePicUpdated,
    onProfilePicUpdateError,
    onCustomProfilePicUploaded,
    onCustomProfilePicUploadError,
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

  // Profile pic update response (choosing from gallery)
  socketManager.on('profilePicUpdateResponse', (data) => {
    if (data.success) {
      console.log('Profile pic updated:', data.profilePic);
      onProfilePicUpdated?.(data.profilePic);
    } else {
      console.warn('Profile pic update failed:', data.message);
      onProfilePicUpdateError?.(data.message || 'Failed to update profile picture');
    }
  });

  // Custom profile pic upload response
  socketManager.on('profilePicUploadResponse', (data) => {
    if (data.success) {
      console.log('Custom profile pic uploaded');
      onCustomProfilePicUploaded?.(data.customProfilePic);
    } else {
      console.warn('Custom profile pic upload failed:', data.message);
      onCustomProfilePicUploadError?.(data.message || 'Failed to upload profile picture');
    }
  });
}
