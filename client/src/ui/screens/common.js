/**
 * Shared pieces of the DOM screens (item 18b): a chat line, a chat form,
 * button variants. Classes from styles/screens.css and the kit; no inline
 * style but the one per-user value, the chat name hue (--name-hue).
 * User text (names, messages) always goes in as text, never as markup.
 */
import { el, createButton, BUTTON_VARIANTS } from '../kit/index.js';
import { extractHue, hashToHue } from '../../utils/colors.js';

/**
 * The username's hue on a chat name: the ONE per-user dynamic value on the
 * screens (a number; screens.css draws hsl(var(--name-hue) 70% 72%), which
 * keeps every hue at 4.5:1 on the chat well: screenStyles.test.js).
 */
export function setNameHue(node, color, username = '') {
  const parsed = typeof color === 'string' ? extractHue(color) : null;
  const hue = parsed ?? hashToHue(String(username));
  node.style.setProperty('--name-hue', String(hue));
}

/** mm/dd hh:mm of a chat timestamp. */
export function formatChatTime(timestamp) {
  const date = new Date(timestamp);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * One chat line: [time] name: message.
 * @param {Object} o
 * @param {string} o.username
 * @param {string} o.message
 * @param {number} [o.timestamp]
 * @param {string} [o.color] - the session's distinct color (hsl string) for this name
 * @param {boolean} [o.isSpectator]
 */
export function chatLine({ username, message, timestamp = null, color = null, isSpectator = false }) {
  const line = el('div', { className: `chat-line${isSpectator ? ' is-spectator' : ''}` });
  if (timestamp) line.appendChild(el('span', { className: 'chat-line__time', text: `${formatChatTime(timestamp)} ` }));
  const name = el('span', { className: 'chat-line__name', text: `${username}: ` });
  setNameHue(name, color, username);
  line.appendChild(name);
  line.appendChild(el('span', { className: 'chat-line__text', text: message }));
  return line;
}

/**
 * A chat input with its Send button; Enter or Send emits the trimmed text.
 * @returns {{row: HTMLElement, input: HTMLInputElement, send: HTMLButtonElement}}
 */
export function chatForm({ inputId, label = 'Chat message', onSend }) {
  const input = el('input', {
    className: 'kit-input',
    attrs: { id: inputId, type: 'text', placeholder: 'Type a message...', 'aria-label': label, autocomplete: 'off' },
  });
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  const send = createButton({ label: 'Send', variant: 'primary', onClick: submit });
  return { row: el('div', { className: 'chat-form', children: [input, send] }), input, send };
}

/** Switch a kit button's variant in place. */
export function setButtonVariant(btn, variant) {
  if (!btn) return;
  for (const v of BUTTON_VARIANTS) btn.classList.remove(`kit-btn--${v}`);
  btn.classList.add(`kit-btn--${variant}`);
}
