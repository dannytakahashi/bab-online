/**
 * The table's DOM HUD (roadmap item 17): one absolutely positioned layer
 * the size of the canvas (#table-hud inside #game-container) that holds
 * every DOM piece of the table, placed from the table layout
 * (phaser/layout/computeTableLayout.js) through CSS variables:
 *
 *   .hud-seat[data-seat]   one per seat (self, partner, opp1, opp2), at the
 *                          avatar's centre; its avatar, dealer frog and chat
 *                          or bid bubble are its children, so they follow it
 *   #spectating-indicator  the status slot (lazy / spectator pill)
 *   #bidContainer          the bid sheet slot
 *   .hud-voice             the voice buttons
 *   .hud-spectators        who is watching: eye + count, its list popover
 *                          (ui/components/SpectatorBadge.js)
 *
 * applyHudLayout(layout) is the only writer of positions: a relayout
 * moves everything at once. Seats outlive a render (it redraws only the
 * avatar inside), so a bubble survives a rebuild; clearHud() is the
 * table's teardown.
 *
 * Without #game-container (page tests with a fake scene) the pieces go to
 * <body> and keep their CSS fallbacks.
 */

/** OpponentManager's 'bottom' slot (a spectator's view) is the self seat. */
export const SEAT_KEYS = ['self', 'partner', 'opp1', 'opp2'];
export const seatKeyOf = (slot) => (slot === 'bottom' || slot === 'me' ? 'self' : slot);

let lastLayout = null;

/** The HUD root (created on demand), or null when there is no table container. */
export function getHud({ create = true } = {}) {
  let hud = document.getElementById('table-hud');
  if (hud && hud.isConnected) return hud;
  const container = document.getElementById('game-container');
  if (!container || !create) return null;
  hud = document.createElement('div');
  hud.id = 'table-hud';
  container.appendChild(hud);
  if (lastLayout) applyRootVars(hud, lastLayout);
  return hud;
}

/** Where table DOM goes: the HUD, else <body>. */
export function hudRoot() {
  return getHud() || document.body;
}

/**
 * A seat node with its avatar, dealer and bubble slots (created on demand).
 * @param {string} slot - self | partner | opp1 | opp2 (bottom / me: self)
 * @returns {{seat: HTMLElement, avatar: HTMLElement, dealer: HTMLElement, bubble: HTMLElement}|null}
 */
export function hudSeat(slot, { create = true } = {}) {
  const key = seatKeyOf(slot);
  if (!SEAT_KEYS.includes(key)) return null;
  const hud = getHud({ create });
  if (!hud) return null;
  let seat = hud.querySelector(`:scope > .hud-seat[data-seat="${key}"]`);
  if (!seat) {
    if (!create) return null;
    seat = document.createElement('div');
    seat.className = `hud-seat hud-seat-${key}`;
    seat.dataset.seat = key;
    for (const part of ['avatar', 'dealer', 'bubble']) {
      const el = document.createElement('div');
      el.className = `hud-${part}-slot`;
      seat.appendChild(el);
    }
    hud.appendChild(seat);
    if (lastLayout) applySeatVars(seat, lastLayout);
  }
  return {
    seat,
    avatar: seat.querySelector(':scope > .hud-avatar-slot'),
    dealer: seat.querySelector(':scope > .hud-dealer-slot'),
    bubble: seat.querySelector(':scope > .hud-bubble-slot'),
  };
}

/** The voice buttons' slot (null without a table). */
export function hudVoiceSlot({ create = true } = {}) {
  const hud = getHud({ create });
  if (!hud) return null;
  let slot = hud.querySelector(':scope > .hud-voice');
  if (!slot && create) {
    slot = document.createElement('div');
    slot.className = 'hud-voice';
    hud.appendChild(slot);
  }
  return slot;
}

/** The spectator badge's slot (null without a table; ui/components/SpectatorBadge.js). */
export function hudSpectatorSlot({ create = true } = {}) {
  const hud = getHud({ create });
  if (!hud) return null;
  let slot = hud.querySelector(':scope > .hud-spectators');
  if (!slot && create) {
    slot = document.createElement('div');
    slot.className = 'hud-spectators';
    hud.appendChild(slot);
  }
  return slot;
}

const px = (v) => `${Math.round(v * 100) / 100}px`;

