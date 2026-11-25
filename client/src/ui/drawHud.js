/**
 * The draw for deal's DOM (the HUD's words and players; the cards are the
 * canvas's: DrawManager). The structure of iOS DrawPhaseView (PR 239):
 *
 *   .hud-draw            title ("Draw for Deal", an h2), the rule under it,
 *                        four slots in draw order (a seat-style avatar with
 *                        the initial, the name, a dashed placeholder where the
 *                        card will land; mine ringed and named in primary),
 *                        the prompt under the deck ("Click a card to draw",
 *                        never for a spectator) and a "Draw a card" button
 *                        for the keyboard and screen readers (visually
 *                        hidden until focused), and one visually hidden
 *                        status line (role status) that says each draw
 *                        ("Mary drew the King of Hearts"); focus moves to
 *                        it when the focused button goes
 *                        A tournament table (startDraw.teams, owner
 *                        2026-11-25) says "Draw for First Deal" and "Partners
 *                        are set for this round. The highest card deals
 *                        first." with the teams on one line under the title
 *                        (.hud-draw__teams: "You & Hannah vs Danny & Clara",
 *                        my team first; it shrinks, then each name is cut,
 *                        so "&" and "vs" always show; read out as "Partners:
 *                        you and Hannah versus Danny and Clara")
 *   .hud-teams           the teams: a scrim over the whole table and a
 *                        surface panel (e3) with each team's avatars and
 *                        names, side by side where they fit, else stacked,
 *                        each column topped by its team's colour (no
 *                        "Team 1" heading: the names are the label, owner
 *                        2026-11-17), and its own status line that says
 *                        the teams by name ("Teams: ann and cat versus bob
 *                        and dan")
 *
 * A long name shrinks (to NAME_MIN_SCALE) before it is cut with an
 * ellipsis, as iOS's minimumScaleFactor (and the old web fitNameLabel).
 *
 * Positions and sizes are the layout's (computeTableLayout draw / teams),
 * as CSS variables on #table-hud (tableHud.applyHudLayout writes them);
 * colors, type and motion are tokens (styles/table.css). Usernames go in
 * as text, never markup. The layer never takes a click (the deck under it
 * does) except its button.
 */
import { hudRoot } from './tableHud.js';
import { applyAvatarImg, avatarSrc } from '../utils/avatar.js';
import { getCardDisplayName } from '../utils/cards.js';
import { DRAW_TEXT } from '../phaser/layout/computeTableLayout.js';
import * as drawCopy from './drawCopy.js';

/** What an empty slot says (iOS: "Waiting"). */
export const WAITING = 'Waiting';

/** The smallest a long name's type goes before the ellipsis (the old web fitNameLabel's 0.6). */
export const NAME_MIN_SCALE = 0.6;

/** The first character of a name, upper case (a bot's robot emoji is one): the avatar's initial. */
export function initialOf(name) {
  const first = Array.from(String(name ?? '').trim())[0] || '?';
  return first.toUpperCase();
}

const el = (tag, cls, text = null) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== null) e.textContent = text;
  return e;
};

/** The draw layer, if it is up. */
export function drawHud() {
  const root = document.getElementById('table-hud') || document.body;
  return root.querySelector(':scope > .hud-draw');
}

/** The teams layer, if it is up. */
export function teamsHud() {
  const root = document.getElementById('table-hud') || document.body;
  return root.querySelector(':scope > .hud-teams');
}

/** A visually hidden live status line (announced when its text changes; focusable from script only). */
function statusNode(cls) {
  const s = el('p', cls);
  s.setAttribute('role', 'status');
  s.setAttribute('aria-live', 'polite');
  s.tabIndex = -1;
  return s;
}

/** Say `text` on a status line (cleared first, so the same words twice are said twice). */
function say(node, text) {
  if (!node) return;
  node.textContent = '';
  node.textContent = text;
}

