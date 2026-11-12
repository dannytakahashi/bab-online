/**
 * The full-window screens (owner decision 2026-11-11): the main room, the
 * game lobby and the tournament lobby fill the window with the header on
 * top, their content on the left and their chat in a full-height right-hand
 * column; the content is capped at 1400 px and centred, the chat column at
 * 480 px; below 1100 px wide the layout is compact and below 760 px it
 * stacks; nothing makes the page scroll (lists and chat logs scroll inside
 * themselves) down to the 1024 x 668 desktop minimum.
 *
 * jsdom has no layout and ignores @media, so this checks three ways:
 * - the rendered screens: DOM / reading / focus order, landmarks, the ids,
 *   and the computed style of the real stylesheet (base rules);
 * - a column model evaluated from screens.css at every named viewport
 *   (clamp / max / calc of the tokens), the breakpoints included;
 * - fault injection: each guarantee is broken in a copy of the stylesheet
 *   and the check must catch it.
 * Measured in a browser (built page, live server), see the PR: no page
 * scroll and nothing clipped at 2560x1440, 1920x1080, 1440x790, 1280x620,
 * 1100x700 and 1024x668 on all three screens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readClientFile } from '../../testing/files.js';
import { showMainRoom, addMainRoomChatMessage, removeMainRoom } from './MainRoom.js';
import { showGameLobby, addLobbyChatMessage, removeGameLobby } from './GameLobby.js';
import { showTournamentLobby, addTournamentChatMessage, removeTournamentLobby } from './TournamentLobby.js';
import { showLeaderboardPage, removeLeaderboardPage } from './LeaderboardPage.js';
import { showRecordsPage, removeRecordsPage } from './RecordsPage.js';
import { showPlayerSearchPage, removePlayerSearchPage } from './PlayerSearchPage.js';
import { showProfilePage, removeProfilePage } from './ProfilePage.js';
import { showAdminPanel, removeAdminPanel } from './AdminPanel.js';
import { setIsAdmin } from '../../admin/adminApi.js';
import { appendChatLine, followChatOnResize, CHAT_STICK_SLACK_PX } from './common.js';
import { openModalCount, clearToasts, el } from '../kit/index.js';

const SCREENS_CSS = readClientFile('styles/screens.css');
const TOKENS_CSS = readClientFile('styles/tokens.css');
const PAGE_CSS = ['styles/tokens.css', 'styles.css', 'styles/components.css', 'styles/kit.css', 'styles/screens.css']
  .map(readClientFile).join('\n');

/** The viewports the owner's checks name (the desktop minimum last). */
const VIEWPORTS = [[2560, 1440], [1920, 1080], [1440, 790], [1280, 620], [1100, 700], [1024, 668]];
const CAP = 1400;
const CHAT_MIN = 280;
const CHAT_MAX = 520; // readable chat lines (the design's 420-520 px)

// ---------- a small CSS reader ----------

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `@media <query>` block, or null. */
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return null;
  let depth = 0;
  const open = css.indexOf('{', start);
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unclosed @media block');
}

