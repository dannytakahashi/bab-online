/**
 * The tournament host's "Rounds 1 2 3 4 5" segmented control (2026-11-25):
 * the lobby phase only, beside Begin (TournamentLobby.addRoundsPicker).
 *
 * A WAI-ARIA radio group like StatsScopeControl (one tab stop on the
 * checked option, the arrow keys move and select, Home / End), with the
 * same pill look (.scope-control__option) and a visible "Rounds" label.
 */

import { el } from '../kit/index.js';

export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 4;

/** A count the server takes (TournamentState.setTotalRounds). */
export function isRoundCount(n) {
  return Number.isInteger(n) && n >= MIN_ROUNDS && n <= MAX_ROUNDS;
}

/** "1 round" / "3 rounds". */
export function roundsLabel(n) {
  return `${n} round${n === 1 ? '' : 's'}`;
}

/**
 * @param {Object} options
 * @param {number} [options.value] - the selected count (default 4)
 * @param {(n: number) => void} [options.onChange] - called when the host picks another count
 * @returns {{element: HTMLElement, getValue: () => number, setValue: (n: number) => void}}
 */
export function createRoundsPicker({ value = DEFAULT_ROUNDS, onChange = null } = {}) {
  let current = isRoundCount(value) ? value : DEFAULT_ROUNDS;
  const counts = [];
  for (let n = MIN_ROUNDS; n <= MAX_ROUNDS; n++) counts.push(n);

  const labelId = 'tournamentRoundsLabel';
  const group = el('div', { className: 'scope-control rounds-picker__group', attrs: { role: 'radiogroup', 'aria-labelledby': labelId } });
  const options = {};
  for (const n of counts) {
    const btn = el('button', {
      className: 'scope-control__option',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'aria-label': roundsLabel(n) },
      dataset: { rounds: String(n) },
      text: String(n),
    });
    btn.addEventListener('click', () => choose(n));
    options[n] = btn;
    group.appendChild(btn);
  }

  function render() {
    for (const n of counts) {
      const on = n === current;
      options[n].setAttribute('aria-checked', String(on));
      options[n].tabIndex = on ? 0 : -1;
    }
  }

  function choose(n, { focus = false } = {}) {
    if (focus) options[n].focus();
    if (n === current) return;
    current = n;
    render();
    onChange?.(n);
  }

  group.addEventListener('keydown', (e) => {
    const i = counts.indexOf(current);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = counts[(i + 1) % counts.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = counts[(i - 1 + counts.length) % counts.length];
    else if (e.key === 'Home') next = counts[0];
    else if (e.key === 'End') next = counts[counts.length - 1];
    if (next != null) {
      e.preventDefault();
      choose(next, { focus: true });
    }
  });

  render();

  const element = el('div', {
    className: 'rounds-picker',
    attrs: { id: 'tournamentRoundsPicker' },
    children: [el('span', { className: 'rounds-picker__label', attrs: { id: labelId }, text: 'Rounds' }), group],
  });

  return {
    element,
    getValue: () => current,
    /** Show `n` as selected without calling onChange (the server's tournamentSettingsUpdated). */
    setValue(n) {
      if (!isRoundCount(n) || n === current) return;
      current = n;
      render();
    },
  };
}
