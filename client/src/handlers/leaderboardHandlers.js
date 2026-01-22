/**
 * Leaderboard-related socket event handlers.
 *
 * Handles: leaderboardResponse
 */

/**
 * Register leaderboard handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 * @param {Function} callbacks.onLeaderboardReceived - Called when leaderboard data is received
 * @param {Function} callbacks.onLeaderboardError - Called on leaderboard fetch error
 */
export function registerLeaderboardHandlers(socketManager, callbacks = {}) {
  const {
    onLeaderboardReceived,
    onLeaderboardError,
  } = callbacks;

  // Leaderboard response
  socketManager.on('leaderboardResponse', (data) => {
    if (data.success) {
      console.log('Leaderboard received:', data.leaderboard.length, 'players');
      onLeaderboardReceived?.(data.leaderboard);
    } else {
      console.warn('Leaderboard fetch failed:', data.message);
      onLeaderboardError?.(data.message || 'Failed to fetch leaderboard');
    }
  });
}
