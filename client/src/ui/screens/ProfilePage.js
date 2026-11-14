/**
 * Profile Page Screen
 *
 * The player's own profile (stats, picture: upload or choose an avatar,
 * sign out, delete account) and another player's (stats, report, block),
 * each a kit Modal (item 18b: focus trap, Escape, focus restore); the
 * avatar picker, the report form and the block confirmation are kit
 * Modals stacked on top. Classes from styles/screens.css; user text
 * (usernames, report reasons) only as text.
 */

import { clearAllSessionData } from '../../utils/sessionPersistence.js';
import { avatarSrc, profileAvatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { el, createButton, createPanel, openModal } from '../kit/index.js';
import { showError } from '../components/Toast.js';
import { createStatsScopeControl } from '../components/StatsScopeControl.js';
import {
  getStatsScope, setStatsScope, isStatsScope, createScopeRequester, scopePayload, BOT_STATS_EMPTY_NOTE,
} from '../../state/statsScope.js';

/**
 * Module state - tracks current profile data and UI state.
 */
let currentProfile = null;
let currentSocket = null;
/** The open kit modals (profile, player profile, avatar picker, report / block dialogs). */
let profileModal = null;
let playerProfileModal = null;
let pictureModal = null;
let safetyModal = null;
/** The stats section of the open own / other profile (scope control + region). */
let ownStats = null;
let playerStats = null;

const DEFAULT_AVATAR = 'assets/default_avatar.png';
const AVATAR_COUNT = 82;
export const VALID_PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const REPORT_MAX = 500;

/**
 * Get the appropriate profile picture source.
 *
 * @param {Object} profile - Profile data
 * @returns {string} Image source (base64 or URL)
 */
function getProfilePicSrc(profile) {
  return profileAvatarSrc(profile, DEFAULT_AVATAR);
}

/**
 * Resize, crop to square, and apply circular mask to an image file.
 * Output matches default profile pic dimensions with padding for border effect.
 *
 * @param {File} file - Image file to process
 * @param {number} targetSize - Target width/height in pixels
 * @returns {Promise<string>} Base64 encoded circular image (PNG with transparency)
 */
function resizeImage(file, targetSize = 612) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const { width, height } = img;

        // Calculate center crop for square output
        const cropSize = Math.min(width, height);
        const cropX = (width - cropSize) / 2;
        const cropY = (height - cropSize) / 2;

        // Set canvas to target size (square)
        canvas.width = targetSize;
        canvas.height = targetSize;

        const ctx = canvas.getContext('2d');

        // Add padding to match default profile pics (which have transparent border area)
        const padding = targetSize * 0.16; // 16% padding on each side
        const innerSize = targetSize - (padding * 2);
        const centerX = targetSize / 2;
        const centerY = targetSize / 2;

        // Create circular clipping path with padding
        ctx.beginPath();
        ctx.arc(centerX, centerY, innerSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        // Draw the center-cropped square, scaled to inner size (with padding)
        ctx.drawImage(
          img,
          cropX, cropY, cropSize, cropSize, // Source: center square
          padding, padding, innerSize, innerSize, // Dest: centered with padding
        );

        // Convert to base64 PNG (for transparency)
        const base64 = canvas.toDataURL('image/png');
        resolve(base64);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Handle file upload for custom profile picture.
 *
 * @param {Event} event - File input change event
 * @param {Object} socket - Socket instance
 */
export async function handleFileUpload(event, socket) {
  const file = event.target.files?.[0];
  if (!file) return;

  // Validate file type
  if (!VALID_PICTURE_TYPES.includes(file.type)) {
    showError('Invalid file type. Please use PNG, JPEG, GIF, or WebP.');
    event.target.value = '';
    return;
  }

  try {
    // Resize and compress image
    const resizedImage = await resizeImage(file, 200);

    // Send to server
    socket.emit('uploadProfilePic', { imageData: resizedImage });
  } catch (error) {
    console.error('Error processing image:', error);
    showError('Failed to process image. Please try again.');
  } finally {
    // the same file can be picked again
    event.target.value = '';
  }
}

/**
 * Create a stat item element.
 *
 * @param {string} label - Stat label
 * @param {string} value - Stat value
 * @returns {HTMLElement} Stat item div
 */
function createStatItem(label, value) {
  return el('div', {
    className: 'stat',
    children: [el('div', { className: 'stat__value', text: value }), el('div', { className: 'stat__label', text: label })],
  });
}

/** The 3 x 4 statistics grid (both profiles). */
function createStatsGrid(stats = {}) {
  const gamesPlayed = stats.gamesPlayed || 0;
  const per = (total, digits = 1) => (gamesPlayed > 0 ? ((total || 0) / gamesPlayed).toFixed(digits) : '0');

  const winPct = gamesPlayed > 0 ? ((stats.wins / gamesPlayed) * 100).toFixed(1) + '%' : '0%';
  const tricksPerBid = stats.totalTricksBid > 0 ? (stats.totalTricksTaken / stats.totalTricksBid).toFixed(2) : '0';
  const setRate = stats.totalHands > 0 ? ((stats.totalSets / stats.totalHands) * 100).toFixed(1) + '%' : '0%';
  const avgHSI = (stats.totalHands || 0) > 0 ? ((stats.totalHSI || 0) / stats.totalHands).toFixed(1) : '0';

  const grid = el('div', { className: 'stats-grid' });
  [
    // Row 1: Games, Wins, Losses
    ['Games Played', String(gamesPlayed)],
    ['Wins', String(stats.wins || 0)],
    ['Losses', String(stats.losses || 0)],
    // Row 2: Win %, Points/Game, Tricks Bid/Game
    ['Win Rate', winPct],
    ['Points/Game', per(stats.totalPoints)],
    ['Bids/Game', per(stats.totalTricksBid)],
    // Row 3: Tricks/Game, Tricks per Bid, Set Rate
    ['Tricks/Game', per(stats.totalTricksTaken)],
    ['Tricks/Bid', tricksPerBid],
    ['Set Rate', setRate],
    // Row 4: Drag, Faults/Game, HSI
    ['Drag', per(stats.totalSetPoints)],
    ['Faults/Game', per(stats.totalFaults, 2)],
    ['HSI', avgHSI],
  ].forEach(([label, value]) => grid.appendChild(createStatItem(label, value)));

  return grid;
}

/**
 * The statistics heading, the stats scope control (Human games | Bot games
 * | All games, state/statsScope.js) and the grid. Switching asks the server
 * again (`request(scope)`); the reply replaces only the grid (update), so
 * the picture, the buttons and focus on the control stay as they are.
 *
 * @param {Object} stats
 * @param {string} scope - the scope `stats` is for
 * @param {(scope: string) => void} request - sends the request for a new scope
 * @param {string} regionId
 */
function createStatsSection(stats, scope, request, regionId) {
  let current = isStatsScope(scope) ? scope : 'human';
  const region = el('div', { className: 'scope-region', attrs: { id: regionId } });
  const fill = (st) => {
    const nodes = [];
    if (current === 'bots' && !(st?.gamesPlayed > 0)) nodes.push(el('p', { className: 'scope-note', text: BOT_STATS_EMPTY_NOTE }));
    nodes.push(createStatsGrid(st || {}));
    region.replaceChildren(...nodes);
  };
  fill(stats);
  const send = createScopeRequester(request);
  const control = createStatsScopeControl({
    value: current,
    label: 'Which games the statistics count',
    onChange: (next) => {
      setStatsScope(next);
      current = next;
      region.setAttribute('aria-busy', 'true');
      send.request(next);
    },
  });
  control.element.setAttribute('aria-controls', regionId);
  return {
    nodes: [el('h3', { className: 'section-title', text: 'Statistics' }), control.element, region],
    update(st, sc) {
      if (isStatsScope(sc)) {
        current = sc;
        control.setValue(sc);
      }
      fill(st);
      region.removeAttribute('aria-busy');
    },
    idle() {
      region.removeAttribute('aria-busy');
    },
    cancel() {
      send.cancel();
    },
  };
}

/** The round picture (img id for the own profile, which updates in place). */
function createAvatar(profile, imgId = null) {
  const img = el('img', { attrs: { id: imgId, alt: `${profile.username}'s profile picture` } });
  applyAvatarImg(img, getProfilePicSrc(profile), { fallback: DEFAULT_AVATAR });
  return el('div', { className: 'profile-avatar', attrs: { id: imgId ? 'profilePicContainer' : null }, children: [img] });
}

/**
 * The avatar picker: a kit Modal over the profile (Escape closes it, not
 * the profile; focus starts on the current picture).
 *
 * @param {Object} socket - Socket instance
 * @param {number} currentPic - Currently selected picture number
 */
function openPictureSelector(socket, currentPic) {
  if (pictureModal?.isOpen()) return pictureModal;

  const grid = el('div', { className: 'avatar-grid', attrs: { role: 'group', 'aria-label': 'Avatars' } });
  let current = null;
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const isCurrent = i === currentPic;
    const picBtn = el('button', {
      className: `avatar-option${isCurrent ? ' is-current' : ''}`,
      attrs: { type: 'button', 'aria-label': `Avatar ${i}`, 'aria-pressed': String(isCurrent) },
    });
    const img = el('img', { attrs: { alt: '' } });
    applyAvatarImg(img, avatarSrc(i), { lazy: true });
    picBtn.appendChild(img);
    picBtn.addEventListener('click', () => {
      socket.emit('updateProfilePic', { profilePic: i });
      removePictureSelector();
    });
    if (isCurrent) current = picBtn;
    grid.appendChild(picBtn);
  }

  pictureModal = openModal({
    title: 'Select Profile Picture',
    closable: true,
    closeLabel: 'Close avatar picker',
    id: 'profilePicSelector',
    className: 'page-modal page-modal--picker',
    body: grid,
    initialFocus: current,
    onClose: () => {
      pictureModal = null;
    },
  });
  return pictureModal;
}

/**
 * Remove the picture selector.
 */
function removePictureSelector() {
  pictureModal?.close('api');
  pictureModal = null;
  document.getElementById('profilePicSelector')?.remove();
}

/**
 * Show the profile page.
 *
 * @param {Object} profile - Profile data (username, profilePic, stats)
 * @param {Object} socket - Socket instance
 * @param {string} [scope] - the stats scope `profile.stats` is for (default: the device's choice)
 */
export function showProfilePage(profile, socket, scope = getStatsScope()) {
  console.log('Showing profile page...', profile);

  // Remove any existing profile page
  removeProfilePage();

  currentProfile = profile;
  currentSocket = socket;

  // Profile picture section
  const picInfo = el('div', { className: 'profile-hero__info' });
  picInfo.appendChild(el('div', { className: 'section-label', text: 'Profile Picture' }));

  // Hidden file input (the button opens it)
  const fileInput = el('input', {
    attrs: { type: 'file', accept: VALID_PICTURE_TYPES.join(','), hidden: true, 'aria-label': 'Upload a profile picture', id: 'profilePicFileInput' },
  });
  fileInput.addEventListener('change', (e) => handleFileUpload(e, socket));

  picInfo.appendChild(el('div', {
    className: 'btn-row',
    children: [
      createButton({ label: 'Upload Picture', variant: 'primary', size: 'sm', onClick: () => fileInput.click() }),
      fileInput,
      createButton({
        label: 'Choose Avatar',
        variant: 'secondary',
        size: 'sm',
        onClick: () => openPictureSelector(socket, currentProfile?.profilePic ?? profile.profilePic),
      }),
    ],
  }));

  const hero = createPanel({ elevation: 1, className: 'profile-hero screen-section', children: [createAvatar(profile, 'profilePicImage'), picInfo] });
  const section = createStatsSection(profile.stats, scope, (next) => socket?.emit('getProfile', { scope: next }), 'profileStatsRegion');
  ownStats = section;

  profileModal = openModal({
    title: profile.username,
    closable: true,
    closeLabel: 'Close profile',
    id: 'profilePageOverlay',
    dialogId: 'profilePageModal',
    className: 'page-modal',
    body: [hero, ...section.nodes, createSignOutButton(), createDangerZone(socket)],
    onClose: () => {
      profileModal = null;
      removePictureSelector();
      currentProfile = null;
      section.cancel();
      if (ownStats === section) ownStats = null;
    },
  });
}

/**
 * New stats for the open own profile (a scope switch's reply): only the
 * grid changes.
 *
 * @returns {boolean} false when the own profile is not open (or is another account's)
 */
export function updateProfileStats(profile, scope) {
  if (!profileModal || !ownStats || !profile || profile.username !== currentProfile?.username) return false;
  ownStats.update(profile.stats, scope);
  return true;
}

/**
 * Sign Out: the web client stays signed in across visits, so shared family
 * computers need an explicit way to switch players.
 *
 * @returns {HTMLElement}
 */
export function createSignOutButton() {
  const btn = createButton({
    label: 'Sign Out',
    variant: 'secondary',
    className: 'profile-signout',
    onClick: () => {
      clearAllSessionData();
      // Reloading drops the socket; the server's disconnect flow cleans up
      window.location.reload();
    },
  });
  btn.id = 'profileSignOutButton';
  return btn;
}

/**
 * Create the account-deletion section: a Delete Account button that expands
 * into a password-confirm form.
 *
 * @param {Object} socket - Socket instance
 * @returns {HTMLElement}
 */
function createDangerZone(socket) {
  const section = el('section', { className: 'danger-zone', attrs: { 'aria-label': 'Delete account' } });

  const confirmArea = el('div', { className: 'danger-zone__confirm', attrs: { id: 'deleteAccountConfirm', hidden: true } });
  const deleteBtn = createButton({
    label: 'Delete Account',
    variant: 'danger',
    size: 'sm',
    attrs: { 'aria-expanded': 'false', 'aria-controls': 'deleteAccountConfirm' },
  });
  section.appendChild(deleteBtn);

  confirmArea.appendChild(el('p', {
    className: 'danger-zone__warning',
    attrs: { id: 'deleteAccountWarning' },
    text: 'This permanently deletes your account, statistics, and profile. This cannot be undone. Enter your password to confirm.',
  }));

  const passwordInput = el('input', {
    className: 'kit-input',
    attrs: {
      type: 'password', placeholder: 'Password', autocomplete: 'current-password',
      'aria-label': 'Password', 'aria-describedby': 'deleteAccountWarning',
    },
  });
  passwordInput.addEventListener('input', () => passwordInput.classList.remove('is-invalid'));

  const confirmBtn = createButton({
    label: 'Permanently Delete',
    variant: 'danger',
    onClick: () => {
      const password = passwordInput.value;
      if (!password) {
        passwordInput.classList.add('is-invalid');
        passwordInput.setAttribute('aria-invalid', 'true');
        passwordInput.focus();
        return;
      }
      passwordInput.removeAttribute('aria-invalid');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting…';
      socket.emit('deleteAccount', { password });
    },
  });
  confirmArea.appendChild(el('div', { className: 'danger-zone__form', children: [passwordInput, confirmBtn] }));
  confirmArea.appendChild(el('div', { className: 'danger-zone__error', attrs: { id: 'deleteAccountError', role: 'alert' } }));

  section.appendChild(confirmArea);

  deleteBtn.addEventListener('click', () => {
    confirmArea.hidden = !confirmArea.hidden;
    deleteBtn.setAttribute('aria-expanded', String(!confirmArea.hidden));
    if (!confirmArea.hidden) passwordInput.focus();
  });

  return section;
}

/**
 * Re-enable the delete-account form after a failed attempt.
 *
 * @param {string} message - Error message to display
 */
export function showDeleteAccountError(message) {
  const errorMsg = document.getElementById('deleteAccountError');
  if (errorMsg) {
    errorMsg.textContent = message;
  }
  const buttons = document.querySelectorAll('#profilePageModal button');
  buttons.forEach((btn) => {
    if (btn.textContent === 'Deleting…') {
      btn.disabled = false;
      btn.textContent = 'Permanently Delete';
    }
  });
}

/**
 * Update the profile picture display after a successful update.
 *
 * @param {number} newPic - New profile picture number
 */
export function updateProfilePicDisplay(newPic) {
  if (currentProfile) {
    currentProfile.profilePic = newPic;
    currentProfile.customProfilePic = null; // Clear custom pic when choosing avatar
  }

  const picImg = document.getElementById('profilePicImage');
  if (picImg) {
    applyAvatarImg(picImg, avatarSrc(newPic, DEFAULT_AVATAR), { fallback: DEFAULT_AVATAR });
  }
}

/**
 * Update the profile picture display after a successful custom upload.
 *
 * @param {string} customPic - Base64 encoded custom profile picture
 */
export function updateCustomProfilePicDisplay(customPic) {
  if (currentProfile) {
    currentProfile.customProfilePic = customPic;
  }

  const picImg = document.getElementById('profilePicImage');
  if (picImg) {
    applyAvatarImg(picImg, avatarSrc(customPic, DEFAULT_AVATAR), { fallback: DEFAULT_AVATAR });
  }
}

/**
 * Remove the profile page.
 */
export function removeProfilePage() {
  removePictureSelector();
  profileModal?.close('api');
  profileModal = null;
  document.getElementById('profilePageOverlay')?.remove();
  currentProfile = null;
  ownStats?.cancel();
  ownStats = null;
}

/**
 * Check if profile page is currently visible.
 *
 * @returns {boolean} True if profile page is visible
 */
export function isProfilePageVisible() {
  return document.getElementById('profilePageOverlay') !== null;
}

function closeSafetyDialog() {
  safetyModal?.close('api');
  safetyModal = null;
}

/**
 * Report a player: a kit Modal with a labelled reason field (it replaced
 * window.prompt). Send is enabled once there is a reason.
 */
export function openReportDialog(username, socket) {
  closeSafetyDialog();
  const fieldId = 'reportReasonInput';
  const reason = el('textarea', {
    className: 'kit-input kit-textarea',
    attrs: { id: fieldId, maxlength: REPORT_MAX, rows: 4, placeholder: 'Describe what happened' },
  });
  const field = el('div', {
    className: 'field',
    children: [el('label', { className: 'field__label', attrs: { for: fieldId }, text: `What did ${username} do?` }), reason],
  });
  const cancel = createButton({ label: 'Cancel', variant: 'secondary', onClick: () => closeSafetyDialog() });
  const send = createButton({
    label: 'Send Report',
    variant: 'primary',
    attrs: { disabled: true },
    onClick: () => {
      const text = reason.value.trim();
      if (!text) return;
      socket.emit('reportUser', { username, reason: text.slice(0, REPORT_MAX), context: '' });
      closeSafetyDialog();
    },
  });
  reason.addEventListener('input', () => {
    send.disabled = !reason.value.trim();
  });
  safetyModal = openModal({
    title: `Report ${username}`,
    id: 'reportUserDialog',
    className: 'page-modal',
    body: field,
    actions: [cancel, send],
    initialFocus: reason,
    onClose: () => {
      safetyModal = null;
    },
  });
  return safetyModal;
}

/**
 * Block a player: a kit Modal confirmation (Escape / Cancel keep them).
 */
export function openBlockDialog(username, onConfirm) {
  closeSafetyDialog();
  const cancel = createButton({ label: 'Cancel', variant: 'secondary', onClick: () => closeSafetyDialog() });
  const block = createButton({
    label: 'Block',
    variant: 'danger',
    onClick: () => {
      closeSafetyDialog();
      onConfirm();
    },
  });
  safetyModal = openModal({
    title: `Block ${username}?`,
    id: 'blockUserDialog',
    className: 'page-modal',
    body: el('p', { className: 'dialog-copy', text: 'You will no longer see their chat messages. You can unblock them from their profile.' }),
    actions: [cancel, block],
    initialFocus: cancel,
    onClose: () => {
      safetyModal = null;
    },
  });
  return safetyModal;
}

/**
 * Show a read-only profile page for viewing another player.
 *
 * @param {Object} profile - Profile data (username, profilePic, stats)
 * @param {Object} [socket] - Socket instance (enables report/block actions)
 * @param {Object} [options] - { isBlocked } current block state for the toggle,
 *   { scope } the stats scope `profile.stats` is for (default: the device's choice)
 */
export function showPlayerProfilePage(profile, socket, options = {}) {
  socket = socket || currentSocket;
  // Remove any existing player profile page
  removePlayerProfilePage();

  // Profile picture (read-only — no upload/choose buttons)
  const hero = createPanel({
    elevation: 1,
    className: 'profile-hero screen-section',
    children: [createAvatar(profile), el('div', { className: 'profile-hero__name', text: profile.username })],
  });

  const body = [hero];

  // Report / Block actions (App Store Guideline 1.2 — UGC safety)
  if (socket) {
    const reportBtn = createButton({
      label: 'Report',
      variant: 'secondary',
      size: 'sm',
      className: 'tone-warning',
      onClick: () => openReportDialog(profile.username, socket),
    });

    let isBlocked = !!options.isBlocked;
    const blockBtn = createButton({ label: 'Block', variant: 'secondary', size: 'sm' });
    blockBtn.id = 'playerBlockButton';
    const renderBlockBtn = () => {
      blockBtn.textContent = isBlocked ? 'Unblock' : 'Block';
      blockBtn.classList.toggle('tone-danger', !isBlocked);
      blockBtn.setAttribute('aria-pressed', String(isBlocked));
    };
    renderBlockBtn();
    const toggleBlock = () => {
      socket.emit(isBlocked ? 'unblockUser' : 'blockUser', { username: profile.username });
      isBlocked = !isBlocked;
      renderBlockBtn();
    };
    blockBtn.addEventListener('click', () => {
      if (isBlocked) toggleBlock();
      else openBlockDialog(profile.username, toggleBlock);
    });

    body.push(el('div', { className: 'safety-row', children: [reportBtn, blockBtn] }));
  }

  const section = createStatsSection(
    profile.stats,
    options.scope ?? getStatsScope(),
    (next) => socket?.emit('getPlayerProfile', scopePayload({ username: profile.username }, next)),
    'playerProfileStatsRegion',
  );
  section.username = profile.username;
  playerStats = section;
  body.push(...section.nodes);

  playerProfileModal = openModal({
    title: profile.username,
    closable: true,
    closeLabel: 'Close profile',
    id: 'playerProfilePageOverlay',
    dialogId: 'playerProfilePageModal',
    className: 'page-modal',
    body,
    onClose: () => {
      playerProfileModal = null;
      closeSafetyDialog();
      section.cancel();
      if (playerStats === section) playerStats = null;
    },
  });
}

/**
 * New stats for the open player profile of the same player (a scope
 * switch's reply): only the grid changes; report / block stay.
 *
 * @returns {boolean} false when no profile of that player is open
 */
export function updatePlayerProfileStats(profile, scope) {
  if (!playerProfileModal || !playerStats || !profile || playerStats.username !== profile.username) return false;
  playerStats.update(profile.stats, scope);
  return true;
}

/** A failed stats request: the open profiles stop waiting (the error is shown elsewhere). */
export function profileStatsRequestFailed() {
  ownStats?.idle();
  playerStats?.idle();
}

/**
 * Remove the read-only player profile page.
 */
export function removePlayerProfilePage() {
  closeSafetyDialog();
  playerProfileModal?.close('api');
  playerProfileModal = null;
  document.getElementById('playerProfilePageOverlay')?.remove();
  playerStats?.cancel();
  playerStats = null;
}

/** Whether a player profile page is open (any player). */
export function isPlayerProfilePageVisible() {
  return document.getElementById('playerProfilePageOverlay') !== null;
}
