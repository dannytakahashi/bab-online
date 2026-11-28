/**
 * Profile-related socket event handlers.
 *
 * Handles: profileResponse, profilePicUpdateResponse, badgesAwarded
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
 * @param {Function} callbacks.onSearchPlayersResult - Called with search results
 * @param {Function} callbacks.onPlayerCards - Called with the rows of a playerCardsResponse (the Players page's online list pictures)
 * @param {Function} callbacks.onPlayerProfileReceived - Called with (profile, scope, badges) of another player
 * @param {Function} callbacks.onBadgesAwarded - Called with the badges this player just earned ([{id, name, description}])
 * @param {Function} callbacks.onPlayerProfileError - Called when another player's profile fails (no toast today)
 */
export function registerProfileHandlers(socketManager, callbacks = {}) {
  const {
    onProfileReceived,
    onProfileError,
    onProfilePicUpdated,
    onProfilePicUpdateError,
    onCustomProfilePicUploaded,
    onCustomProfilePicUploadError,
    onSearchPlayersResult,
    onPlayerCards,
    onPlayerProfileReceived,
    onPlayerProfileError,
    onBadgesAwarded,
  } = callbacks;

  // Profile response
  socketManager.on('profileResponse', (data) => {
    if (data.success) {
      console.log('Profile received:', data.profile);
      // scope: the stats scope echoed when the request named one (undefined = human)
      // badges: the player's earned badges (only with the cap `badges`)
      onProfileReceived?.(data.profile, data.scope, data.badges);
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

  // Player search response
  socketManager.on('searchPlayersResponse', (data) => {
    console.log('searchPlayersResponse received:', data);
    if (data.success) {
      // query: the echo of the request (stale replies are dropped there)
      onSearchPlayersResult?.(data.players, data.query);
    } else {
      console.warn('Player search failed:', data.message);
      onSearchPlayersResult?.([], data.query);
    }
  });

  // Player cards (2026-11-27): the pictures of the Players page's online
  // list; a failure keeps the initials (nothing shown, nothing retried)
  socketManager.on('playerCardsResponse', (data) => {
    if (data?.success && Array.isArray(data.players)) onPlayerCards?.(data.players);
    else console.warn('Player cards failed:', data?.message);
  });

  // Player profile response (viewing another player)
  socketManager.on('playerProfileResponse', (data) => {
    if (data.success) {
      onPlayerProfileReceived?.(data.profile, data.scope, data.badges);
    } else {
      console.warn('Player profile fetch failed:', data.message);
      onPlayerProfileError?.(data.message);
    }
  });

  // Badges this player just earned (private; after a game's stats are written)
  socketManager.on('badgesAwarded', (data) => {
    if (Array.isArray(data?.badges) && data.badges.length > 0) onBadgesAwarded?.(data.badges, data.gameId);
  });
}
