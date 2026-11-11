/**
 * The page's one Socket.IO connection (socket.io-client bundled at the
 * server's version, 4.8.1).
 */

import { io } from 'socket.io-client';

export const PRODUCTION_SERVER_URL = 'https://bab-online-production.up.railway.app';

export const SOCKET_OPTIONS = Object.freeze({
  transports: ['websocket'],
  reconnection: true,
  // Keep retrying (Socket.IO's default): once reconnect_failed fires the
  // client never reconnects again, so a long outage would strand the page
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

/** The hosts that serve the production page. */
export const PRODUCTION_HOSTS = Object.freeze(['babonline.io', 'www.babonline.io', 'bab-online-production.up.railway.app']);

/**
 * Which server the page talks to. Production pages (PRODUCTION_HOSTS) use
 * the Railway URL as before. Any other page talks to the server that served
 * it, except the Vite dev server (5173), whose API server is on 3000. Never
 * fall back to production for an unknown host: a local page opened as
 * http://[::1]:<port> or http://name.localhost:<port> once signed a test
 * account up on the live server.
 */
export function socketServerUrl(loc = window.location) {
  if (PRODUCTION_HOSTS.includes(loc.hostname)) return PRODUCTION_SERVER_URL;
  if (loc.port === '5173') return `${loc.protocol}//${loc.hostname}:3000`;
  return loc.origin;
}

export function createSocket({ ioImpl = io, loc } = {}) {
  return ioImpl(socketServerUrl(loc), { ...SOCKET_OPTIONS });
}