/** A seat-style avatar: the picture when there is one, else the initial; empty (dashed) for nobody. */
function avatarNode(cls, name, pic = null) {
  const a = el('span', cls);
  a.setAttribute('aria-hidden', 'true');
  if (!name) {
    a.classList.add('is-empty');
    return a;
  }
  if (pic !== null && pic !== undefined) {
    const img = el('img', 'hud-draw-avatar__img');
    img.alt = '';
    applyAvatarImg(img, avatarSrc(pic));
    a.appendChild(img);
  } else {
    a.textContent = initialOf(name);
  }
  return a;
}

/**
 * The teams line of a tournament table's draw: each team's names (mine
 * first, as "You"), "&" between partners and "vs" between the teams as
 * their own spans, so a name can be cut while the words stay; the visible
 * spans are hidden from screen readers, which get teamsSpoken.
 */
function teamsLineNode(teams, me) {
  const { teams: ordered } = drawCopy.orderTeams(teams, me);
  const line = el('p', 'hud-draw__teams');
  const shown = el('span', 'hud-draw__teams-shown');
  shown.setAttribute('aria-hidden', 'true');
  ordered.forEach((team, ti) => {
    if (ti > 0) shown.appendChild(el('span', 'hud-draw__vs', 'vs'));
    const t = el('span', 'hud-draw__team');
    t.classList.toggle('is-mine', team.some((p) => p.mine));
    team.forEach((p, pi) => {
      if (pi > 0) t.appendChild(el('span', 'hud-draw__amp', '&'));
      const n = el('span', 'hud-draw__tname', p.mine ? 'You' : p.name);
      n.title = p.name;
      t.appendChild(n);
    });
    shown.appendChild(t);
  });
  line.appendChild(shown);
  line.appendChild(el('span', 'hud-draw__teams-spoken', drawCopy.teamsSpoken(teams, me)));
  return line;
}

/**
 * The teams line's type shrinks until the whole line fits (to
 * NAME_MIN_SCALE; past that each name is cut with an ellipsis while "&"
 * and "vs" stay). Measured with the names at their full width.
 */
export function fitTeamsLine(node = drawHud()?.querySelector('.hud-draw__teams')) {
  if (!node) return 1;
  node.style.removeProperty('--name-fit');
  node.classList.add('is-measuring');
  const shown = node.querySelector('.hud-draw__teams-shown') || node;
  const fits = () => !(shown.scrollWidth > node.clientWidth + 0.5);
  let fit = 1;
  const cw = node.clientWidth;
  if (cw && !fits()) {
    fit = Math.max(NAME_MIN_SCALE, Math.floor((cw / shown.scrollWidth) * 100) / 100);
    node.style.setProperty('--name-fit', String(fit));
    for (let i = 0; i < 12 && fit > NAME_MIN_SCALE && !fits(); i++) {
      fit = Math.max(NAME_MIN_SCALE, Math.round((fit - 0.02) * 100) / 100);
      node.style.setProperty('--name-fit', String(fit));
    }
  }
  node.classList.remove('is-measuring');
  return fit;
}

/**
 * Put the draw layer up (replacing any): title, rule, four waiting slots,
 * the prompt and the keyboard button.
 * @param {Object} opts
 * @param {boolean} [opts.spectator] - no prompt and no button (a spectator never draws)
 * @param {Function} [opts.onDraw] - the button's action (my draw)
 * @param {Array|null} [opts.teams] - a tournament table's planned teams (startDraw.teams): the draw for first deal
 * @param {string|null} [opts.me] - my username (my team first, as "You")
 * @returns {HTMLElement}
 */
