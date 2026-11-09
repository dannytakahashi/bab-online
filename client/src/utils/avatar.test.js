/**
 * utils/avatar.js: src mapping, the <img> helper, the ingress fold of
 * avatarUrls into pic fields, and the clientHello wiring (docs/avatars.md).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  avatarSrc, profileAvatarSrc, applyAvatarImg, foldAvatarPayload, foldUrls, isAvatarPic,
  installAvatarSupport, clientHello, inlineFor, CUSTOM_FALLBACK, AVATAR_RETRY_MS,
} from './avatar.js';
import { parseSnapshotV2, mergeSnapshot } from '../state/snapshotV2.js';

const URL1 = '/avatar/kim?v=0123456789abcdef';
const URL2 = '/avatar/Zo%C3%AB?v=fedcba9876543210';
const DATA = 'data:image/webp;base64,UklGRg==';
const STATS = { gamesPlayed: 3, winRate: 50, pointsPerGame: 100, bidsPerGame: 20, tricksPerBid: 1, setRate: 10, drag: -5, faultsPerGame: 0.5, avgHSI: 4 };

describe('avatarSrc', () => {
  test.each([
    [1, 'assets/avatars/v1/profile1.webp'],
    [82, 'assets/avatars/v1/profile82.webp'],
    [0, 'FB'],
    [83, 'FB'],
    ['12', 'FB'],
    [12.5, 'FB'],
    [DATA, DATA],
    [URL1, URL1],
    ['http://evil.example/x.png', 'FB'],
    ['javascript:alert(1)', 'FB'],
    [null, 'FB'],
    [undefined, 'FB'],
  ])('%j -> %s', (pic, want) => {
    expect(avatarSrc(pic, 'FB')).toBe(want);
  });

  test('default fallback and profile rows', () => {
    expect(avatarSrc(null)).toBe('assets/profile1.png');
    expect(profileAvatarSrc({ customProfilePic: URL1, profilePic: 3 })).toBe(URL1);
    expect(profileAvatarSrc({ customProfilePic: null, profilePic: 3 })).toBe('assets/avatars/v1/profile3.webp');
    expect(profileAvatarSrc({ customProfilePic: null, profilePic: null }, 'assets/default_avatar.png')).toBe('assets/default_avatar.png');
    expect(isAvatarPic(5)).toBe(true);
    expect(isAvatarPic('5')).toBe(false);
  });
});

describe('applyAvatarImg', () => {
  test('sets async decoding, lazy on request, the src; same src again is a no-op', () => {
    const img = document.createElement('img');
    applyAvatarImg(img, 'assets/avatars/v1/profile4.webp', { lazy: true });
    expect(img.getAttribute('src')).toBe('assets/avatars/v1/profile4.webp');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('loading')).toBe('lazy');
    const set = vi.spyOn(img, 'setAttribute');
    applyAvatarImg(img, 'assets/avatars/v1/profile4.webp');
    expect(set.mock.calls.filter(([k]) => k === 'src')).toHaveLength(0);
    const eager = applyAvatarImg(document.createElement('img'), URL1);
    expect(eager.getAttribute('loading')).toBeNull();
  });

  test('error chain: WebP -> legacy PNG -> fallback, then stops', () => {
    const img = document.createElement('img');
    applyAvatarImg(img, 'assets/avatars/v1/profile7.webp', { fallback: 'assets/default_avatar.png' });
    img.onerror();
    expect(img.getAttribute('src')).toBe('assets/profile7.png');
    img.onerror();
    expect(img.getAttribute('src')).toBe('assets/default_avatar.png');
    expect(img.onerror).toBeNull();
    // an invalid pic still gets the caller's fallback
    const none = applyAvatarImg(document.createElement('img'), avatarSrc(null));
    expect(none.getAttribute('src')).toBe('assets/profile1.png');
  });

  describe('a failed custom picture never shows another player\'s stock animal', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('/avatar URL with an inline copy from a room broadcast: the inline copy at once', () => {
      const url = '/avatar/kim?v=1111111111111111';
      foldAvatarPayload('positionUpdate', { positions: [1, 2], pics: [DATA, 5], avatarUrls: { 1: url } });
      expect(inlineFor(url)).toBe(DATA);
      const img = applyAvatarImg(document.createElement('img'), url);
      img.onerror(); // e.g. 503 from the lookup cap
      expect(img.getAttribute('src')).toBe(DATA);
      // the inline copy fails too (no WebP decoder): neutral, then the URL once more
      img.onerror();
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK);
      vi.advanceTimersByTime(AVATAR_RETRY_MS);
      expect(img.getAttribute('src')).toBe(url);
      img.onerror();
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK);
      vi.advanceTimersByTime(10 * AVATAR_RETRY_MS);
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK); // one retry only
    });

    test('/avatar URL without an inline copy (per-socket payload): neutral, one retry after 3 s', () => {
      const img = applyAvatarImg(document.createElement('img'), URL1); // default fallback is profile1
      img.onerror(); // 429 / 503 / 404
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK);
      expect(img.getAttribute('src')).not.toBe('assets/profile1.png');
      vi.advanceTimersByTime(AVATAR_RETRY_MS - 1);
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK);
      vi.advanceTimersByTime(1);
      expect(img.getAttribute('src')).toBe(URL1); // the retry loads
      img.onerror();
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK);
    });

    test('a newer src cancels a pending retry; re-applying the same src keeps the pending retry', () => {
      const img = applyAvatarImg(document.createElement('img'), URL1);
      img.onerror();
      applyAvatarImg(img, CUSTOM_FALLBACK); // same as shown: no-op
      vi.advanceTimersByTime(AVATAR_RETRY_MS);
      expect(img.getAttribute('src')).toBe(URL1);
      img.onerror();
      applyAvatarImg(img, 'assets/avatars/v1/profile9.webp'); // the seat changed meanwhile
      vi.advanceTimersByTime(AVATAR_RETRY_MS);
      expect(img.getAttribute('src')).toBe('assets/avatars/v1/profile9.webp');
    });

    test('a failed inline data URL gets the neutral fallback', () => {
      const img = applyAvatarImg(document.createElement('img'), DATA);
      img.onerror();
      expect(img.getAttribute('src')).toBe(CUSTOM_FALLBACK);
      expect(img.onerror).toBeNull();
    });
  });
});

describe('ingress fold (capable shape -> one pic field; legacy shape untouched)', () => {
  test('positionUpdate', () => {
    const cap = { positions: [1, 2, 3, 4], pics: [DATA, 5, null, 9], avatarUrls: { 1: URL1 } };
    expect(foldAvatarPayload('positionUpdate', cap).pics).toEqual([URL1, 5, null, 9]);
    const leg = { positions: [1, 2, 3, 4], pics: [DATA, 5, null, 9] };
    expect(foldAvatarPayload('positionUpdate', leg).pics).toEqual([DATA, 5, null, 9]);
  });

  test('gameStart playerInfo, rejoin / restore / spectatorJoined players', () => {
    const gs = { playerInfo: [{ position: 1, pic: null }, { position: 2, pic: 4 }], avatarUrls: { 1: URL1 } };
    expect(foldAvatarPayload('gameStart', gs).playerInfo.map((p) => p.pic)).toEqual([URL1, 4]);
    for (const ev of ['rejoinSuccess', 'restorePlayerState', 'spectatorJoined']) {
      const d = { players: [{ position: 3, pic: null }, { position: 4, pic: DATA }], avatarUrls: { 3: URL2 } };
      expect(foldAvatarPayload(ev, d).players.map((p) => p.pic)).toEqual([URL2, DATA]);
      const legacy = { players: [{ position: 3, pic: DATA }] };
      expect(foldAvatarPayload(ev, legacy).players[0].pic).toBe(DATA);
    }
    expect(foldAvatarPayload('spectatorJoined', { username: 'x', spectatorCount: 2 })).toEqual({ username: 'x', spectatorCount: 2 });
  });

  test('playerActiveMode, profile rows and replies', () => {
    expect(foldAvatarPayload('playerActiveMode', { position: 2, pic: DATA, avatarUrl: URL1 }).pic).toBe(URL1);
    expect(foldAvatarPayload('playerActiveMode', { position: 2, pic: DATA }).pic).toBe(DATA);
    const lb = { success: true, leaderboard: [{ username: 'kim', customProfilePic: null }, { username: 'ivy', customProfilePic: null, profilePic: 3 }], avatarUrls: { kim: URL1 } };
    expect(foldAvatarPayload('leaderboardResponse', lb).leaderboard.map((r) => r.customProfilePic)).toEqual([URL1, null]);
    const sp = { success: true, players: [{ username: 'kim', customProfilePic: null }], avatarUrls: { kim: URL1 } };
    expect(foldAvatarPayload('searchPlayersResponse', sp).players[0].customProfilePic).toBe(URL1);
    for (const ev of ['profileResponse', 'playerProfileResponse']) {
      expect(foldAvatarPayload(ev, { success: true, profile: { customProfilePic: null }, avatarUrl: URL1 }).profile.customProfilePic).toBe(URL1);
      expect(foldAvatarPayload(ev, { success: true, profile: { customProfilePic: DATA } }).profile.customProfilePic).toBe(DATA);
    }
    expect(foldAvatarPayload('profilePicUploadResponse', { success: true, customProfilePic: DATA, avatarUrl: URL1 }).customProfilePic).toBe(URL1);
    expect(foldAvatarPayload('profilePicUploadResponse', { success: false, message: 'x' })).toEqual({ success: false, message: 'x' });
  });

  test('only same-origin /avatar URLs are folded in', () => {
    expect(foldUrls(DATA, 'https://evil.example/a.png')).toBe(DATA);
    const d = { positions: [1], pics: [5], avatarUrls: { 1: 'javascript:alert(1)' } };
    expect(foldAvatarPayload('positionUpdate', d).pics).toEqual([5]);
    expect(foldAvatarPayload('chatMessage', 'x')).toBe('x');
  });
});

describe('clientHello wiring', () => {
  function mockSocket() {
    const handlers = {};
    const any = [];
    const sent = [];
    return {
      sent,
      on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
      onAny: (fn) => any.push(fn),
      emit: (ev, data) => sent.push([ev, data]),
      fire: (ev, data) => { any.forEach((f) => f(ev, data)); (handlers[ev] || []).forEach((f) => f(data)); },
    };
  }

  test('installed while disconnected: one hello, buffered ahead of anything else; again on every reconnect', () => {
    const s = mockSocket();
    s.connected = false;
    installAvatarSupport(s, { version: '1.0.0', build: 'abc1234' });
    s.emit('restoreSession', { username: 'kim' });
    s.fire('connect'); // flushes the buffered hello + restoreSession: no second hello
    s.emit('rejoinGame', {});
    s.fire('connect');
    expect(s.sent.map(([ev]) => ev)).toEqual(['clientHello', 'restoreSession', 'rejoinGame', 'clientHello']);
    expect(s.sent[0][1]).toEqual({ client: 'web', version: '1.0.0', build: 'abc1234', caps: ['avatarUrl'] });
  });

  test('installed while connected: hello now, and on every reconnect', () => {
    const s = mockSocket();
    s.connected = true;
    installAvatarSupport(s, {});
    s.fire('connect');
    expect(s.sent.map(([ev]) => ev)).toEqual(['clientHello', 'clientHello']);
  });

  test('incoming messages are folded before the listeners see them', () => {
    const s = mockSocket();
    installAvatarSupport(s, {});
    let seen;
    s.on('gameStart', (d) => { seen = d.playerInfo[0].pic; });
    s.fire('gameStart', { playerInfo: [{ position: 1, pic: null }], avatarUrls: { 1: URL1 } });
    expect(seen).toBe(URL1);
  });

  test('a socket without onAny (very old client lib) cannot fold URLs: it says hello with no caps (legacy shape)', () => {
    const s = mockSocket();
    delete s.onAny;
    expect(() => installAvatarSupport(s, {})).not.toThrow();
    expect(s.sent[0]).toEqual(['clientHello', { client: 'web', version: '0.0.0', build: '', caps: [] }]);
    expect(clientHello(undefined, undefined)).toEqual({ client: 'web', version: '0.0.0', build: '', caps: ['avatarUrl'] });
  });
});

describe('render sites', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="game-container"></div>'; });

  test('no copied avatar branches outside utils/avatar.js', () => {
    const root = path.resolve(__dirname, '..');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.endsWith('.test.js')) files.push(p);
    });
    walk(root);
    const offenders = files.filter((f) => !f.endsWith(path.join('utils', 'avatar.js')))
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf8');
        return src.includes("startsWith('data:image')") || src.includes('`assets/profile${');
      });
    expect(offenders).toEqual([]);
  });

  test('search results use lazy, async avatars (URL, inline and stock)', async () => {
    const { showPlayerSearchPage, updatePlayerSearchResults, removePlayerSearchPage } = await import('../ui/screens/PlayerSearchPage.js');
    showPlayerSearchPage({ emit: () => {} });
    updatePlayerSearchResults([
      { username: 'kim', customProfilePic: URL1, profilePic: 2, gamesPlayed: 3, wins: 1 },
      { username: 'ivy', customProfilePic: DATA, profilePic: 2, gamesPlayed: 3, wins: 1 },
      { username: 'bo', customProfilePic: null, profilePic: 7, gamesPlayed: 3, wins: 1 },
    ]);
    const imgs = [...document.querySelectorAll('#playerSearchResults img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([URL1, DATA, 'assets/avatars/v1/profile7.webp']);
    for (const i of imgs) {
      expect(i.getAttribute('loading')).toBe('lazy');
      expect(i.getAttribute('decoding')).toBe('async');
    }
    removePlayerSearchPage();
  });

  test('leaderboard rows use lazy, async avatars', async () => {
    const { showLeaderboardPage, removeLeaderboardPage } = await import('../ui/screens/LeaderboardPage.js');
    showLeaderboardPage([
      { username: 'kim', customProfilePic: URL1, profilePic: 2, ...STATS },
      { username: 'bo', customProfilePic: null, profilePic: 7, ...STATS },
    ], { emit: () => {} });
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src'));
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(expect.arrayContaining([URL1, 'assets/avatars/v1/profile7.webp']));
    for (const i of imgs) expect(i.getAttribute('loading')).toBe('lazy');
    removeLeaderboardPage();
  });
});

describe('snapshot v2 parser', () => {
  test('accepts seat.avatarUrl (string or null) and keeps a known URL for a withheld custom picture', () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../contract/fixtures/v2/bidding-mid.json'), 'utf8')).snapshot;
    const snap = JSON.parse(JSON.stringify(fixture));
    snap.seats[0] = { ...snap.seats[0], hasCustomPic: true, customPic: null, avatarUrl: URL1 };
    snap.partial = ['customPics'];
    expect(parseSnapshotV2(snap).ok).toBe(true);
    snap.seats[0].avatarUrl = null;
    expect(parseSnapshotV2(snap).ok).toBe(true);
    snap.seats[0].avatarUrl = 5;
    expect(parseSnapshotV2(snap).ok).toBe(false);
    snap.seats[0].avatarUrl = URL1;
    const merged = mergeSnapshot(null, parseSnapshotV2(snap).snapshot, { pics: { [snap.seats[0].username]: URL1 } });
    expect(merged.seats[0].customPic).toBe(URL1);
  });
});
