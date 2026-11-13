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
 *                        hidden until focused)
 *   .hud-teams           the teams: a scrim over the whole table and a
 *                        surface panel (e3) with each team's avatars and
 *                        names, side by side where they fit, else stacked
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

/** What an empty slot says (iOS: "Waiting"). */
export const WAITING = 'Waiting';

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
 * Put the draw layer up (replacing any): title, rule, four waiting slots,
 * the prompt and the keyboard button.
 * @param {Object} opts
 * @param {boolean} [opts.spectator] - no prompt and no button (a spectator never draws)
 * @param {Function} [opts.onDraw] - the button's action (my draw)
 * @returns {HTMLElement}
 */
export function showDrawHud({ spectator = false, onDraw = null } = {}) {
  clearDrawHud();
  const layer = el('div', 'hud-draw');
  layer.classList.toggle('is-spectator', !!spectator);
  const title = el('h2', 'hud-draw__title', DRAW_TEXT.title);
  title.id = 'hud-draw-title';
  layer.setAttribute('role', 'region');
  layer.setAttribute('aria-labelledby', title.id);
  layer.appendChild(title);
  layer.appendChild(el('p', 'hud-draw__rules', DRAW_TEXT.rules));

  const row = el('ol', 'hud-draw__slots');
  row.setAttribute('aria-live', 'polite');
  for (let i = 0; i < 4; i++) {
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
  hudRoot().appendChild(layer);
  return layer;
}

/** A slot's nodes (index 0-3), or null. */
export function drawSlot(index) {
  return drawHud()?.querySelector(`.hud-draw__slot[data-slot="${index}"]`) || null;
}

/**
 * A draw arrived: its slot shows the player (mine in primary) and drops its
 * placeholder (the card lands there on the canvas). `card` names it for a
 * screen reader.
 */
export function fillDrawSlot(index, { username, mine = false, card = null } = {}) {
  const slot = drawSlot(index);
  if (!slot) return null;
  slot.dataset.state = 'drawn';
  slot.classList.toggle('is-mine', !!mine);
  slot.querySelector('.hud-draw__avatar')?.replaceWith(avatarNode('hud-draw__avatar', username));
  const name = slot.querySelector('.hud-draw__name');
  name.textContent = username;
  name.title = username;
  const who = mine ? `${username}, you` : username;
  slot.setAttribute('aria-label', card ? `${who}: ${getCardDisplayName(card)}` : who);
  return slot;
}

/** After my draw (a click, the button or the auto-draw): the prompt and the button go. */
export function endMyDraw() {
  const layer = drawHud();
  if (!layer) return;
  layer.classList.add('has-drawn');
  layer.querySelector('.hud-draw__key')?.remove();
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
  panel.setAttribute('aria-live', 'polite');
  const column = (n, names) => {
    const col = el('div', 'hud-teams__team');
    col.dataset.team = n === 1 ? 'a' : 'b';
    col.appendChild(el('h3', 'hud-teams__label', `Team ${n}`));
    const list = el('ul', 'hud-teams__players');
    for (const name of names || []) {
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
  hudRoot().appendChild(layer);
  // the fade in starts on the next frame (from the CSS start state)
  requestAnimationFrame(() => layer.classList.add('is-shown'));
  return layer;
}

/** Take the draw and teams layers down. */
export function clearDrawHud() {
  drawHud()?.remove();
  teamsHud()?.remove();
}
