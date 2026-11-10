import { describe, it, expect, vi } from 'vitest';
import { socketServerUrl, createSocket, PRODUCTION_SERVER_URL, SOCKET_OPTIONS } from './createSocket.js';

const loc = (href) => new URL(href);

describe('socketServerUrl', () => {
  it('production pages talk to the Railway server, as socket-init.js did', () => {
    expect(socketServerUrl(loc('https://babonline.io/'))).toBe(PRODUCTION_SERVER_URL);
    expect(socketServerUrl(loc('https://bab-online-production.up.railway.app/'))).toBe(PRODUCTION_SERVER_URL);
  });

  it('a local page talks to the server that served it', () => {
    expect(socketServerUrl(loc('http://localhost:3000/'))).toBe('http://localhost:3000');
    expect(socketServerUrl(loc('http://localhost:3100/'))).toBe('http://localhost:3100');
    expect(socketServerUrl(loc('http://127.0.0.1:3100/'))).toBe('http://127.0.0.1:3100');
  });

  it('the Vite dev server (5173) talks to the API server on 3000', () => {
    expect(socketServerUrl(loc('http://localhost:5173/'))).toBe('http://localhost:3000');
  });
});

describe('createSocket', () => {
  it('websocket only, retries forever (reconnect_failed would strand the page)', () => {
    const ioImpl = vi.fn(() => ({}));
    createSocket({ ioImpl, loc: loc('https://babonline.io/') });
    expect(ioImpl).toHaveBeenCalledWith(PRODUCTION_SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    expect(Object.isFrozen(SOCKET_OPTIONS)).toBe(true);
  });

  it('the bundled client speaks the server\'s protocol (v5)', async () => {
    const { protocol } = await import('socket.io-client');
    expect(protocol).toBe(5);
  });
});
