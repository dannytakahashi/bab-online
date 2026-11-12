/**
 * The parked tab after the active tab closes (session-quirks verifier,
 * 2026-11-11): the server tells the parked tab `sessionSuperseded {reason:
 * 'otherClosed'}` (2 s after the other tab's socket dropped, if no tab took
 * the session back). The notice then reads "The other BAB Online tab was
 * closed. Use here to continue.", in place, focus staying on Use here; it
 * never takes the session back by itself. When a tab takes the session
 * again (a slow reload of the other tab) the server says 'newerConnection'
 * and the notice says "open in another tab" again. A refusal never changes
 * the text, and 'otherClosed' never parks a live tab.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload } from '../testing/fakePage.js';
import { NOTICE_ID, NOTICE_TITLE, NOTICE_CLOSED_TITLE, NOTICE_CLOSED_TEXT } from '../ui/components/SupersededNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let n = 1;
let errors;
const nextId = () => `sock-${++n}`;
const notice = () => document.getElementById(NOTICE_ID);
const dialog = () => notice()?.querySelector('[role="alertdialog"]');
const useHere = () => notice()?.querySelector('.superseded-notice__use');
const title = () => document.getElementById(dialog().getAttribute('aria-labelledby')).textContent;
const description = () => document.getElementById(dialog().getAttribute('aria-describedby'));

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error');
});

afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

function inMainRoom() {
  socket.reconnect(nextId());
  socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  socket.clearEmits();
}

describe('the parked tab after the active tab closes', () => {
  it("'otherClosed' on a live tab changes nothing (it never parks)", () => {
    inMainRoom();
    socket.fire('sessionSuperseded', { reason: 'otherClosed' });
    expect(notice()).toBeNull();
    expect(page.session.isParked).toBe(false);
  });

  it('the notice says the other tab was closed, in place; focus stays on Use here; nothing is taken back', () => {
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    const button = useHere();
    expect(document.activeElement).toBe(button);
    expect(title()).toBe(NOTICE_TITLE);
    expect(description().getAttribute('aria-live')).toBe('polite');
    socket.clearEmits();

    socket.fire('sessionSuperseded', { reason: 'otherClosed' });
    expect(document.querySelectorAll(`#${NOTICE_ID}`)).toHaveLength(1);
    expect(useHere()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(title()).toBe(NOTICE_CLOSED_TITLE);
    expect(description().textContent).toBe(NOTICE_CLOSED_TEXT);
    expect(`${title()}. ${description().textContent}`).toBe('The other BAB Online tab was closed. Use here to continue.');
    expect(dialog().dataset.variant).toBe('otherClosed');
    // still paused: no restore, no reconnect by itself
    expect(page.session.isParked).toBe(true);
    expect(socket.emittedNames()).toEqual([]);
    socket.reconnect(nextId());
    expect(socket.emitted('restoreSession')).toEqual([]);
    expect(dialog().dataset.variant).toBe('otherClosed');
  });

  it('a refusal keeps the text; a newer tab taking the session puts the first text back', () => {
    socket.fire('sessionSuperseded', { reason: 'newerConnection', refused: 'mainRoomChat' });
    expect(title()).toBe(NOTICE_CLOSED_TITLE);
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    expect(title()).toBe(NOTICE_TITLE);
    expect(description().textContent).toMatch(/another tab or window/);
    expect(document.activeElement).toBe(useHere());
    socket.fire('sessionSuperseded', { reason: 'otherClosed' });
    expect(title()).toBe(NOTICE_CLOSED_TITLE);
  });

  it('Use here continues in this tab: a fresh socket restores and the main room comes back', async () => {
    socket.disconnect.mockClear();
    useHere().click();
    expect(notice()).toBeNull();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    await tick(150);
    socket.reconnect(nextId());
    expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.screen).toBe('mainRoom');
    expect(page.session.isParked).toBe(false);
    // a late 'otherClosed' from the old socket does not park the live tab again
    socket.fire('sessionSuperseded', { reason: 'otherClosed' });
    expect(notice()).toBeNull();
    // parked again later: the notice opens with the first text
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    expect(title()).toBe(NOTICE_TITLE);
  });
});
