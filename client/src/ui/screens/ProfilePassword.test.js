/**
 * The profile's Change password form (ProfilePage createPasswordChange,
 * c2s changePassword -> changePasswordResponse): labelled fields behind an
 * aria-expanded toggle, the server's 8-100 rule checked first, one polite
 * status line, the busy state, and the reply shown in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showProfilePage, removeProfilePage, showChangePasswordResult, PASSWORD_CHANGE_COPY as C } from './ProfilePage.js';
import { passwordResetNoticeText } from '../../utils/accountNotices.js';

function fakeSocket() {
  const sent = [];
  return { sent, emit: vi.fn((event, data) => sent.push([event, data])), emitted: (e) => sent.filter(([n]) => n === e).map(([, d]) => d) };
}

let socket;
const $ = (id) => document.getElementById(id);
const fill = (cur, next, again = next) => {
  $('changePasswordCurrent').value = cur;
  $('changePasswordNew').value = next;
  $('changePasswordAgain').value = again;
};
const submit = () => $('changePasswordForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.replaceChildren();
  socket = fakeSocket();
  showProfilePage({ username: 'me', profilePic: 3, stats: {} }, socket);
});

afterEach(() => {
  removeProfilePage();
  vi.useRealTimers();
});

describe('Change password form', () => {
  it('a collapsed toggle that controls a labelled form; opening it focuses the current password', () => {
    const toggle = $('changePasswordToggle');
    expect(toggle.textContent).toBe('Change Password');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('changePasswordForm');
    expect($('changePasswordForm').hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect($('changePasswordForm').hidden).toBe(false);
    expect(document.activeElement.id).toBe('changePasswordCurrent');
    for (const [id, label, auto] of [
      ['changePasswordCurrent', 'Current password', 'current-password'],
      ['changePasswordNew', 'New password (at least 8 characters)', 'new-password'],
      ['changePasswordAgain', 'New password again', 'new-password'],
    ]) {
      const input = $(id);
      expect(input.type).toBe('password');
      expect(input.getAttribute('autocomplete')).toBe(auto);
      expect(document.querySelector(`label[for="${id}"]`).textContent).toBe(label);
      expect(input.getAttribute('aria-describedby')).toBe('changePasswordStatus');
    }
    expect($('changePasswordStatus').getAttribute('role')).toBe('status');
    // it sits between Sign Out and the danger zone
    const order = [...document.querySelectorAll('#profilePageModal .profile-signout, #profilePageModal .password-change, #profilePageModal .danger-zone')].map((n) => n.className);
    expect(order).toEqual([expect.stringContaining('profile-signout'), 'password-change', 'danger-zone']);
  });

  it('checks the fields first: empty, 7 characters, mismatch, unchanged; nothing is sent', () => {
    $('changePasswordToggle').click();
    fill('', 'brand-new-pw');
    submit();
    expect($('changePasswordStatus').textContent).toBe(C.empty);
    expect($('changePasswordCurrent').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement.id).toBe('changePasswordCurrent');
    fill('old', '1234567');
    submit();
    expect($('changePasswordStatus').textContent).toBe(C.short);
    expect(document.activeElement.id).toBe('changePasswordNew');
    fill('old', 'brand-new-pw', 'brand-new-px');
    submit();
    expect($('changePasswordStatus').textContent).toBe(C.mismatch);
    expect(document.activeElement.id).toBe('changePasswordAgain');
    fill('same-password', 'same-password');
    submit();
    expect($('changePasswordStatus').textContent).toBe(C.same);
    expect($('changePasswordStatus').classList.contains('is-error')).toBe(true);
    expect(socket.emitted('changePassword')).toEqual([]);
  });

  it('sends {current, next} once (trimmed like Sign In), busy until the reply; a success clears the fields', () => {
    $('changePasswordToggle').click();
    fill(' old ', ' brand-new-pw ');
    submit();
    submit(); // a second press while busy sends nothing
    expect(socket.emitted('changePassword')).toEqual([{ current: 'old', next: 'brand-new-pw' }]);
    expect($('changePasswordSubmit').disabled).toBe(true);
    expect($('changePasswordSubmit').textContent).toBe('Changing…');
    expect(showChangePasswordResult({ success: true, message: 'Password changed. Your other devices were signed out.' })).toBe(true);
    expect($('changePasswordSubmit').disabled).toBe(false);
    expect($('changePasswordStatus').textContent).toBe('Password changed. Your other devices were signed out.');
    expect($('changePasswordStatus').classList.contains('is-success')).toBe(true);
    expect(['changePasswordCurrent', 'changePasswordNew', 'changePasswordAgain'].map((id) => $(id).value)).toEqual(['', '', '']);
  });

  it('a refusal stays in the form: a wrong current password focuses it, the rule focuses the new one', () => {
    $('changePasswordToggle').click();
    fill('wrong', 'brand-new-pw');
    submit();
    showChangePasswordResult({ success: false, message: 'Your current password is incorrect.' });
    expect($('changePasswordStatus').textContent).toBe('Your current password is incorrect.');
    expect(document.activeElement.id).toBe('changePasswordCurrent');
    expect($('changePasswordNew').value).toBe('brand-new-pw');
    submit();
    showChangePasswordResult({ success: false, message: 'Password must be 8-100 characters.' });
    expect(document.activeElement.id).toBe('changePasswordNew');
  });

  it('no reply in 10 s: the form is usable again and says so; a reply with the profile closed is ignored', () => {
    vi.useFakeTimers();
    $('changePasswordToggle').click();
    fill('old', 'brand-new-pw');
    submit();
    vi.advanceTimersByTime(10000);
    expect($('changePasswordSubmit').disabled).toBe(false);
    expect($('changePasswordStatus').textContent).toBe(C.noAnswer);
    removeProfilePage();
    expect(showChangePasswordResult({ success: true, message: 'x' })).toBe(false);
  });
});

describe('passwordResetNoticeText', () => {
  const opts = { locale: 'en-US', timeZone: 'UTC' };
  it('says who reset it and when', () => {
    expect(passwordResetNoticeText({ by: 'link', at: '2026-11-14T09:30:00.000Z' }, opts))
      .toBe("Your password was reset with a reset link on Nov 14. If that wasn't you, tell an admin.");
    expect(passwordResetNoticeText({ by: 'admin', at: '2026-11-14T09:30:00.000Z' }, opts))
      .toBe("An admin set a new password for your account on Nov 14. If you didn't ask for that, tell an admin.");
  });
  it('a bad date drops "on ..."; anything else is nothing to tell', () => {
    expect(passwordResetNoticeText({ by: 'link', at: 'nope' }, opts)).toBe("Your password was reset with a reset link. If that wasn't you, tell an admin.");
    expect(passwordResetNoticeText({ by: 'link', at: new Date(0).toISOString() }, opts)).toMatch(/reset link\. If/);
    expect(passwordResetNoticeText(undefined)).toBeNull();
    expect(passwordResetNoticeText({ by: 'someone' })).toBeNull();
  });
});