function applyRootVars(hud, L) {
  const st = hud.style;
  const set = (k, v) => st.setProperty(k, typeof v === 'number' ? px(v) : v);
  set('--s', String(L.s));
  set('--canvas-w', L.w);
  set('--canvas-h', L.h);
  // avatars and plates
  const av = L.seats.partner.avatar;
  set('--av-img', av.img);
  set('--av-border', av.border);
  set('--av', av.size);
  set('--plate-w', L.plate.w);
  set('--plate-h', L.plate.h);
  set('--plate-gap', L.plate.gap);
  set('--plate-font', L.plate.font);
  set('--plate-lh', L.plate.lh);
  set('--plate-pad', Math.max(2, 8 * L.s));
  set('--frog', L.seats.partner.dealer.size);
  // bubbles: the layout's box (each seat's width is on its node)
  const B = L.bubbles;
  if (B) {
    set('--bubble-font', B.font);
    set('--bubble-lh', B.lh);
    set('--bubble-pad-x', B.padX);
    set('--bubble-pad-y', B.padY);
    set('--bubble-lines', String(B.lines));
    set('--bubble-w', B.w);
  }
  // my box
  if (L.seats.self.hsi) {
    set('--hsi-w', L.seats.self.hsi.rect.w);
    set('--hsi-h', L.seats.self.hsi.rect.h);
    set('--hsi-font', L.seats.self.hsi.font);
    set('--hsi-gap', L.seats.self.hsi.rect.y - (L.seats.self.plate.y + L.plate.h));
  }
  // status, bid sheet, voice
  const sr = L.status.rect;
  set('--status-x', sr.x + sr.w / 2);
  set('--status-y', sr.y);
  set('--status-w', sr.w);
  set('--status-h', sr.h);
  set('--status-font', L.status.font);
  set('--bid-x', L.bidSheet.x);
  set('--bid-y', L.bidSheet.y);
  set('--bid-scale', String(L.bidSheet.scale));
  const vr = L.voice.rect;
  set('--voice-x', vr.x);
  set('--voice-y', vr.y);
  set('--voice-w', vr.w);
  set('--voice-btn', L.voice.button);
  set('--voice-gap', L.voice.gap);
  // the spectator badge (who is watching)
  const sp = L.spectators;
  if (sp) {
    set('--spec-x', sp.rect.x);
    set('--spec-y', sp.rect.y);
    set('--spec-w', sp.rect.w);
    set('--spec-h', sp.rect.h);
    set('--spec-font', sp.font);
    set('--spec-icon', sp.icon);
  }
}

function applySeatVars(seat, L) {
  const s = L.seats[seat.dataset.seat];
  if (!s) return;
  const st = seat.style;
  st.left = px(s.avatar.x);
  st.top = px(s.avatar.y);
  st.setProperty('--dealer-dx', px(s.dealer.dx));
  st.setProperty('--dealer-dy', px(s.dealer.dy));
  st.setProperty('--bubble-dx', px(s.bubble.dx));
  st.setProperty('--bubble-dy', px(s.bubble.dy));
  if (s.bubble.w) st.setProperty('--bubble-w', px(s.bubble.w));
  seat.dataset.tail = s.bubble.tail;
  // a bubble up now turns with its seat
  seat.querySelectorAll(':scope > .hud-bubble-slot > .chat-bubble').forEach((b) => {
    b.classList.remove('tail-down', 'tail-left', 'tail-right');
    b.classList.add(`tail-${s.bubble.tail}`);
  });
}

/** Place the whole HUD from a layout (every relayout). */
export function applyHudLayout(L) {
  if (!L) return;
  lastLayout = L;
  const hud = getHud({ create: false }) || getHud();
  if (!hud) return;
  applyRootVars(hud, L);
  hud.classList.toggle('hud-spectator', !!L.isSpectator);
  hud.querySelectorAll(':scope > .hud-seat').forEach((seat) => applySeatVars(seat, L));
}

/** The layout last applied (null before the first relayout). */
export function hudLayout() {
  return lastLayout;
}

/** Remove every piece of the HUD (the table's teardown). */
export function clearHud() {
  lastLayout = null;
  const hud = document.getElementById('table-hud');
  if (hud) hud.replaceChildren();
}

/**
 * The table chrome: the shell's log column (--log-w grid) on or off. The
 * game log moves into the shell's second column.
 */
export function setTableChrome(on) {
  const shell = document.getElementById('table-shell');
  const container = document.getElementById('game-container');
  container?.classList.toggle('in-game', !!on);
  shell?.classList.toggle('in-game', !!on);
  const log = document.getElementById('gameFeed');
  if (on && shell && log && log.parentElement !== shell) shell.appendChild(log);
}

/** The log column's width in px while the table chrome is on (0 when off). */
export function logColumnWidth({ fallback } = {}) {
  const container = document.getElementById('game-container');
  if (!container?.classList.contains('in-game')) return 0;
  const shell = document.getElementById('table-shell');
  const log = document.getElementById('gameFeed');
  if (shell && log && log.parentElement === shell && log.isConnected) {
    const cols = getComputedStyle(shell).gridTemplateColumns || '';
    const parts = cols.split(' ').map(parseFloat).filter((n) => Number.isFinite(n));
    if (parts.length === 2 && parts[1] > 0) return parts[1];
  }
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--log-w'));
  if (Number.isFinite(v) && v > 0) return v;
  return typeof fallback === 'function' ? fallback() : (fallback || 0);
}
