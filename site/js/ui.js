/**
 * ui.js — DOM manipulation and rendering
 * Renders panels and handles user interactions.
 * Stub for Session 1 — panels implemented in Sessions 3-7.
 */

/**
 * Render the Strategy panel.
 * @param {object} state — deck state
 * @param {object} handlers — event handler callbacks
 */
export function renderStrategyPanel(state, handlers) {
  // TODO: Session 3
  const el = document.getElementById('strategy-panel');
  if (el) el.innerHTML = '<div class="empty-state">Select a commander to start building</div>';
}

/**
 * Render the Deck panel.
 * @param {object} state
 * @param {object} handlers
 */
export function renderDeckPanel(state, handlers) {
  // TODO: Session 4
  const el = document.getElementById('deck-panel');
  if (el) el.innerHTML = '<div class="empty-state">Your deck will appear here</div>';
}

/**
 * Render the Considering panel.
 * @param {object} state
 * @param {object} handlers
 */
export function renderConsideringPanel(state, handlers) {
  // TODO: Session 6
  const el = document.getElementById('considering-panel');
  if (el) el.innerHTML = '<div class="empty-state">Cards you\'re thinking about will appear here</div>';
}

/**
 * Render the Recommendations panel.
 * @param {object} state
 * @param {object} handlers
 */
export function renderRecommendationsPanel(state, handlers) {
  // TODO: Session 6
  const el = document.getElementById('recommendations-panel');
  if (el) el.innerHTML = '<div class="empty-state">AI-powered card suggestions</div>';
}

/**
 * Render the Cuts panel.
 * @param {object} state
 * @param {object} handlers
 */
export function renderCutsPanel(state, handlers) {
  // TODO: Session 6
  const el = document.getElementById('cuts-panel');
  if (el) el.innerHTML = '<div class="empty-state">Suggest cards to remove</div>';
}

/**
 * Render the Stats panel.
 * @param {object} state
 */
export function renderStatsPanel(state) {
  // TODO: Session 7
  const el = document.getElementById('stats-panel');
  if (el) el.innerHTML = '<div class="empty-state">Add cards to see stats</div>';
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {number} duration — ms (default 3000)
 */
export function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

/**
 * Show the card overlay with a full-size image.
 * @param {string} imageUrl
 * @param {string} altText
 */
export function showCardOverlay(imageUrl, altText) {
  const overlay = document.getElementById('card-overlay');
  if (!overlay) return;

  const img = overlay.querySelector('.card-overlay-image');
  img.src = imageUrl;
  img.alt = altText || 'Card preview';
  overlay.hidden = false;
}

/**
 * Hide the card overlay.
 */
export function hideCardOverlay() {
  const overlay = document.getElementById('card-overlay');
  if (overlay) {
    overlay.hidden = true;
    overlay.querySelector('.card-overlay-image').src = '';
  }
}
