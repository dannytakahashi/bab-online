/**
 * The "Human games | Bot games | All games" segmented control at the top of
 * the Leaderboard, Records and Profile views (owner, 2026-11-13; the choice
 * itself lives in state/statsScope.js).
 *
 * WAI-ARIA radio group: one tab stop (the checked option, roving
 * tabindex), the arrow keys move AND select (wrapping), Home / End go to
 * the first / last, Space / Enter (the button's click) select the focused
 * option. Focus stays on the control after a switch, so a keyboard or
 * screen-reader user keeps their place while the view re-renders below.
 *
 * Each option is its short word ("Human") plus the rest of the label
 * (" games") in .scope-control__more, which screens.css visually hides
 * when the control is too narrow for the full labels (a phone): the
 * accessible name and textContent stay "Human games".
 */

import { el } from '../kit/index.js';
import { STATS_SCOPES, STATS_SCOPE_LABELS, STATS_SCOPE_SHORT_LABELS, isStatsScope, DEFAULT_STATS_SCOPE } from '../../state/statsScope.js';

/**
 * @param {Object} options
 * @param {string} [options.value] - the selected scope (default 'human')
 * @param {(scope: string) => void} [options.onChange] - called when the user picks another scope
 * @param {string} [options.label] - accessible name of the group
 * @returns {{element: HTMLElement, getValue: () => string, setValue: (scope: string) => void}}
 */
export function createStatsScopeControl({ value = DEFAULT_STATS_SCOPE, onChange = null, label = 'Which games' } = {}) {
  let current = isStatsScope(value) ? value : DEFAULT_STATS_SCOPE;
  const group = el('div', { className: 'scope-control', attrs: { role: 'radiogroup', 'aria-label': label } });
  const options = {};

  for (const scope of STATS_SCOPES) {
    const full = STATS_SCOPE_LABELS[scope];
    const short = STATS_SCOPE_SHORT_LABELS[scope];
    const rest = full.startsWith(short) ? full.slice(short.length) : '';
    const btn = el('button', {
      className: 'scope-control__option',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
      dataset: { scope },
      text: rest ? short : full,
    });
    if (rest) btn.appendChild(el('span', { className: 'scope-control__more', text: rest }));
    btn.addEventListener('click', () => choose(scope));
    options[scope] = btn;
    group.appendChild(btn);
  }

  function render() {
    for (const scope of STATS_SCOPES) {
      const on = scope === current;
      options[scope].setAttribute('aria-checked', String(on));
      options[scope].tabIndex = on ? 0 : -1;
    }
  }

  function choose(scope, { focus = false } = {}) {
    if (focus) options[scope].focus();
    if (scope === current) return;
    current = scope;
    render();
    onChange?.(scope);
  }

  group.addEventListener('keydown', (e) => {
    const i = STATS_SCOPES.indexOf(current);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = STATS_SCOPES[(i + 1) % STATS_SCOPES.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = STATS_SCOPES[(i - 1 + STATS_SCOPES.length) % STATS_SCOPES.length];
    else if (e.key === 'Home') next = STATS_SCOPES[0];
    else if (e.key === 'End') next = STATS_SCOPES[STATS_SCOPES.length - 1];
    if (next) {
      e.preventDefault();
      choose(next, { focus: true });
    }
  });

  render();

  return {
    element: group,
    getValue: () => current,
    /** Show `scope` as selected without calling onChange (a reply, another view's change). */
    setValue(scope) {
      if (!isStatsScope(scope) || scope === current) return;
      current = scope;
      render();
    },
  };
}
