import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createModal, confirm, alert } from './Modal.js';

describe('createModal', () => {
  afterEach(() => {
    // Clean up any modals
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  });

  it('creates modal with backdrop and content', () => {
    const { container, content } = createModal();

    expect(container).toBeDefined();
    expect(content).toBeDefined();
    expect(container.querySelector('.modal-content')).toBe(content);
  });

  it('applies custom id', () => {
    const { container } = createModal({ id: 'custom-modal' });
    expect(container.id).toBe('custom-modal');
  });

  it('applies custom className', () => {
    const { container } = createModal({ className: 'my-modal' });
    expect(container.classList.contains('my-modal')).toBe(true);
  });

  it('close function removes modal', () => {
    const { container, close } = createModal();
    document.body.appendChild(container);

    expect(document.querySelector('.modal-backdrop')).toBeTruthy();

    close();

    expect(document.querySelector('.modal-backdrop')).toBeFalsy();
  });

  it('calls onClose callback when closed', () => {
    const onClose = vi.fn();
    const { container, close } = createModal({ onClose });
    document.body.appendChild(container);

    close();

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on backdrop click when closeOnBackdrop is true', () => {
    const onClose = vi.fn();
    const { container, content } = createModal({ closeOnBackdrop: true, onClose });
    document.body.appendChild(container);

    // Click on backdrop (container), not content
    container.click();

    expect(onClose).toHaveBeenCalled();
  });

  it('does not close on backdrop click when closeOnBackdrop is false', () => {
    const onClose = vi.fn();
    const { container } = createModal({ closeOnBackdrop: false, onClose });
    document.body.appendChild(container);

    container.click();

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    const { container } = createModal({ onClose });
    document.body.appendChild(container);

    const escEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(escEvent);

    expect(onClose).toHaveBeenCalled();
  });
});

describe('confirm', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  });

  it('returns promise that resolves to true on confirm', async () => {
    const promise = confirm('Are you sure?');

    // Find and click confirm button
    const confirmBtn = document.getElementById('confirm-btn');
    expect(confirmBtn).toBeTruthy();
    confirmBtn.click();

    const result = await promise;
    expect(result).toBe(true);
  });

  it('returns promise that resolves to false on cancel', async () => {
    const promise = confirm('Are you sure?');

    const cancelBtn = document.getElementById('cancel-btn');
    cancelBtn.click();

    const result = await promise;
    expect(result).toBe(false);
  });

  it('uses custom button text', () => {
    confirm('Delete?', { confirmText: 'Delete', cancelText: 'Keep' });

    expect(document.getElementById('confirm-btn').textContent).toBe('Delete');
    expect(document.getElementById('cancel-btn').textContent).toBe('Keep');

    // Cleanup
    document.getElementById('cancel-btn').click();
  });
});

describe('alert', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  });

  it('returns promise that resolves when dismissed', async () => {
    const promise = alert('Notice!');

    const okBtn = document.getElementById('ok-btn');
    expect(okBtn).toBeTruthy();
    okBtn.click();

    await promise; // Should resolve
  });

  it('uses custom button text', () => {
    alert('Notice!', { buttonText: 'Got it' });

    expect(document.getElementById('ok-btn').textContent).toBe('Got it');

    // Cleanup
    document.getElementById('ok-btn').click();
  });
});