export function showDrawHud({ spectator = false, onDraw = null, slots = 4, rules = null, teams = null, me = null } = {}) {
  clearDrawHud();
  const planned = drawCopy.validTeams(teams);
  const layer = el('div', 'hud-draw');
  layer.classList.toggle('is-spectator', !!spectator);
  layer.classList.toggle('is-planned', !!planned);
  const title = el('h2', 'hud-draw__title', drawCopy.title(!!planned));
  title.id = 'hud-draw-title';
  layer.setAttribute('role', 'region');
  layer.setAttribute('aria-labelledby', title.id);
  layer.appendChild(title);
  if (planned) layer.appendChild(teamsLineNode(planned, spectator ? null : me));
  // (a Get Your Bid table passes its own rule: no partners there)
  layer.appendChild(el('p', 'hud-draw__rules', planned ? drawCopy.rules(true) : (rules ?? drawCopy.rules(false))));

  const row = el('ol', 'hud-draw__slots');
  // (three at a Get Your Bid table: the layout's draw has as many slots)
  for (let i = 0; i < slots; i++) {
    const slot = el('li', 'hud-draw__slot');
    slot.dataset.slot = String(i);
    slot.dataset.state = 'waiting';
    slot.appendChild(avatarNode('hud-draw__avatar', null));
    slot.appendChild(el('span', 'hud-draw__name', WAITING));
    const card = el('span', 'hud-draw__placeholder');
    card.setAttribute('aria-hidden', 'true');
    slot.appendChild(card);
    slot.setAttribute('aria-label', 'Waiting for a player to draw');
    row.appendChild(slot);
  }
  layer.appendChild(row);

  if (!spectator) {
    const prompt = el('p', 'hud-draw__prompt', DRAW_TEXT.prompt);
    prompt.setAttribute('aria-hidden', 'true'); // the button says it
    layer.appendChild(prompt);
    const key = el('button', 'kit-btn kit-btn--secondary hud-draw__key', 'Draw a card');
    key.type = 'button';
    key.addEventListener('click', () => onDraw?.());
    layer.appendChild(key);
  }
  layer.appendChild(statusNode('hud-draw__status'));
  hudRoot().appendChild(layer);
  if (planned) fitTeamsLine(layer.querySelector('.hud-draw__teams'));
  return layer;
}

/** A slot's nodes (index 0-3), or null. */
export function drawSlot(index) {
  return drawHud()?.querySelector(`.hud-draw__slot[data-slot="${index}"]`) || null;
}

/**
 * A long name's type shrinks until it fits its box (to NAME_MIN_SCALE; past
 * that the ellipsis cuts it). Sets --name-fit on the node; returns it.
 */
export function fitName(node) {
  if (!node) return 1;
  node.style.removeProperty('--name-fit');
  const sw = node.scrollWidth;
  const cw = node.clientWidth;
  if (!cw || !(sw > cw + 0.5)) return 1;
  let fit = Math.max(NAME_MIN_SCALE, Math.floor((cw / sw) * 100) / 100);
  node.style.setProperty('--name-fit', String(fit));
  // (text does not scale exactly with its size: hinting, rounding; step
  // down until it fits or the floor, where the ellipsis takes over)
  for (let i = 0; i < 12 && fit > NAME_MIN_SCALE && node.scrollWidth > node.clientWidth; i++) {
    fit = Math.max(NAME_MIN_SCALE, Math.round((fit - 0.02) * 100) / 100);
    node.style.setProperty('--name-fit', String(fit));
  }
  return fit;
}

/** Fit every drawn slot's name and the teams line (after a draw, and after a relayout changed the boxes). */
export function fitDrawNames() {
  drawHud()?.querySelectorAll('.hud-draw__slot[data-state="drawn"] .hud-draw__name').forEach(fitName);
  fitTeamsLine();
}

/**
 * A draw arrived: its slot shows the player (mine in primary); the status
 * line says who drew what. Its dashed placeholder stays until the card
 * lands there (landDrawSlot), so the slot is never empty on the way.
 */
export function fillDrawSlot(index, { username, mine = false, card = null, announce = true } = {}) {
  const slot = drawSlot(index);
  if (!slot) return null;
  slot.dataset.state = 'drawn';
  slot.classList.toggle('is-mine', !!mine);
  slot.querySelector('.hud-draw__avatar')?.replaceWith(avatarNode('hud-draw__avatar', username));
  const name = slot.querySelector('.hud-draw__name');
  name.textContent = username;
  name.title = username;
  fitName(name);
  const who = mine ? `${username}, you` : username;
  const cardName = card ? getCardDisplayName(card) : null;
  slot.setAttribute('aria-label', cardName ? `${who}: ${cardName}` : who);
  if (announce && cardName) say(drawHud()?.querySelector('.hud-draw__status'), `${mine ? 'You' : username} drew the ${cardName}`);
  return slot;
}

