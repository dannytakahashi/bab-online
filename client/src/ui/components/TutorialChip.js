/**
 * The "Tutorial on" chip (the tutorial, 2026-11-19; words in
 * state/tutorial.js): while my tutorial is on, a small pill at the left end
 * of my hand box, its bottom level with the lightbulb's spot at its right
 * end (computeTableLayout tutorialChipSpot), with an on/off switch that
 * turns it off (GameScene sends `/tutorial off`). Only the seat owner sees
 * it (state/tutorial.js chipVisible). It sits under the suggestion card in
 * the stacking order (the card's own buttons win), and never over the bid
 * sheet (its clock) or my seat's box. While it shows, the lightbulb takes
 * the layout's chip spot (assistAskSpot chip: a row up where the hand box
 * is too narrow for both side by side), so their hit areas never meet,
 * except on a table both too narrow and too short for that row (at most
 * 560 x 640), where they share the row.
 *
 *   .hud-tutorial            role group "Tutorial"
 *     .hud-tutorial__label   "Tutorial on"
 *     .hud-tutorial__switch  role switch, aria-checked true, "Turn off the tutorial"
 */
import { hudRoot } from '../tableHud.js';
import { CHIP_LABEL, CHIP_OFF_LABEL } from '../../state/tutorial.js';

let chip = null;

/**
 * Show or hide the chip.
 * @param {Object} o
 * @param {boolean} o.visible
 * @param {Function} [o.onOff] - the switch was used
 * @param {boolean} [o.busy] - an off was sent and not answered yet (the switch waits)
 * @returns {HTMLElement|null}
 */
export function syncTutorialChip({ visible = false, onOff = null, busy = false } = {}) {
  if (typeof document === 'undefined') return null;
  if (chip && !chip.isConnected) chip = null;
  if (!chip) {
    if (!visible) return null;
    chip = document.createElement('div');
    chip.className = 'hud-tutorial';
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', 'Tutorial');
    const label = document.createElement('span');
    label.className = 'hud-tutorial__label';
    label.textContent = CHIP_LABEL;
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'hud-tutorial__switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'true');
    sw.setAttribute('aria-label', CHIP_OFF_LABEL);
    sw.title = CHIP_OFF_LABEL;
    sw.addEventListener('click', () => {
      if (sw.getAttribute('aria-disabled') === 'true') return;
      chip?._onOff?.();
    });
    chip.append(label, sw);
    hudRoot().appendChild(chip);
  }
  chip._onOff = onOff;
  chip.hidden = !visible;
  chip.parentElement?.classList.toggle('has-tutorial-chip', !!visible);
  const sw = chip.querySelector('.hud-tutorial__switch');
  if (busy) sw.setAttribute('aria-disabled', 'true');
  else sw.removeAttribute('aria-disabled');
  return chip;
}

/** Tests: forget the node. */
export function resetTutorialChip() {
  chip?.parentElement?.classList.remove('has-tutorial-chip');
  chip?.remove();
  chip = null;
}
