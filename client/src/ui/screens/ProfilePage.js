/**
 * Profile Page Screen
 *
 * Modal overlay showing user profile with stats and profile picture selection.
 */

/**
 * Module state - tracks current profile data and UI state.
 */
let currentProfile = null;
let isPictureSelectorOpen = false;
let currentSocket = null;

/**
 * Get the appropriate profile picture source.
 *
 * @param {Object} profile - Profile data
 * @returns {string} Image source (base64 or URL)
 */
function getProfilePicSrc(profile) {
  if (profile.customProfilePic) {
    return profile.customProfilePic;
  }
  if (profile.profilePic) {
    return `assets/profile${profile.profilePic}.png`;
  }
  return 'assets/default_avatar.png';
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
          cropX, cropY, cropSize, cropSize,  // Source: center square
          padding, padding, innerSize, innerSize  // Dest: centered with padding
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
async function handleFileUpload(event, socket) {
  const file = event.target.files?.[0];
  if (!file) return;

  // Validate file type
  const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
  if (!validTypes.includes(file.type)) {
    alert('Invalid file type. Please use PNG, JPEG, GIF, or WebP.');
    return;
  }

  try {
    // Resize and compress image
    const resizedImage = await resizeImage(file, 200, 0.8);

    // Send to server
    socket.emit('uploadProfilePic', { imageData: resizedImage });
  } catch (error) {
    console.error('Error processing image:', error);
    alert('Failed to process image. Please try again.');
  }
}

/**
 * Format a stat value for display.
 *
 * @param {number} value - Raw stat value
 * @param {number} gamesPlayed - Total games played (for calculating averages)
 * @param {boolean} isAverage - Whether to calculate as average
 * @param {boolean} isPercentage - Whether to display as percentage
 * @returns {string} Formatted stat string
 */
function formatStat(value, gamesPlayed, isAverage = false, isPercentage = false) {
  if (gamesPlayed === 0) return isPercentage ? '0%' : '0';
  if (isAverage) {
    const avg = value / gamesPlayed;
    return isPercentage ? `${(avg * 100).toFixed(1)}%` : avg.toFixed(1);
  }
  return String(value);
}

/**
 * Create a stat item element.
 *
 * @param {string} label - Stat label
 * @param {string} value - Stat value
 * @returns {HTMLElement} Stat item div
 */
function createStatItem(label, value) {
  const item = document.createElement('div');
  item.style.background = 'rgba(0, 0, 0, 0.4)';
  item.style.borderRadius = '8px';
  item.style.padding = '15px';
  item.style.textAlign = 'center';

  const valueEl = document.createElement('div');
  valueEl.innerText = value;
  valueEl.style.fontSize = '24px';
  valueEl.style.fontWeight = 'bold';
  valueEl.style.color = '#4ade80';
  valueEl.style.marginBottom = '5px';
  item.appendChild(valueEl);

  const labelEl = document.createElement('div');
  labelEl.innerText = label;
  labelEl.style.fontSize = '12px';
  labelEl.style.color = '#9ca3af';
  labelEl.style.textTransform = 'uppercase';
  item.appendChild(labelEl);

  return item;
}

/**
 * Create the picture selector grid.
 *
 * @param {Object} socket - Socket instance
 * @param {number} currentPic - Currently selected picture number
 * @returns {HTMLElement} Picture selector container
 */
function createPictureSelector(socket, currentPic) {
  const container = document.createElement('div');
  container.id = 'profilePicSelector';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.right = '0';
  container.style.bottom = '0';
  container.style.background = 'rgba(0, 0, 0, 0.9)';
  container.style.zIndex = '3000';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.alignItems = 'center';
  container.style.padding = '20px';
  container.style.boxSizing = 'border-box';

  // Header
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.width = '100%';
  header.style.maxWidth = '800px';
  header.style.marginBottom = '20px';

  const title = document.createElement('div');
  title.innerText = 'Select Profile Picture';
  title.style.fontSize = '24px';
  title.style.fontWeight = 'bold';
  title.style.color = '#fff';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.innerText = 'X';
  closeBtn.style.background = '#ef4444';
  closeBtn.style.border = 'none';
  closeBtn.style.borderRadius = '50%';
  closeBtn.style.width = '36px';
  closeBtn.style.height = '36px';
  closeBtn.style.color = '#fff';
  closeBtn.style.fontSize = '18px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontWeight = 'bold';
  closeBtn.addEventListener('click', () => {
    removePictureSelector();
  });
  header.appendChild(closeBtn);

  container.appendChild(header);

  // Picture grid
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(80px, 1fr))';
  grid.style.gap = '10px';
  grid.style.width = '100%';
  grid.style.maxWidth = '800px';
  grid.style.maxHeight = 'calc(100vh - 120px)';
  grid.style.overflowY = 'auto';
  grid.style.padding = '10px';
  grid.style.boxSizing = 'border-box';

  // Create 82 profile pic options
  for (let i = 1; i <= 82; i++) {
    const picBtn = document.createElement('button');
    picBtn.style.width = '80px';
    picBtn.style.height = '80px';
    picBtn.style.borderRadius = '8px';
    picBtn.style.border = i === currentPic ? '3px solid #4ade80' : '2px solid #4a5568';
    picBtn.style.background = 'rgba(0, 0, 0, 0.5)';
    picBtn.style.cursor = 'pointer';
    picBtn.style.padding = '0';
    picBtn.style.overflow = 'hidden';
    picBtn.style.transition = 'transform 0.2s, border-color 0.2s';

    const img = document.createElement('img');
    img.src = `assets/profile${i}.png`;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.alt = `Profile ${i}`;
    picBtn.appendChild(img);

    picBtn.addEventListener('mouseenter', () => {
      if (i !== currentPic) {
        picBtn.style.transform = 'scale(1.1)';
        picBtn.style.border = '2px solid #60a5fa';
      }
    });
    picBtn.addEventListener('mouseleave', () => {
      picBtn.style.transform = 'scale(1)';
      picBtn.style.border = i === currentPic ? '3px solid #4ade80' : '2px solid #4a5568';
    });
    picBtn.addEventListener('click', () => {
      socket.emit('updateProfilePic', { profilePic: i });
      removePictureSelector();
    });

    grid.appendChild(picBtn);
  }

  container.appendChild(grid);

  return container;
}

