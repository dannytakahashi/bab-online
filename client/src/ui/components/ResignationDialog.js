/**
 * "Replace with Bot?" (resignationAvailable): a kit Modal (item 18b; it
 * was an inline-styled div in main.js). Escape or Wait keeps waiting; one
 * offer at a time, keyed by the seat's position so playerReconnected /
 * playerResigned can take that seat's offer down.
 */
import { el, createButton, openModal } from '../kit/index.js';

const DIALOG_ID = 'resignation-dialog';
let current = null; // { position, modal }

/**
 * @param {Object} o
 * @param {number} o.position - the seat on offer
 * @param {string} o.username - its player (user text: set as text)
 * @param {Function} o.onConfirm - Replace with Bot
 */
export function showResignationDialog({ position, username, onConfirm }) {
  dismissResignationDialog();
  const wait = createButton({ label: 'Wait', variant: 'secondary', onClick: () => dismissResignationDialog() });
  wait.id = 'resign-cancel-btn';
  const replace = createButton({
    label: 'Replace with Bot',
    variant: 'primary',
    onClick: () => {
      dismissResignationDialog();
      onConfirm();
    },
  });
  replace.id = 'resign-confirm-btn';
  const modal = openModal({
    title: 'Player Disconnected',
    id: DIALOG_ID,
    className: 'page-modal',
    body: el('p', { className: 'dialog-copy', attrs: { id: 'resign-message' }, text: `${username} did not reconnect. Replace with a bot?` }),
    actions: [wait, replace],
    initialFocus: wait,
    onClose: () => {
      if (current?.modal === modal) current = null;
    },
  });
  modal.backdrop.dataset.position = String(position);
  current = { position, modal };
  return modal;
}

/**
 * Close the open offer (any, or only the one for `position`).
 * @param {number|null} [position]
 */
export function dismissResignationDialog(position = null) {
  if (current && (position === null || String(current.position) === String(position))) {
    const { modal } = current;
    current = null;
    modal.close('api');
  }
  // a stray node (never through the kit) goes too
  const stray = document.getElementById(DIALOG_ID);
  if (stray && (position === null || stray.dataset.position === String(position))) stray.remove();
}
