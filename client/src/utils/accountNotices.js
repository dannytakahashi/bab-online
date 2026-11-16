/**
 * Account notices the server sends with a sign-in or restore.
 *
 * passwordReset {by: 'link' | 'admin', at: ISO time} (additive 2026-11-15,
 * server authHandlers.resetNoticeFor): the password was reset since the
 * player last signed in, by a one-time reset link or by an admin
 * (scripts/set-password.js). Told once; the page shows it as one info line.
 */

/** "Nov 14" in the viewer's locale; null for a date that does not parse. */
function shortDate(at, { locale, timeZone } = {}) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return null;
  try {
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return d.toDateString();
  }
}

/**
 * @param {{by?: string, at?: string}|undefined} notice
 * @param {{locale?: string, timeZone?: string}} [options] - tests pin these
 * @returns {string|null} the line to show, or null when there is nothing to tell
 */
export function passwordResetNoticeText(notice, options = {}) {
  if (!notice || (notice.by !== 'link' && notice.by !== 'admin')) return null;
  const day = shortDate(notice.at, options);
  const when = day ? ` on ${day}` : '';
  return notice.by === 'link'
    ? `Your password was reset with a reset link${when}. If that wasn't you, tell an admin.`
    : `An admin set a new password for your account${when}. If you didn't ask for that, tell an admin.`;
}
