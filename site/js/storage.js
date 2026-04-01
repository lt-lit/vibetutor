/**
 * storage.js — sessionStorage management
 * Auto-saves and restores deck state across page refreshes.
 */

const STORAGE_KEY = 'vibetutor_state';

/**
 * Save deck state to sessionStorage.
 * @param {object} state
 */
export function saveState(state) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state:', e);
  }
}

/**
 * Load deck state from sessionStorage.
 * @returns {object|null}
 */
export function loadState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Failed to load state:', e);
    return null;
  }
}

/**
 * Clear saved state.
 */
export function clearState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Failed to clear state:', e);
  }
}