/**
 * Remove the picture selector.
 */
function removePictureSelector() {
  const selector = document.getElementById('profilePicSelector');
  if (selector) selector.remove();
  isPictureSelectorOpen = false;
}

/**
 * Show the profile page.
 *
 * @param {Object} profile - Profile data (username, profilePic, stats)
 * @param {Object} socket - Socket instance
 */
export function showProfilePage(profile, socket) {
  console.log('Showing profile page...', profile);

  // Remove any existing profile page
  removeProfilePage();

  currentProfile = profile;
  currentSocket = socket;

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'profilePageOverlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0, 0, 0, 0.7)';
  overlay.style.zIndex = '2000';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  // Create modal container
  const modal = document.createElement('div');
  modal.id = 'profilePageModal';
  modal.style.background = 'rgba(26, 26, 46, 0.98)';
  modal.style.color = '#fff';
  modal.style.padding = '30px';
  modal.style.borderRadius = '12px';
  modal.style.border = '2px solid #4a5568';
  modal.style.width = '500px';
  modal.style.maxWidth = '95vw';
  modal.style.maxHeight = '90vh';
  modal.style.overflow = 'auto';
  modal.style.boxSizing = 'border-box';
  modal.style.fontFamily = 'Arial, sans-serif';

  // Header
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.marginBottom = '25px';

  const title = document.createElement('div');
  title.innerText = profile.username;
  title.style.fontSize = '28px';
  title.style.fontWeight = 'bold';
  title.style.color = '#4ade80';
  headerRow.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.innerText = 'X';
  closeBtn.style.background = '#ef4444';
  closeBtn.style.border = 'none';
  closeBtn.style.borderRadius = '50%';
  closeBtn.style.width = '36px';
  closeBtn.style.height = '36px';
  closeBtn.style.color = '#fff';
  closeBtn.style.fontSize = '18px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontWeight = 'bold';
  closeBtn.addEventListener('click', () => {
    removeProfilePage();
  });
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = '#dc2626';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = '#ef4444';
  });
  headerRow.appendChild(closeBtn);

  modal.appendChild(headerRow);

  // Profile picture section
  const picSection = document.createElement('div');
  picSection.style.display = 'flex';
  picSection.style.alignItems = 'center';
  picSection.style.gap = '20px';
  picSection.style.marginBottom = '30px';
  picSection.style.padding = '20px';
  picSection.style.background = 'rgba(0, 0, 0, 0.3)';
  picSection.style.borderRadius = '8px';

  const picContainer = document.createElement('div');
  picContainer.id = 'profilePicContainer';
  picContainer.style.width = '100px';
  picContainer.style.height = '100px';
  picContainer.style.borderRadius = '50%';
  picContainer.style.border = '3px solid #4ade80';
  picContainer.style.overflow = 'hidden';
  picContainer.style.flexShrink = '0';

  const picImg = document.createElement('img');
  picImg.id = 'profilePicImage';
  picImg.src = getProfilePicSrc(profile);
  picImg.style.width = '100%';
  picImg.style.height = '100%';
  picImg.style.objectFit = 'cover';
  picImg.alt = 'Profile Picture';
  picContainer.appendChild(picImg);

  picSection.appendChild(picContainer);

  const picInfo = document.createElement('div');
  picInfo.style.flex = '1';

  const picLabel = document.createElement('div');
  picLabel.innerText = 'Profile Picture';
  picLabel.style.fontSize = '14px';
  picLabel.style.color = '#9ca3af';
  picLabel.style.marginBottom = '10px';
  picInfo.appendChild(picLabel);

  // Button container for both buttons
  const buttonContainer = document.createElement('div');
  buttonContainer.style.display = 'flex';
  buttonContainer.style.gap = '10px';
  buttonContainer.style.flexWrap = 'wrap';

  // Upload custom picture button
  const uploadBtn = document.createElement('button');
  uploadBtn.innerText = 'Upload Picture';
  uploadBtn.style.padding = '10px 20px';
  uploadBtn.style.borderRadius = '6px';
  uploadBtn.style.border = 'none';
  uploadBtn.style.background = '#4ade80';
  uploadBtn.style.color = '#000';
  uploadBtn.style.fontSize = '14px';
  uploadBtn.style.cursor = 'pointer';
  uploadBtn.style.fontWeight = 'bold';

  // Hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/jpg,image/gif,image/webp';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', (e) => handleFileUpload(e, socket));

  uploadBtn.addEventListener('click', () => {
    fileInput.click();
  });
  uploadBtn.addEventListener('mouseenter', () => {
    uploadBtn.style.background = '#22c55e';
  });
  uploadBtn.addEventListener('mouseleave', () => {
    uploadBtn.style.background = '#4ade80';
  });
  buttonContainer.appendChild(uploadBtn);
  buttonContainer.appendChild(fileInput);

  // Choose from gallery button
  const changePicBtn = document.createElement('button');
  changePicBtn.innerText = 'Choose Avatar';
  changePicBtn.style.padding = '10px 20px';
  changePicBtn.style.borderRadius = '6px';
  changePicBtn.style.border = 'none';
  changePicBtn.style.background = '#3b82f6';
  changePicBtn.style.color = '#fff';
  changePicBtn.style.fontSize = '14px';
  changePicBtn.style.cursor = 'pointer';
  changePicBtn.style.fontWeight = 'bold';
  changePicBtn.addEventListener('click', () => {
    if (!isPictureSelectorOpen) {
      isPictureSelectorOpen = true;
      const selector = createPictureSelector(socket, profile.profilePic);
      document.body.appendChild(selector);
    }
  });
  changePicBtn.addEventListener('mouseenter', () => {
    changePicBtn.style.background = '#2563eb';
  });
  changePicBtn.addEventListener('mouseleave', () => {
    changePicBtn.style.background = '#3b82f6';
  });
  buttonContainer.appendChild(changePicBtn);

  picInfo.appendChild(buttonContainer);
  picSection.appendChild(picInfo);
  modal.appendChild(picSection);

  // Stats section
  const statsHeader = document.createElement('div');
  statsHeader.innerText = 'Game Statistics';
  statsHeader.style.fontSize = '18px';
  statsHeader.style.fontWeight = 'bold';
  statsHeader.style.marginBottom = '15px';
  statsHeader.style.color = '#60a5fa';
  modal.appendChild(statsHeader);

  const stats = profile.stats;
  const gamesPlayed = stats.gamesPlayed || 0;

  const statsGrid = document.createElement('div');
  statsGrid.style.display = 'grid';
  statsGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
  statsGrid.style.gap = '10px';

  // Row 1: Games, Wins, Losses
  statsGrid.appendChild(createStatItem('Games Played', String(gamesPlayed)));
  statsGrid.appendChild(createStatItem('Wins', String(stats.wins || 0)));
  statsGrid.appendChild(createStatItem('Losses', String(stats.losses || 0)));

  // Row 2: Win %, Points/Game, Tricks Bid/Game
  const winPct = gamesPlayed > 0 ? ((stats.wins / gamesPlayed) * 100).toFixed(1) + '%' : '0%';
  const pointsPerGame = gamesPlayed > 0 ? (stats.totalPoints / gamesPlayed).toFixed(1) : '0';
  const bidPerGame = gamesPlayed > 0 ? (stats.totalTricksBid / gamesPlayed).toFixed(1) : '0';
  const tricksPerGame = gamesPlayed > 0 ? (stats.totalTricksTaken / gamesPlayed).toFixed(1) : '0';

  statsGrid.appendChild(createStatItem('Win Rate', winPct));
  statsGrid.appendChild(createStatItem('Points/Game', pointsPerGame));
  statsGrid.appendChild(createStatItem('Bids/Game', bidPerGame));

  // Row 3: Tricks/Game, Tricks per Bid, Set Rate
  statsGrid.appendChild(createStatItem('Tricks/Game', tricksPerGame));
  const tricksPerBid = stats.totalTricksBid > 0
    ? (stats.totalTricksTaken / stats.totalTricksBid).toFixed(2)
    : '0';
  statsGrid.appendChild(createStatItem('Tricks/Bid', tricksPerBid));
  const setRate = stats.totalHands > 0
    ? ((stats.totalSets / stats.totalHands) * 100).toFixed(1) + '%'
    : '0%';
  statsGrid.appendChild(createStatItem('Set Rate', setRate));

  modal.appendChild(statsGrid);

  overlay.appendChild(modal);

  // Close on overlay click (but not modal click)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      removeProfilePage();
    }
  });

  document.body.appendChild(overlay);
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
    picImg.src = `assets/profile${newPic}.png`;
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
    picImg.src = customPic;
  }
}

/**
 * Remove the profile page.
 */
export function removeProfilePage() {
  const overlay = document.getElementById('profilePageOverlay');
  if (overlay) overlay.remove();
  removePictureSelector();
  currentProfile = null;
  isPictureSelectorOpen = false;
}

/**
 * Check if profile page is currently visible.
 *
 * @returns {boolean} True if profile page is visible
 */
export function isProfilePageVisible() {
  return document.getElementById('profilePageOverlay') !== null;
}
