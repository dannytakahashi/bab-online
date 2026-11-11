/**
 * The component kit's element factories (roadmap item 18a): small
 * functions that build DOM with the kit classes of styles/kit.css. Every
 * look (hover, focus, disabled, pressed) is CSS (:hover, :focus-visible,
 * :disabled); nothing here sets inline colors or hover handlers.
 */

/** document.createElement with classes, attributes and children. */
export function el(tag, { className = '', attrs = {}, text = null, children = [], dataset = {} } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, v] of Object.entries(dataset)) node.dataset[k] = String(v);
  if (text !== null && text !== undefined) node.textContent = String(text);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'];

/**
 * Button. A primary action is never red: 'danger' is for destructive
 * actions only (Return to Lobby is primary).
 * @param {Object} o
 * @param {string} o.label
 * @param {'primary'|'secondary'|'ghost'|'danger'} [o.variant='secondary']
 * @param {'md'|'sm'|'lg'} [o.size='md']
 * @param {Function} [o.onClick]
 */
export function createButton({ label, variant = 'secondary', size = 'md', onClick = null, type = 'button', className = '', attrs = {} } = {}) {
  if (!BUTTON_VARIANTS.includes(variant)) throw new Error(`unknown button variant ${variant}`);
  const btn = el('button', {
    className: ['kit-btn', `kit-btn--${variant}`, size !== 'md' ? `kit-btn--${size}` : '', className].filter(Boolean).join(' '),
    attrs: { type, ...attrs },
    text: label,
  });
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Icon button: a 44 x 44 hit target at least (HIG), whatever its drawn
 * size (--icon-btn-size); the label is its accessible name.
 */
export function createIconButton({ icon, label, onClick = null, className = '', pressed = null } = {}) {
  const btn = el('button', {
    className: ['kit-icon-btn', className].filter(Boolean).join(' '),
    attrs: { type: 'button', 'aria-label': label, title: label, 'aria-pressed': pressed === null ? null : String(!!pressed) },
  });
  btn.innerHTML = icon || '';
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

/** Text input. */
export function createInput({ type = 'text', placeholder = '', value = '', label = null, id = null, className = '' } = {}) {
  const input = el('input', {
    className: ['kit-input', className].filter(Boolean).join(' '),
    attrs: { type, placeholder, id, 'aria-label': label || placeholder || null, autocomplete: 'off' },
  });
  input.value = value;
  return input;
}

/** Panel: a surface with a radius and an elevation (1-3). */
export function createPanel({ tag = 'div', elevation = 2, className = '', children = [] } = {}) {
  return el(tag, { className: ['kit-panel', `kit-elev-${elevation}`, className].filter(Boolean).join(' '), children });
}

/** Chip: a small pill label (tabular numerals). tone: neutral | team-a | team-b | gold | success | danger. */
export function createChip({ label = '', tone = 'neutral', className = '' } = {}) {
  return el('span', { className: ['kit-chip', `kit-chip--${tone}`, className].filter(Boolean).join(' '), text: label });
}

/**
 * Avatar with a ring (team color via data-team a|b) and a turn ring
 * (setAvatarTurn: the opacity-only glow layer of kit.css).
 */
export function createAvatar({ src = '', alt = '', team = null, className = '', imgClassName = '' } = {}) {
  const img = el('img', { className: ['kit-avatar__img', imgClassName].filter(Boolean).join(' '), attrs: { alt, decoding: 'async' } });
  if (src) img.src = src;
  const ring = el('div', { className: ['kit-avatar', className].filter(Boolean).join(' '), children: [img] });
  if (team) ring.dataset.team = team;
  return { ring, img };
}

/** Turn the turn ring on or off. */
export function setAvatarTurn(node, on) {
  node?.classList.toggle('turn-glow', !!on);
}
