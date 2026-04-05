/**
 * storage.js — Storage management
 * Session storage for working state + localStorage for deck library.
 */

const STORAGE_KEY = 'vibetutor_state';
const DECKS_KEY = 'vibetutor_decks';

// ============================================================
// SESSION STORAGE (working state)
// ============================================================

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

// ============================================================
// DECK LIBRARY (localStorage)
// ============================================================

/**
 * Load all saved decks from localStorage.
 * @returns {Array} array of lightweight deck objects
 */
export function loadDecks() {
  try {
    const raw = localStorage.getItem(DECKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Failed to load decks:', e);
    return [];
  }
}

/**
 * Save the full deck list to localStorage.
 * @param {Array} decks
 */
export function saveDecks(decks) {
  try {
    localStorage.setItem(DECKS_KEY, JSON.stringify(decks));
  } catch (e) {
    console.warn('Failed to save decks:', e);
  }
}

/**
 * Strip heavy data from state for lightweight storage.
 * Keeps only what's needed to reconstruct the deck on load.
 */
function slimDeck(state) {
  return {
    deckId: state.deckId,
    deckName: state.deckName,
    commander: state.commander ? {
      name: state.commander.name,
      imageUri: state.commander.imageUris?.normal || state.commander.imageUri || null,
    } : null,
    strategy: state.strategy,
    cards: state.cards.map(c => ({
      name: c.name, tag: c.tag, sources: c.sources,
      set: c.scryfallData?.set || undefined,
      collectorNumber: c.scryfallData?.collectorNumber || undefined,
    })),
    considering: state.considering.map(c => ({
      name: c.name, tag: c.tag,
      set: c.scryfallData?.set || undefined,
      collectorNumber: c.scryfallData?.collectorNumber || undefined,
    })),
    skippedRecommendations: state.skippedRecommendations.map(c =>
      typeof c === 'string' ? c : c.name
    ),
    recentPrompts: state.recentPrompts || [],
    iterationCount: state.iterationCount || 0,
    lastModified: Date.now(),
  };
}

/**
 * Save the current working state to the deck library.
 * Creates or updates the deck entry by deckId.
 * @param {object} state — current app state (must have deckId set)
 */
export function saveDeckToLibrary(state) {
  if (!state.deckId) return;
  const decks = loadDecks();
  const slim = slimDeck(state);
  const idx = decks.findIndex(d => d.deckId === state.deckId);
  if (idx >= 0) {
    decks[idx] = slim;
  } else {
    decks.push(slim);
  }
  saveDecks(decks);
}

/**
 * Load a saved deck by ID from the library.
 * @param {string} id
 * @returns {object|null} lightweight deck data
 */
export function loadDeckFromLibrary(id) {
  const decks = loadDecks();
  return decks.find(d => d.deckId === id) || null;
}

/**
 * Delete a deck from the library.
 * @param {string} id
 */
export function deleteDeckFromLibrary(id) {
  const decks = loadDecks();
  saveDecks(decks.filter(d => d.deckId !== id));
}

/**
 * Duplicate a deck in the library.
 * @param {string} id — deck to duplicate
 * @returns {string|null} new deck ID, or null if source not found
 */
export function duplicateDeck(id) {
  const decks = loadDecks();
  const source = decks.find(d => d.deckId === id);
  if (!source) return null;
  const newId = crypto.randomUUID();
  const copy = { ...source, deckId: newId, deckName: source.deckName + ' (Copy)', lastModified: Date.now() };
  decks.push(copy);
  saveDecks(decks);
  return newId;
}

/**
 * Rename a deck in the library.
 * @param {string} id
 * @param {string} name
 */
export function renameDeck(id, name) {
  const decks = loadDecks();
  const deck = decks.find(d => d.deckId === id);
  if (deck) {
    deck.deckName = name;
    deck.lastModified = Date.now();
    saveDecks(decks);
  }
}
