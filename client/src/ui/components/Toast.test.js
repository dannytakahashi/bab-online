import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast, showError, showSuccess, showWarning, showInfo } from './Toast.js';

describe('showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up any toasts
    document.querySelectorAll('.toast').forEach((el) => el.remove());
    document.getElementById('toast-styles')?.remove();
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

  it('removes existing toast of same type', () => {
    showToast('First error', { type: 'error' });
    showToast('Second error', { type: 'error' });

    const toasts = document.querySelectorAll('.toast-error');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toBe('Second error');
  });

  it('adds animation styles', () => {
    showToast('Test');

    expect(document.getElementById('toast-styles')).toBeTruthy();
  });

  it('returns toast element', () => {
    const toast = showToast('Test');

    expect(toast).toBeInstanceOf(HTMLElement);
    expect(toast.textContent).toBe('Test');
  });
});

describe('showError', () => {
  afterEach(() => {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
  });

  it('creates error toast', () => {
    showError('Error!');

    expect(document.querySelector('.toast-error')).toBeTruthy();
    expect(document.querySelector('.toast').textContent).toBe('Error!');
  });
});

describe('showSuccess', () => {
  afterEach(() => {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
  });

  it('creates success toast', () => {
    showSuccess('Success!');

    expect(document.querySelector('.toast-success')).toBeTruthy();
  });
});

describe('showWarning', () => {
  afterEach(() => {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
  });

  it('creates warning toast', () => {
    showWarning('Warning!');

    expect(document.querySelector('.toast-warning')).toBeTruthy();
  });
});

describe('showInfo', () => {
  afterEach(() => {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
  });

  it('creates info toast', () => {
    showInfo('Info!');

    expect(document.querySelector('.toast-info')).toBeTruthy();
  });
});
