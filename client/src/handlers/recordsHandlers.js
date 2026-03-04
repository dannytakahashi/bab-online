/**
 * Records-related socket event handlers.
 *
 * Handles: recordsResponse
 */

/**
 * Register records handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 * @param {Function} callbacks.onRecordsReceived - Called when records data is received
 * @param {Function} callbacks.onRecordsError - Called on records fetch error
 */
export function registerRecordsHandlers(socketManager, callbacks = {}) {
  const {
    onRecordsReceived,
    onRecordsError,
  } = callbacks;

  // Records response
  socketManager.on('recordsResponse', (data) => {
    if (data.success) {
      console.log('Records received');
      onRecordsReceived?.(data.records);
    } else {
      console.warn('Records fetch failed:', data.message);
      onRecordsError?.(data.message || 'Failed to fetch records');
    }
  });
}
