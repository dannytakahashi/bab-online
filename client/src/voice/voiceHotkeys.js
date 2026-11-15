/**
 * Voice keys while voice is on: hold backquote (`) for the voice overlay,
 * release to close; M toggles mute. Tab is never touched (it was the
 * overlay key and swallowed keyboard focus for everyone with voice on).
 */

/** The overlay key: the physical Backquote key, or a layout that types ` elsewhere. */
export const isOverlayKey = (e) => e.code === 'Backquote' || e.key === '`';

/** Focus is somewhere keys are text (or a choice), so hotkeys stay out of it. */
export function isTypingTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true || node.closest?.('[contenteditable]:not([contenteditable="false"])') != null;
}

const hasModifier = (e) => e.ctrlKey || e.metaKey || e.altKey;

/**
 * @param {Object} o
 * @param {function(): boolean} o.isActive - voice is on
 * @param {Function} o.show - open the overlay
 * @param {Function} o.hide - close it (idempotent)
 * @param {Function} o.toggleMute
 * @param {Document} [o.doc=document]
 * @param {Window} [o.win=window]
 * @returns {Function} uninstall
 */
export function installVoiceHotkeys({ isActive, show, hide, toggleMute, doc = document, win = window }) {
  // The overlay is open from a key press we took (keyup / blur close it)
  let held = false;
  const release = () => {
    if (!held) return;
    held = false;
    hide();
  };

  const onKeyDown = (e) => {
    if (isOverlayKey(e)) {
      // auto-repeat while held: still ours (focus is in the overlay by now)
      if (held) { e.preventDefault(); return; }
      if (e.repeat || hasModifier(e) || !isActive() || isTypingTarget(doc.activeElement)) return;
      e.preventDefault();
      held = true;
      show();
      return;
    }
    if (e.key === 'm' && !hasModifier(e) && isActive() && !isTypingTarget(doc.activeElement)) {
      toggleMute();
    }
  };
  const onKeyUp = (e) => {
    if (isOverlayKey(e)) release();
  };

  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);
  // a held key lost to alt-tab never sends its keyup here
  win.addEventListener('blur', release);
  return () => {
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', release);
  };
}
