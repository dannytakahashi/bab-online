/**
 * The stats scope control: a WAI-ARIA radio group (one tab stop, arrows
 * move and select with wrap, Home / End), click selects, onChange only on
 * a change, setValue without onChange.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStatsScopeControl } from './StatsScopeControl.js';

const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
const radios = (c) => [...c.element.querySelectorAll('[role="radio"]')];
const checked = (c) => radios(c).filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.dataset.scope);
const tabStops = (c) => radios(c).filter((r) => r.tabIndex === 0).map((r) => r.dataset.scope);

afterEach(() => document.body.replaceChildren());

function mount(opts) {
  const c = createStatsScopeControl(opts);
  document.body.appendChild(c.element);
  return c;
}

describe('StatsScopeControl', () => {
  it('a labelled radio group of three options, the given value checked and the only tab stop', () => {
    const c = mount({ value: 'bots' });
    expect(c.element.getAttribute('role')).toBe('radiogroup');
    expect(c.element.getAttribute('aria-label')).toBe('Which games');
    expect(radios(c).map((r) => r.textContent)).toEqual(['Human games', 'Bot games', 'All games']);
    expect(radios(c).every((r) => r.tagName === 'BUTTON' && r.type === 'button')).toBe(true);
    expect(checked(c)).toEqual(['bots']);
    expect(tabStops(c)).toEqual(['bots']);
    expect(c.getValue()).toBe('bots');
  });

  it('defaults to Human games (also for an unknown value)', () => {
    expect(checked(mount())).toEqual(['human']);
    expect(checked(mount({ value: 'weird' }))).toEqual(['human']);
  });

  it('a click selects and calls onChange once; clicking the checked option does nothing', () => {
    const onChange = vi.fn();
    const c = mount({ onChange });
    radios(c)[2].click();
    expect(onChange.mock.calls).toEqual([['all']]);
    expect(checked(c)).toEqual(['all']);
    expect(tabStops(c)).toEqual(['all']);
    radios(c)[2].click();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move focus and select, wrapping; Home / End; focus stays in the control', () => {
    const onChange = vi.fn();
    const c = mount({ onChange });
    radios(c)[0].focus();
    radios(c)[0].dispatchEvent(key('ArrowRight'));
    expect(checked(c)).toEqual(['bots']);
    expect(document.activeElement).toBe(radios(c)[1]);
    document.activeElement.dispatchEvent(key('ArrowDown'));
    expect(checked(c)).toEqual(['all']);
    document.activeElement.dispatchEvent(key('ArrowRight'));
    expect(checked(c)).toEqual(['human']);
    expect(document.activeElement).toBe(radios(c)[0]);
    document.activeElement.dispatchEvent(key('ArrowLeft'));
    expect(checked(c)).toEqual(['all']);
    document.activeElement.dispatchEvent(key('ArrowUp'));
    expect(checked(c)).toEqual(['bots']);
    document.activeElement.dispatchEvent(key('Home'));
    expect(checked(c)).toEqual(['human']);
    document.activeElement.dispatchEvent(key('End'));
    expect(checked(c)).toEqual(['all']);
    expect(document.activeElement).toBe(radios(c)[2]);
    expect(onChange.mock.calls.map(([s]) => s)).toEqual(['bots', 'all', 'human', 'all', 'bots', 'human', 'all']);
  });

  it('other keys are left alone (Tab leaves the group, letters do nothing)', () => {
    const onChange = vi.fn();
    const c = mount({ onChange });
    const tab = key('Tab');
    radios(c)[0].dispatchEvent(tab);
    radios(c)[0].dispatchEvent(key('a'));
    expect(tab.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setValue shows a scope without calling onChange', () => {
    const onChange = vi.fn();
    const c = mount({ onChange });
    c.setValue('all');
    expect(checked(c)).toEqual(['all']);
    c.setValue('bogus');
    expect(checked(c)).toEqual(['all']);
    expect(onChange).not.toHaveBeenCalled();
  });
});
