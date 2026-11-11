import { describe, it, expect, vi } from 'vitest';
import { socketServerUrl, createSocket, PRODUCTION_SERVER_URL, SOCKET_OPTIONS } from './createSocket.js';

const loc = (href) => new URL(href);

describe('socketServerUrl', () => {
  it('production pages talk to the Railway server', () => {
    expect(socketServerUrl(loc('https://babonline.io/'))).toBe(PRODUCTION_SERVER_URL);
    expect(socketServerUrl(loc('https://bab-online-production.up.railway.app/'))).toBe(PRODUCTION_SERVER_URL);
  });

  it('a local page talks to the server that served it', () => {
    expect(socketServerUrl(loc('http://localhost:3000/'))).toBe('http://localhost:3000');
    expect(socketServerUrl(loc('http://localhost:3100/'))).toBe('http://localhost:3100');
    expect(socketServerUrl(loc('http://127.0.0.1:3100/'))).toBe('http://127.0.0.1:3100');
  });

  it('production pages include www', () => {
    expect(socketServerUrl(loc('https://www.babonline.io/'))).toBe(PRODUCTION_SERVER_URL);
  });

  it('any other host talks to the server that served it, never production', () => {
    expect(socketServerUrl(loc('http://[::1]:3958/'))).toBe('http://[::1]:3958');
    expect(socketServerUrl(loc('http://vsc.localhost:3958/'))).toBe('http://vsc.localhost:3958');
    expect(socketServerUrl(loc('http://192.168.1.20:3100/'))).toBe('http://192.168.1.20:3100');
    expect(socketServerUrl(loc('https://preview.example.test/'))).toBe('https://preview.example.test');
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
