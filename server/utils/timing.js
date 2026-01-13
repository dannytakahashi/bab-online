/**
 * Async timing utilities - replaces blocking sleepSync
 */

/**
 * Async delay utility - does NOT block the event loop
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Schedule a callback after delay
 * @param {Function} callback - Function to call
 * @param {number} ms - Delay in milliseconds
 * @returns {NodeJS.Timeout} - Timer ID for cancellation
 */
function schedule(callback, ms) {
    return setTimeout(callback, ms);
}

/**
 * Create a debounced function
 * @param {Function} fn - Function to debounce
 * @param {number} ms - Debounce delay
 * @returns {Function} - Debounced function
 */
function debounce(fn, ms) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), ms);
    };
}

module.exports = { delay, schedule, debounce };
