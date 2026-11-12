import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRestartNotice, LOSS, RESTART_LOSS_TEXT, RESTART_NOTICE_KEY, RESTART_NOTICE_TTL_MS,
} from './restartNotice.js';

function memory() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

function throwing() {
  const fail = () => { throw new Error('SecurityError'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

describe('restartNotice', () => {
  let t;
  let storage;
  const now = () => t;

  beforeEach(() => {
    t = 1_000_000;
    storage = memory();
  });

  it('records the loss and tells it once; later paths see it was shown', () => {
    const notice = createRestartNotice({ storage, now });
    notice.note(LOSS.SEAT);
    expect(notice.pending).toBe(LOSS.SEAT);
    expect(notice.shown).toBe(false);
    expect(notice.take()).toBe(RESTART_LOSS_TEXT[LOSS.SEAT]);
    expect(notice.take()).toBeNull();
    expect(notice.shown).toBe(true);
    notice.clear();
    expect(notice.shown).toBe(false);
    expect(storage.map.has(RESTART_NOTICE_KEY)).toBe(false);
  });

  it('nothing to lose (the main room): nothing recorded, and an older record goes', () => {
    const notice = createRestartNotice({ storage, now });
    notice.note(LOSS.LOBBY);
    notice.note(null);
    expect(notice.pending).toBeNull();
    expect(notice.take()).toBeNull();
    notice.note('somewhere');
    expect(notice.take()).toBeNull();
  });

  it('survives a reload (sessionStorage with a timestamp) and expires after about two minutes', () => {
    createRestartNotice({ storage, now }).note(LOSS.TOURNAMENT);
    const reloaded = createRestartNotice({ storage, now });
    t += RESTART_NOTICE_TTL_MS - 1;
    expect(reloaded.pending).toBe(LOSS.TOURNAMENT);
    t += 2;
    expect(reloaded.take()).toBeNull();
    expect(storage.map.has(RESTART_NOTICE_KEY)).toBe(false);
  });

  it('a clock that went back, garbage, or a wrong shape is no record', () => {
    const notice = createRestartNotice({ storage, now });
    notice.note(LOSS.SPECTATOR);
    t -= 10;
    expect(notice.take()).toBeNull();
    storage.setItem(RESTART_NOTICE_KEY, '{"kind":"seat"}');
    expect(notice.take()).toBeNull();
    storage.setItem(RESTART_NOTICE_KEY, 'not json');
    expect(notice.take()).toBeNull();
  });

  it('storage that throws (private mode, blocked): this page still knows', () => {
    const notice = createRestartNotice({ storage: throwing(), now });
    notice.note(LOSS.LOBBY);
    expect(notice.take()).toBe(RESTART_LOSS_TEXT[LOSS.LOBBY]);
    expect(notice.take()).toBeNull();
    const none = createRestartNotice({ storage: null, now });
    none.note(LOSS.SEAT);
    expect(none.pending).toBe(LOSS.SEAT);
  });

  it('the texts say what happened; only an unfinished game claims no stats', () => {
    expect(RESTART_LOSS_TEXT[LOSS.SEAT]).toBe("Your game ended because the server restarted for an update. It won't count toward your stats.");
    expect(RESTART_LOSS_TEXT[LOSS.SPECTATOR]).toBe('The game you were watching ended because the server restarted for an update.');
    expect(RESTART_LOSS_TEXT[LOSS.LOBBY]).toBe('Your lobby closed because the server restarted for an update.');
    expect(RESTART_LOSS_TEXT[LOSS.TOURNAMENT]).toMatch(/^Your tournament ended because the server restarted for an update\.$/);
    expect(RESTART_LOSS_TEXT[LOSS.TOURNAMENT_SPECTATOR]).toMatch(/tournament you were watching/);
  });
});