/** The top-level text of a stylesheet (no @media blocks). */
function topLevel(css) {
  let out = '';
  let i = 0;
  const text = stripComments(css);
  while (i < text.length) {
    const at = text.indexOf('@media', i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let depth = 0;
    let j = text.indexOf('{', at);
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

/** Declarations of `selector { ... }` in `text`, as a map ({} when absent). */
function rule(text, selector) {
  const re = new RegExp(`(^|[\\n}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = stripComments(text).match(re);
  if (!m) return {};
  return Object.fromEntries(m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' ')];
  }));
}

/** The tokens' custom properties (:root of tokens.css). */
function tokenVars() {
  return Object.fromEntries([...TOKENS_CSS.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** Evaluate a CSS length (px, vw, vh, % of the width, calc/clamp/min/max, var()) to px. */
function evalLength(expr, { w, h, vars }) {
  let js = expr;
  for (let guard = 0; /var\(--[\w-]+\)/.test(js); guard++) {
    if (guard > 20) throw new Error(`var loop in ${expr}`);
    js = js.replace(/var\((--[\w-]+)\)/g, (_, n) => {
      if (!(n in vars)) throw new Error(`unknown ${n}`);
      return `(${vars[n]})`;
    });
  }
  js = js.replace(/calc\(/g, '(')
    .replace(/(\d*\.?\d+)px/g, '$1')
    .replace(/(\d*\.?\d+)vw/g, `($1*${w}/100)`)
    .replace(/(\d*\.?\d+)vh/g, `($1*${h}/100)`)
    .replace(/(\d*\.?\d+)%/g, `($1*${w}/100)`);
  if (/[^\d\s.+\-*/(),a-z]/i.test(js) || /[a-z]/i.test(js.replace(/\b(clamp|min|max)\b/g, ''))) {
    throw new Error(`cannot evaluate ${expr} (${js})`);
  }
  // eslint-disable-next-line no-new-func
  return Function('clamp', 'min', 'max', `return ${js};`)((a, b, c) => Math.max(a, Math.min(b, c)), Math.min, Math.max);
}

/** Split a shorthand at top-level spaces (`a max(b, c)` → ['a', 'max(b, c)']). */
function splitTop(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) { if (cur) parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * The columns of a full-window screen at a viewport, from the stylesheet:
 * the base .screen--full rule, then the compact and stacked media blocks
 * when they apply (max-width queries, as the browser would).
 */
function columnsAt(css, w, h) {
  const base = rule(topLevel(css), '.screen--full');
  let decls = { ...base };
  const media = [...stripComments(css).matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  for (const max of media.sort((a, b) => b - a)) {
    if (w <= max) decls = { ...decls, ...rule(mediaBlock(stripComments(css), `(max-width: ${max}px)`), '.screen--full') };
  }
  const vars = { ...tokenVars(), ...Object.fromEntries(Object.entries(decls).filter(([k]) => k.startsWith('--'))) };
  const [padBlock, padInline = padBlock] = splitTop(decls.padding || '0');
  const padX = evalLength(padInline, { w, h, vars });
  const padY = evalLength(padBlock, { w, h, vars });
  const content = w - 2 * padX;
  const cols = splitTop(decls['grid-template-columns'] || '');
  const areas = (decls['grid-template-areas'] || '').match(/"[^"]*"/g)?.map((r) => r.slice(1, -1).trim().split(/\s+/)) || [];
  const gapCol = evalLength(splitTop(decls.gap || '0').pop(), { w, h, vars });
  const stacked = cols.length === 1;
  const chat = stacked ? content : evalLength(cols[1], { w, h, vars });
  const main = stacked ? content : content - chat - gapCol;
  return { decls, padX, padY, content, chat, main, areas, cols, stacked, rows: splitTop(decls['grid-template-rows'] || '') };
}

/** Every broken layout guarantee in a stylesheet (none for screens.css). */
function layoutProblems(css) {
  const problems = [];
  const top = topLevel(css);
  const full = rule(top, '.screen--full');
  // fills the window and never scrolls the page
  if (full.inset !== '0') problems.push('.screen--full does not fill the window (inset: 0)');
  if (full.transform !== 'none' || full['max-height'] !== 'none' || full['max-width'] !== 'none') problems.push('.screen--full keeps the old centred box');
  if (full.overflow !== 'hidden') problems.push('.screen--full may scroll (overflow)');
  // the content row may shrink below its content: lists scroll, not the page
  const rows = splitTop(full['grid-template-rows'] || '');
  if (rows[rows.length - 1] !== 'minmax(0, 1fr)') problems.push('the content row is not minmax(0, 1fr)');
  if (rule(top, '.screen--full > .screen-header')['grid-area'] !== 'header') problems.push('the header is not in the header area');
  for (const sel of ['.screen-main', '.screen-chat']) {
    const r = rule(top, sel);
    if (r['min-height'] !== '0' || r['min-width'] !== '0') problems.push(`${sel} cannot shrink (min-height / min-width 0)`);
  }
  if (rule(top, '.screen-main')['grid-area'] !== 'main') problems.push('.screen-main is not in the main area');
  // a window too short for the content column (stacked at about 700 x 600:
  // the lobby's seats and Ready / Add Bot / Leave): the column scrolls, its
  // focus rings inside the clip, instead of running under the chat
  const mainScroll = rule(top, '.screen--full > .screen-main');
  if (mainScroll['overflow-y'] !== 'auto') problems.push('the content column does not scroll when the window is too short for it');
  if (mainScroll.padding !== 'var(--space-1)' || mainScroll.margin !== 'calc(-1 * var(--space-1))') problems.push('the content column clips its focus rings');
  if (rule(top, '.screen-chat')['grid-area'] !== 'chat') problems.push('.screen-chat is not in the chat area');
  // what grows scrolls inside itself
  const scrollers = {
    '.chat-log': { flex: '1', 'min-height': '0', 'overflow-y': 'auto' },
    '.room-list': { flex: '1', 'min-height': '0', 'overflow-y': 'auto' },
    '.tournament-scoreboard-wrap': { 'overflow-y': 'auto' },
    '.tournament-players': { 'overflow-y': 'auto' },
    '.tournament-games': { 'overflow-y': 'auto' },
  };
  for (const [sel, want] of Object.entries(scrollers)) {
    const r = rule(top, sel);
    for (const [k, v] of Object.entries(want)) if (r[k] !== v) problems.push(`${sel} ${k} is ${r[k]}, not ${v}`);
  }
  // the tournament's standings and roster share a short window (each shrinks
  // to a floor and scrolls) instead of pushing the controls off it
  for (const sel of ['.screen--tournament .tournament-scoreboard-wrap', '.tournament-roster']) {
    const r = rule(top, sel);
    if (r.flex !== '0 1 auto' || r['min-height'] !== 'var(--screen-min-scroller)') problems.push(`${sel} cannot shrink to its floor (flex ${r.flex}, min-height ${r['min-height']})`);
  }
  const rosterItem = rule(top, '.tournament-roster > .screen-section');
  if (rosterItem['min-height'] !== '0' || rosterItem['max-height'] !== 'none') problems.push('the roster sections do not follow the roster height');
  if (!/^\d+px$/.test(full['--screen-min-scroller'] || '')) problems.push('no --screen-min-scroller floor');
  // the breakpoints
  if (!mediaBlock(stripComments(css), '(max-width: 1099px)')) problems.push('no compact breakpoint below 1100 px');
  if (!mediaBlock(stripComments(css), '(max-width: 759px)')) problems.push('no stacked breakpoint below 760 px');
  // the columns at every named viewport
  for (const [w, h] of VIEWPORTS) {
    let c;
    try {
      c = columnsAt(css, w, h);
    } catch (e) {
      problems.push(`${w}x${h}: ${e.message}`);
      continue;
    }
    const at = `${w}x${h}`;
    if (c.content > CAP + 0.5) problems.push(`${at}: content ${c.content} px wider than the ${CAP} px cap`);
    if (c.padX < 16 - 0.01) problems.push(`${at}: side gutter ${c.padX} px under 16`);
    if (c.stacked) { problems.push(`${at}: stacked at a desktop width`); continue; }
    if (JSON.stringify(c.areas) !== JSON.stringify([['header', 'header'], ['main', 'chat']])) problems.push(`${at}: areas ${JSON.stringify(c.areas)} (chat must be the right-hand column, the header across)`);
    if (c.cols[0] !== 'minmax(0, 1fr)') problems.push(`${at}: the left column is ${c.cols[0]}, not the rest of the width`);
    if (c.chat < CHAT_MIN || c.chat > CHAT_MAX) problems.push(`${at}: chat column ${c.chat} px outside ${CHAT_MIN}-${CHAT_MAX}`);
    if (c.main < c.chat) problems.push(`${at}: the content column (${c.main} px) is narrower than the chat (${c.chat} px)`);
  }
  // a narrow window stacks the chat under the content
  const narrow = columnsAt(css, 700, 668);
  if (!narrow.stacked || JSON.stringify(narrow.areas) !== JSON.stringify([['header'], ['main'], ['chat']])) problems.push('700 px: not stacked header / main / chat');
  return problems;
}

describe('the full-window layout in screens.css', () => {
  it('holds every guarantee at every named viewport', () => {
    expect(layoutProblems(SCREENS_CSS)).toEqual([]);
  });

  it('the column model: capped and centred on a big monitor, compact at the desktop minimum', () => {
    const big = columnsAt(SCREENS_CSS, 2560, 1440);
    expect(big.content).toBe(1400);
    expect(big.padX).toBe(580); // (2560 - 1400) / 2: margins, not stretched rows
    expect(big.chat).toBe(480);
    const hd = columnsAt(SCREENS_CSS, 1920, 1080);
    expect(hd.content).toBe(1400);
    expect(hd.chat).toBe(480);
    const min = columnsAt(SCREENS_CSS, 1024, 668);
    expect(min.padX).toBe(16);
    expect(min.chat).toBeCloseTo(327.68, 1);
    expect(min.main).toBeGreaterThan(600);
    const edge = columnsAt(SCREENS_CSS, 1100, 700); // just above the breakpoint
    expect(edge.chat).toBe(360);
    expect(edge.main).toBeGreaterThan(640);
  });

  it('the screens set no magic hex and stack below every overlay (tokens: panel < modal < toast < transition < banner)', () => {
    const z = tokenVars();
    const order = ['--z-panel', '--z-modal', '--z-toast', '--z-transition', '--z-banner'].map((k) => Number(z[k]));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rule(topLevel(SCREENS_CSS), '.screen')['z-index']).toBe('var(--z-panel)');
    expect(rule(topLevel(SCREENS_CSS), '.screen--full')['z-index']).toBeUndefined();
    expect(rule(topLevel(readClientFile('styles/kit.css')), '.kit-modal-backdrop')['z-index']).toBe('var(--z-modal)');
  });

  it('the retired fixed boxes are gone (800 x 600, the 400 px column, 800 x 650, the 820 px lobby squeeze)', () => {
    const css = stripComments(SCREENS_CSS);
    expect(css).not.toMatch(/\.screen--main-room\s*\{[^}]*width:\s*800px/);
    expect(css).not.toMatch(/\.screen--tournament\s*\{[^}]*height:\s*650px/);
    expect(css).not.toMatch(/\.screen--lobby\s*\{[^}]*width:\s*400px/);
    expect(css).not.toMatch(/@media \(max-height: 820px\)/);
    expect(css).not.toMatch(/chat-log--short/);
  });
});

describe('fault injection: each broken guarantee is caught', () => {
  const swap = (from, to) => {
    expect(SCREENS_CSS, from).toContain(from);
    return SCREENS_CSS.replace(from, to);
  };
  const cases = {
    'chat moved to the left': () => swap('"main chat"', '"chat main"'),
    'no content cap': () => swap('--screen-cap: 1400px', '--screen-cap: 100000px'),
    'an unbounded chat column': () => swap('--screen-chat-w: clamp(360px, 30vw, 480px)', '--screen-chat-w: clamp(360px, 50vw, 1200px)'),
    'a chat column too narrow on the compact layout': () => swap('--screen-chat-w: clamp(280px, 32vw, 340px)', '--screen-chat-w: 200px'),
    'the page may scroll': () => swap('    overflow: hidden;\n    /* the room itself', '    overflow: auto;\n    /* the room itself'),
    'the content row grows with its content': () => swap('grid-template-rows: auto minmax(0, 1fr);', 'grid-template-rows: auto 1fr;'),
    'the old centred box comes back': () => swap('    transform: none;\n    width: auto;', '    transform: translate(-50%, -50%);\n    width: auto;'),
    'the chat log cannot shrink': () => swap('.chat-log {\n    flex: 1;\n    min-height: 0;', '.chat-log {\n    flex: 1;\n    min-height: auto;'),
    'the chat column cannot shrink': () => swap('.screen-chat {\n    grid-area: chat;\n    display: flex;\n    flex-direction: column;\n    min-width: 0;\n    min-height: 0;', '.screen-chat {\n    grid-area: chat;\n    display: flex;\n    flex-direction: column;\n    min-width: 0;'),
    'no compact breakpoint': () => swap('@media (max-width: 1099px)', '@media (max-width: 1px)'),
    'no stacked breakpoint': () => swap('@media (max-width: 759px)', '@media (max-width: 2px)'),
    'the tournament roster cannot shrink': () => swap('.tournament-roster {\n    display: flex;\n    gap: var(--space-3);\n    flex: 0 1 auto;', '.tournament-roster {\n    display: flex;\n    gap: var(--space-3);\n    flex: none;'),
    'the standings cannot shrink': () => swap('.screen--tournament .tournament-scoreboard-wrap {\n    flex: 0 1 auto;', '.screen--tournament .tournament-scoreboard-wrap {\n    flex: none;'),
    'the content column cannot scroll (a short stacked lobby runs under the chat)': () => swap('.screen--full > .screen-main {\n    overflow-y: auto;', '.screen--full > .screen-main {\n    overflow-y: visible;'),
    'the content column clips its focus rings': () => swap('    padding: var(--space-1);\n    margin: calc(-1 * var(--space-1));', '    padding: 0;\n    margin: 0;'),
    'the lobby list does not scroll inside itself': () => swap('.room-list {\n    flex: 1;\n    min-height: 0;\n    overflow-y: auto;', '.room-list {\n    flex: 1;\n    min-height: 0;\n    overflow-y: visible;'),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    it(name, () => {
      expect(layoutProblems(mutate()).length).toBeGreaterThan(0);
    });
  }
});

// ---------- the rendered screens ----------

function fakeSocket() {
  const sent = [];
  return { sent, emit: vi.fn((event, data) => sent.push([event, data])) };
}

let socket;
let styleEl;

beforeEach(() => {
  socket = fakeSocket();
  styleEl = document.createElement('style');
  styleEl.textContent = PAGE_CSS;
  document.head.appendChild(styleEl);
});

afterEach(() => {
  removeAdminPanel();
  setIsAdmin(false);
  removeLeaderboardPage();
  removeRecordsPage();
  removePlayerSearchPage();
  removeProfilePage();
  removeMainRoom();
  removeGameLobby();
  removeTournamentLobby();
  clearToasts();
  document.body.replaceChildren();
  styleEl.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(openModalCount()).toBe(0);
});

const MESSAGES = [{ username: 'ann', message: 'hi', timestamp: 1700000000000 }, { username: 'bob', message: 'yo', timestamp: 1700000001000 }];

function mainRoom() {
  showMainRoom({
    onlineCount: 2, onlineUsers: ['ann', 'bob'], messages: MESSAGES,
    lobbies: [{ id: 'L1', name: 'Lobby', playerCount: 1, players: [{ username: 'ann' }] }], inProgressGames: [], tournaments: [],
  }, socket, 'me');
  return document.getElementById('mainRoomContainer');
}

function lobby() {
  showGameLobby({ lobbyId: 'L1', players: [{ username: 'me', ready: false }], messages: MESSAGES }, socket, 'me');
  return document.getElementById('gameLobbyContainer');
}

function tournament() {
  showTournamentLobby({
    tournamentId: 't1', name: 'Cup', phase: 'lobby', currentRound: 0, totalRounds: 4, creatorUsername: 'me',
    players: [{ username: 'me', ready: false, isCreator: true }], scoreboard: [], messages: MESSAGES, activeGames: [],
  }, socket, 'me');
  return document.getElementById('tournamentLobbyContainer');
}

const SCREENS = {
  'main room': { open: mainRoom, chatId: 'mainRoomChatMessages', inputId: 'mainRoomChatInput', chatLabel: 'Global chat', mainLabel: 'Game lobbies', mainIds: ['mainRoomLobbyList'] },
  'game lobby': { open: lobby, chatId: 'lobbyChatArea', inputId: 'lobbyChatInput', chatLabel: 'Lobby chat', mainLabel: 'Seats', mainIds: ['lobbyPlayersList', 'lobbyReadyBtn', 'lobbyAddBotBtn'] },
  tournament: { open: tournament, chatId: 'tournamentChatArea', inputId: 'tournamentChatInput', chatLabel: 'Tournament chat', mainLabel: 'Standings', mainIds: ['tournamentScoreboardContainer', 'tournamentActiveGames', 'tournamentPlayersList', 'tournamentButtonRow', 'tournamentReadyBtn', 'tournamentBeginBtn', 'tournamentCancelBtn'] },
};

const FOCUSABLE = 'button:not([hidden]):not([disabled]), input, [tabindex]:not([tabindex="-1"])';

describe('the three screens: one grid, content left, chat right', () => {
  for (const [name, s] of Object.entries(SCREENS)) {
    describe(name, () => {
      it('DOM and reading order: header, then the content, then the chat (its log and field)', () => {
        const root = s.open();
        expect(root.classList.contains('screen--full')).toBe(true);
        const kids = [...root.children];
        expect(kids.map((k) => k.className.split(' ')[0])).toEqual(['screen-header', 'screen-main', 'screen-chat']);
        const [, main, chat] = kids;
        expect(chat.tagName).toBe('SECTION');
        expect(chat.getAttribute('aria-label')).toBe(s.chatLabel);
        expect(chat.querySelector('h2')).not.toBeNull();
        expect(chat.contains(document.getElementById(s.chatId))).toBe(true);
        expect(chat.contains(document.getElementById(s.inputId))).toBe(true);
        expect(main.tagName).toBe('SECTION');
        expect(main.getAttribute('aria-label')).toBe(s.mainLabel);
        for (const id of s.mainIds) expect(main.contains(document.getElementById(id)), id).toBe(true);
        expect(document.getElementById(s.chatId).getAttribute('role')).toBe('log');
      });

      it('focus order: everything in the content column before the chat field and Send', () => {
        const root = s.open();
        const order = [...root.querySelectorAll(FOCUSABLE)];
        const input = document.getElementById(s.inputId);
        const firstChat = order.indexOf(input);
        expect(firstChat).toBeGreaterThan(0);
        const main = root.querySelector('.screen-main');
        const mainItems = order.filter((n) => main.contains(n));
        expect(mainItems.length).toBeGreaterThan(0);
        expect(Math.max(...mainItems.map((n) => order.indexOf(n)))).toBeLessThan(firstChat);
        expect(order.slice(firstChat).every((n) => root.querySelector('.screen-chat').contains(n))).toBe(true);
        // nothing takes itself out of the tab order
        expect(root.querySelectorAll('[tabindex]:not([tabindex="0"])').length).toBe(0);
      });

      it('computed style (the real stylesheet): a fixed full-window grid with the chat column on the right', () => {
        const root = s.open();
        const cs = getComputedStyle(root);
        expect(cs.position).toBe('fixed');
        expect(cs.getPropertyValue('inset')).toBe('0');
        expect(cs.transform).toBe('none');
        expect(cs.maxHeight).toBe('none');
        expect(cs.overflow).toBe('hidden');
        expect(cs.display).toBe('grid');
        expect(cs.getPropertyValue('grid-template-areas').replace(/\s+/g, ' ')).toBe('"header header" "main chat"');
        expect(cs.getPropertyValue('grid-template-columns')).toBe('minmax(0, 1fr) var(--screen-chat-w)');
        expect(cs.getPropertyValue('--screen-cap')).toBe('1400px');
        expect(cs.borderRadius).toBe('0');
        expect(getComputedStyle(root.querySelector('.screen-chat')).getPropertyValue('grid-area')).toBe('chat');
        expect(getComputedStyle(root.querySelector('.screen-main')).getPropertyValue('grid-area')).toBe('main');
        expect(getComputedStyle(root.querySelector('.screen-header')).getPropertyValue('grid-area')).toBe('header');
        const log = getComputedStyle(document.getElementById(s.chatId));
        expect(log.overflowY).toBe('auto');
        expect(log.minHeight).toBe('0');
      });

      it('opens on the newest message', () => {
        const scrolled = vi.spyOn(Element.prototype, 'scrollTop', 'set');
        s.open();
        const log = document.getElementById(s.chatId);
        expect(scrolled.mock.contexts).toContain(log);
      });
    });
  }

  it('the main room: lobbies first, Global Chat after (it used to be on the left)', () => {
    const root = mainRoom();
    const sections = [...root.querySelectorAll('section')].map((n) => n.getAttribute('aria-label'));
    expect(sections).toEqual(['Game lobbies', 'Global chat']);
    // the header, nav and online count span the top
    const header = root.querySelector('.screen-header');
    expect(header.querySelector('nav[aria-label="Main room"]')).not.toBeNull();
    expect(header.contains(document.getElementById('mainRoomOnlineCount'))).toBe(true);
    expect(header.contains(document.getElementById('onlinePlayersTooltip'))).toBe(true);
  });

  it('the main room lobby list is a grid of cards; its headings span it', () => {
    showMainRoom({
      onlineCount: 1, messages: [], lobbies: [{ id: 'L1', playerCount: 1, players: [] }], tournaments: [{ id: 't', name: 'T', phase: 'lobby', playerCount: 1 }],
      inProgressGames: [{ gameId: 'g', currentHand: 1, spectatorCount: 0, score: { team1: 0, team2: 0 }, players: [1, 2, 3, 4].map((position) => ({ position, username: `p${position}` })) }],
    }, socket, 'me');
    const list = document.getElementById('mainRoomLobbyList');
    // jsdom's cascade does not weigh specificity, so the rules are read from the sheet
    const top = topLevel(SCREENS_CSS);
    expect(rule(top, '.screen--main-room .room-list').display).toBe('grid');
    expect(rule(top, '.screen--main-room .room-list')['grid-template-columns']).toBe('repeat(auto-fill, minmax(min(100%, 260px), 1fr))');
    expect(rule(top, '.screen--main-room .room-list > :is(.room-list__heading, .muted-note)')['grid-column']).toBe('1 / -1');
    expect(list.closest('.screen--main-room')).not.toBeNull();
    expect(list.querySelectorAll('.room-list__heading').length).toBe(2);
  });
});

describe('the chat log follows the newest message unless the reader scrolled up', () => {
  /** A log with a fake scroll box: `height` visible px, 20 px per line. */
  function fakeLog(height = 100) {
    const log = el('div', { className: 'chat-log' });
    let top = 0;
    Object.defineProperty(log, 'clientHeight', { get: () => height, configurable: true });
    Object.defineProperty(log, 'scrollHeight', { get: () => log.childElementCount * 20, configurable: true });
    Object.defineProperty(log, 'scrollTop', {
      get: () => top,
      set: (v) => { top = Math.max(0, Math.min(v, log.scrollHeight - height)); },
      configurable: true,
    });
    for (let i = 0; i < 20; i++) log.appendChild(el('div', { text: `line ${i}` }));
    document.body.appendChild(log);
    log.scrollTop = log.scrollHeight;
    return { log, setHeight: (hh) => { height = hh; } };
  }
  const line = (t) => el('div', { text: t });

  it('at the end: a new message scrolls to it', () => {
    const { log } = fakeLog();
    expect(log.scrollTop).toBe(300);
    appendChatLine(log, line('new'));
    expect(log.scrollTop).toBe(320);
  });

  it(`within ${CHAT_STICK_SLACK_PX} px of the end still counts as at the end`, () => {
    const { log } = fakeLog();
    log.scrollTop = 300 - CHAT_STICK_SLACK_PX;
    appendChatLine(log, line('new'));
    expect(log.scrollTop).toBe(320);
  });

  it('scrolled up: a new message keeps the reader\'s place', () => {
    const { log } = fakeLog();
    log.scrollTop = 120;
    appendChatLine(log, line('new'));
    expect(log.scrollTop).toBe(120);
    expect(log.lastElementChild.textContent).toBe('new');
  });

  it('a resize keeps a log that was at the end at the end, and leaves a scrolled-up one alone', () => {
    let callback;
    const observed = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { callback = cb; }
      observe(n) { observed.push(n); }
      disconnect() { disconnect(); }
    });
    const { log, setHeight } = fakeLog();
    followChatOnResize(log);
    expect(observed).toEqual([log]);
    // the column gets shorter (a resize): the reader was at the end
    setHeight(60);
    callback();
    expect(log.scrollTop).toBe(340);
    // scrolled up, then another resize: the place holds
    log.scrollTop = 100;
    log.dispatchEvent(new Event('scroll'));
    setHeight(40);
    callback();
    expect(log.scrollTop).toBe(100);
    // removed from the page: the observer stops itself
    log.remove();
    callback();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('fault injection: an append that always scrolls would lose the reader\'s place (the check catches it)', () => {
    const { log } = fakeLog();
    log.scrollTop = 120;
    const alwaysScroll = (l, n) => { l.appendChild(n); l.scrollTop = l.scrollHeight; };
    alwaysScroll(log, line('new'));
    expect(log.scrollTop).not.toBe(120);
  });

  for (const [name, s] of Object.entries(SCREENS)) {
    it(`${name}: a live message follows at the end and holds when scrolled up`, () => {
      s.open();
      const log = document.getElementById(s.chatId);
      let top = 0;
      Object.defineProperty(log, 'clientHeight', { get: () => 40, configurable: true });
      Object.defineProperty(log, 'scrollHeight', { get: () => log.childElementCount * 20, configurable: true });
      Object.defineProperty(log, 'scrollTop', { get: () => top, set: (v) => { top = Math.max(0, Math.min(v, log.scrollHeight - 40)); }, configurable: true });
      const add = { 'main room': (u, m) => addMainRoomChatMessage(u, m, Date.now()), 'game lobby': addLobbyChatMessage, tournament: (u, m) => addTournamentChatMessage(u, m, false) }[name];
      log.scrollTop = log.scrollHeight; // at the end (2 history lines)
      add('cat', 'one');
      expect(top).toBe(20);
      add('cat', 'two');
      expect(top).toBe(40);
      top = 0; // the reader scrolls up
      add('dan', 'three');
      expect(top).toBe(0);
      expect(log.lastElementChild.textContent).toContain('dan: three');
    });
  }
});

describe('the pages open over the full-window main room as kit modals', () => {
  const pages = {
    Leaderboard: () => showLeaderboardPage([{ username: 'ann', gamesPlayed: 1, winRate: 100, pointsPerGame: 1, bidsPerGame: 1, tricksPerBid: 1, setRate: 0, drag: 0, avgHSI: 1 }], socket),
    Records: () => showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0),
    Players: () => showPlayerSearchPage(socket),
    Profile: () => showProfilePage({ username: 'me', stats: {} }, socket),
    Admin: () => {
      setIsAdmin(true);
      const api = { request: vi.fn(async (action) => ({ requestId: 'x', action, ok: true, players: [], admins: [], entries: [], reports: [], groups: [] })), dispose() {} };
      showAdminPanel(socket, { username: 'me', api });
    },
  };
  for (const [name, open] of Object.entries(pages)) {
    it(`${name}: a dialog on the modal layer above the room; Escape or Close closes it and the room stays`, () => {
      const room = mainRoom();
      const before = openModalCount();
      open();
      expect(openModalCount()).toBe(before + 1);
      const backdrop = [...document.body.children].find((n) => n.classList.contains('kit-modal-backdrop'));
      expect(backdrop, 'backdrop on body').toBeTruthy();
      // later in body than the room, and on the z-modal layer (above z-panel)
      expect(room.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(getComputedStyle(backdrop).zIndex).toBe('var(--z-modal)');
      expect(getComputedStyle(backdrop).position).toBe('fixed');
      // centred by the backdrop's flex box
      expect(getComputedStyle(backdrop).alignItems).toBe('center');
      expect(getComputedStyle(backdrop).justifyContent).toBe('center');
      const dialog = backdrop.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const close = dialog.querySelector('.kit-modal__close');
      expect(close).not.toBeNull();
      close.click();
      expect(openModalCount()).toBe(before);
      expect(document.getElementById('mainRoomContainer')).toBe(room);
    });
  }
});