/**
 * The card is turning up into slot `index`: its placeholder fades out over
 * `ms` (0: at once).
 */
export function landDrawSlot(index, { ms = 0 } = {}) {
  const slot = drawSlot(index);
  if (!slot) return;
  const ph = slot.querySelector('.hud-draw__placeholder');
  ph?.style.setProperty('--land-ms', `${Math.max(0, ms)}ms`);
  slot.classList.add('has-card');
}

/**
 * After my draw (a click, the button or the auto-draw): the prompt and the
 * button go. A button that had focus hands it to the status line (never
 * to the page's body).
 */
export function endMyDraw() {
  const layer = drawHud();
  if (!layer) return;
  layer.classList.add('has-drawn');
  const key = layer.querySelector('.hud-draw__key');
  if (!key) return;
  const focused = typeof document !== 'undefined' && document.activeElement === key;
  key.remove();
  if (focused) layer.querySelector('.hud-draw__status')?.focus({ preventScroll: true });
}

/** A team's names that are known (a missing or empty one is left out). */
function known(names) {
  return (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n);
}

/**
 * What the teams' status line says: the teams by name, seats 1 and 3 then
 * 2 and 4 ("Teams: ann and cat versus bob and dan"), never a team number
 * (owner 2026-11-17). A team with no known name is left out; '' when
 * neither has one (nothing to say).
 * @param {Object} teams - {team1: [name, name], team2: [name, name]}
 * @returns {string}
 */
export function teamsWords(teams) {
  const sides = [teams?.team1, teams?.team2].map((t) => known(t).join(' and ')).filter(Boolean);
  return sides.length ? `Teams: ${sides.join(' versus ')}` : '';
}

/**
 * The teams panel over a scrim (replacing any).
 * @param {Object} teams - {team1: [name, name], team2: [name, name]}
 * @param {Object} [opts]
 * @param {string} [opts.me] - my username (ringed and named in primary)
 * @param {Function} [opts.picFor] - username -> the seat's pic (positionUpdate came first), or null
 */
export function showTeamsHud(teams, { me = null, picFor = () => null } = {}) {
  teamsHud()?.remove();
  const layer = el('div', 'hud-teams');
  layer.appendChild(el('div', 'hud-teams__scrim'));
  const panel = el('section', 'hud-teams__panel');
  panel.setAttribute('aria-label', 'Teams');
  const column = (n, names) => {
    const col = el('div', 'hud-teams__team');
    col.dataset.team = n === 1 ? 'a' : 'b';
    const list = el('ul', 'hud-teams__players');
    for (const name of known(names)) {
      const row = el('li', 'hud-teams__player');
      row.classList.toggle('is-mine', !!me && name === me);
      row.appendChild(avatarNode('hud-teams__avatar', name, picFor(name)));
      const label = el('span', 'hud-teams__name', name);
      label.title = name;
      row.appendChild(label);
      list.appendChild(row);
    }
    col.appendChild(list);
    return col;
  };
  panel.appendChild(column(1, teams?.team1));
  panel.appendChild(el('span', 'hud-teams__vs', 'vs'));
  panel.appendChild(column(2, teams?.team2));
  layer.appendChild(panel);
  // (an empty live region first, its words a frame later: a region added
  // with its text already in it may not be announced)
  const status = statusNode('hud-teams__status');
  layer.appendChild(status);
  const words = teamsWords(teams);
  hudRoot().appendChild(layer);
  // the fade in starts on the next frame (from the CSS start state)
  requestAnimationFrame(() => {
    layer.classList.add('is-shown');
    say(status, words);
  });
  return layer;
}

/** Take the draw and teams layers down. */
export function clearDrawHud() {
  drawHud()?.remove();
  teamsHud()?.remove();
}
