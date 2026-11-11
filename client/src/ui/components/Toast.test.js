import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast, showError, showSuccess, showWarning, showInfo } from './Toast.js';
import { clearToasts } from '../kit/toast.js';

// Toast.js is the page's one toast queue (ui/kit/toast.js); kit.test.js
// covers the queue order, these the public helpers

describe('showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('creates toast element', () => {
    showToast('Test message');

    const toast = document.querySelector('.toast');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toBe('Test message');
  });

  it('applies type class', () => {
    showToast('Error message', { type: 'error' });

    expect(document.querySelector('.toast-error')).toBeTruthy();
  });

  it('removes toast after duration', () => {
    showToast('Test message', { duration: 1000 });

    expect(document.querySelector('.toast')).toBeTruthy();

    vi.advanceTimersByTime(1500);

    expect(document.querySelector('.toast')).toBeFalsy();
  });

  it('replaces the toast of the same type on screen', () => {
    showToast('First error', { type: 'error' });
    showToast('Second error', { type: 'error' });

    const toasts = document.querySelectorAll('.toast-error');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toBe('Second error');
  });

  it('never stacks two toasts: another type waits its turn', () => {
    showToast('Saved', { type: 'success', duration: 1000 });
    showToast('Oops', { type: 'error', duration: 1000 });
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
    vi.advanceTimersByTime(1200);
    expect([...document.querySelectorAll('.toast')].map((t) => t.textContent)).toEqual(['Oops']);
  });

  it('returns toast element', () => {
    const toast = showToast('Test');

    expect(toast).toBeInstanceOf(HTMLElement);
    expect(toast.textContent).toBe('Test');
  });
});

describe('showError', () => {
  afterEach(() => clearToasts());

  it('creates error toast', () => {
    showError('Error!');

    expect(document.querySelector('.toast-error')).toBeTruthy();
    expect(document.querySelector('.toast').textContent).toBe('Error!');
  });
});

describe('showSuccess', () => {
  afterEach(() => clearToasts());

  it('creates success toast', () => {
    showSuccess('Success!');

    expect(document.querySelector('.toast-success')).toBeTruthy();
  });
});

describe('showWarning', () => {
  afterEach(() => clearToasts());

  it('creates warning toast', () => {
    showWarning('Warning!');

    expect(document.querySelector('.toast-warning')).toBeTruthy();
  });
});

describe('showInfo', () => {
  afterEach(() => clearToasts());

  it('creates info toast', () => {
    showInfo('Info!');

    expect(document.querySelector('.toast-info')).toBeTruthy();
  });
});
