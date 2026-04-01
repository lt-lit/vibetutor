/**
 * app.js — Main app entry, state management, panel routing
 * Initializes the app, manages deckState, and wires up panels.
 */

import { initSections, expandSection, collapseSection, updateBadge } from './sections.js';
import { saveState, loadState } from './storage.js';
import * as ui from './ui.js';

/** Default deck state */
function createDefaultState() {
  return {
    commander: null,

    strategy: {
      notes: '',
      powerLevel: 'mid',
      budgetCap: null,
    },

    edhrecData: { loaded: false, cardRecs: [], lastFetched: null },

    cards: [],

    skippedRecommendations: [],
    keptCards: [],

    considering: [],

    combos: { present: [], nearMiss: [], bracket: null },

    recommendationsPrompt: '',
    recommendationsResults: [],
    recentPrompts: [],

    cutsResults: [],

    iterationCount: 0,

    settings: {
      model: 'anthropic/claude-sonnet-4',
    },
  };
}

/** Current app state */
let state = createDefaultState();

/**
 * Get the current state (read-only reference).
 * @returns {object}
 */
export function getState() {
  return state;
}

/**
 * Update state and trigger re-render + save.
 * @param {object} updates — partial state to merge
 */
export function updateState(updates) {
  state = { ...state, ...updates };
  saveState(state);
  render();
}

/**
 * Render all panels based on current state.
 */
function render() {
  // Update badges
  const cardCount = state.cards.length;
  updateBadge('deck', `${cardCount}/99`);

  const consideringCount = state.considering.length;
  updateBadge('considering', consideringCount > 0 ? `${consideringCount}` : '');

  const recsCount = state.recommendationsResults.length;
  updateBadge('recommendations', recsCount > 0 ? `${recsCount}` : '');

  const cutsCount = state.cutsResults.length;
  updateBadge('cuts', cutsCount > 0 ? `${cutsCount}` : '');

  // Render panels
  ui.renderStrategyPanel(state, {});
  ui.renderDeckPanel(state, {});
  ui.renderConsideringPanel(state, {});
  ui.renderRecommendationsPanel(state, {});
  ui.renderCutsPanel(state, {});
  ui.renderStatsPanel(state);
}

/**
 * Initialize the app.
 */
function init() {
  // Restore state from sessionStorage
  const saved = loadState();
  if (saved) {
    state = { ...createDefaultState(), ...saved };
  }

  // Initialize collapsible sections
  initSections();

  // Set initial section states
  if (!state.commander) {
    expandSection('strategy');
  } else {
    collapseSection('strategy');
  }

  // Set up card overlay dismiss
  const overlay = document.getElementById('card-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('card-overlay-backdrop')) {
        ui.hideCardOverlay();
      }
    });
  }

  // Initial render
  render();
}

// Boot the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
