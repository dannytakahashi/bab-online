/**
 * Bid UI component for bidding phase.
 *
 * Creates bid button grid with bore support.
 */

/**
 * Create bid UI.
 *
 * @param {Object} options - Bid UI options
 * @param {number} options.maxBid - Maximum bid allowed
 * @param {number} options.currentMult - Current multiplier (for bore)
 * @param {boolean} options.canBore - Whether bore is available
 * @param {Function} options.onBid - Called with bid value
 * @param {Function} options.onBore - Called when bore selected
 * @returns {Object} { container, destroy, enable, disable }
 */
export function createBidUI({
  maxBid = 13,
  currentMult = 1,
  canBore = false,
  onBid,
  onBore,
}) {
  const container = document.createElement('div');
  container.id = 'bid-container';
  container.className = 'bid-container';
  container.style.cssText = `
    position: fixed;
    bottom: 20%;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    z-index: 500;
    background: rgba(0, 0, 0, 0.8);
    padding: 20px;
    border-radius: 12px;
  `;

  // Title
  const title = document.createElement('div');
  title.textContent = 'Your Bid';
  title.style.cssText = `
    color: white;
    font-size: 18px;
    margin-bottom: 10px;
  `;
  container.appendChild(title);

  // Bid buttons grid
  const buttonGrid = document.createElement('div');
  buttonGrid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 8px;
  `;

  const buttons = [];

  // Create bid buttons (0 to maxBid)
  for (let i = 0; i <= maxBid; i++) {
    const btn = document.createElement('button');
    btn.textContent = i.toString();
    btn.className = 'bid-button';
    btn.style.cssText = `
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 8px;
      background: #23782d;
      color: white;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.1s, background 0.1s;
    `;

    btn.onclick = () => {
      if (onBid) onBid(i.toString());
    };

    btn.onmouseenter = () => {
      btn.style.transform = 'scale(1.1)';
      btn.style.background = '#2e9938';
    };

    btn.onmouseleave = () => {
      btn.style.transform = 'scale(1)';
      btn.style.background = '#23782d';
    };

    buttons.push(btn);
    buttonGrid.appendChild(btn);
  }

  container.appendChild(buttonGrid);

  // Bore button (if available)
  let boreBtn = null;
  if (canBore) {
    boreBtn = document.createElement('button');
    const boreLabel = currentMult === 1 ? 'B' : `${currentMult}B`;
    boreBtn.textContent = `Bore (${boreLabel})`;
    boreBtn.className = 'bore-button';
    boreBtn.style.cssText = `
      margin-top: 10px;
      padding: 10px 30px;
      border: none;
      border-radius: 8px;
      background: #ff9800;
      color: white;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.1s, background 0.1s;
    `;

    boreBtn.onclick = () => {
      if (onBore) onBore();
    };

    boreBtn.onmouseenter = () => {
      boreBtn.style.transform = 'scale(1.05)';
      boreBtn.style.background = '#ffa726';
    };

    boreBtn.onmouseleave = () => {
      boreBtn.style.transform = 'scale(1)';
      boreBtn.style.background = '#ff9800';
    };

    container.appendChild(boreBtn);
  }

  // Enable/disable functions
  const enable = () => {
    container.style.pointerEvents = 'auto';
    container.style.opacity = '1';
  };

  const disable = () => {
    container.style.pointerEvents = 'none';
    container.style.opacity = '0.5';
  };

  // Destroy function
  const destroy = () => {
    container.remove();
  };

  return {
    container,
    destroy,
    enable,
    disable,
    buttons,
    boreBtn,
  };
}

/**
 * Show bid UI and return it.
 */
export function showBidUI(options) {
  const ui = createBidUI(options);
  document.body.appendChild(ui.container);
  return ui;
}

/**
 * Create bid bubble for displaying opponent bids.
 *
 * @param {Object} options - Bubble options
 * @param {string} options.bid - Bid value
 * @param {number} options.x - X position
 * @param {number} options.y - Y position
 * @param {string} options.color - Background color
 * @returns {Object} { container, destroy }
 */
export function createBidBubble({ bid, x, y, color = '#23782d' }) {
  const bubble = document.createElement('div');
  bubble.className = 'bid-bubble';
  bubble.textContent = bid;
  bubble.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    transform: translate(-50%, -50%);
    background: ${color};
    color: white;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 18px;
    font-weight: bold;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    z-index: 400;
    animation: bidBubbleAppear 0.3s ease-out;
  `;

  // Add animation keyframes if not present
  if (!document.getElementById('bid-bubble-styles')) {
    const style = document.createElement('style');
    style.id = 'bid-bubble-styles';
    style.textContent = `
      @keyframes bidBubbleAppear {
        from {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.5);
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      }
    `;
    document.head.appendChild(style);
  }

  const destroy = () => {
    bubble.remove();
  };

  return { container: bubble, destroy };
}
