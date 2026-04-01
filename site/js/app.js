/**
 * app.js — Main app entry, state management, panel routing
 * Initializes the app, manages deckState, and wires up panels.
 */

import { initSections, expandSection, collapseSection, updateBadge, updateSummary } from './sections.js';
import { saveState, loadState } from './storage.js';
import { fetchEdhrec, commanderToSlug, setApiKey, getApiKey } from './api.js';
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
 * @param {object} updates — partial state to merge (shallow)
 */
export function updateState(updates) {
  state = { ...state, ...updates };
  saveState(state);
  render();
}

/**
 * Update nested state (e.g. strategy.notes) and trigger re-render + save.
 * @param {string} key — top-level key
 * @param {object} updates — partial object to merge into state[key]
 */
function updateNestedState(key, updates) {
  state = {
    ...state,
    [key]: { ...state[key], ...updates },
  };
  saveState(state);
  render();
}

// ============================================================
// EVENT HANDLERS
// ============================================================

const handlers = {
  /** Commander selected from autocomplete dropdown */
  onCommanderSelect(card) {
    updateState({ commander: card });

    // Collapse strategy, expand deck
    collapseSection('strategy');

    // Fetch EDHREC data in background
    const slug = commanderToSlug(card.name);
    fetchEdhrec(slug).then(data => {
      if (data) {
        updateState({ edhrecData: data });
      }
    });
  },

  /** User wants to change commander */
  onCommanderChange() {
    updateState({ commander: null });
    ui.resetPanel('strategy');
    render();
    expandSection('strategy');
  },

  /** Strategy fields updated (notes, powerLevel, budgetCap) */
  onStrategyUpdate(updates) {
    updateNestedState('strategy', updates);
  },

  /** Settings updated (model) */
  onSettingsUpdate(updates) {
    updateNestedState('settings', updates);
  },

  /** API key changed */
  onApiKeyChange(key) {
    setApiKey(key);
  },
};

// ============================================================
// RENDERING
// ============================================================

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

  // Update summaries for collapsed sections
  if (state.commander) {
    updateSummary('strategy', state.commander.name);
  }

  // Render panels
  ui.renderStrategyPanel(state, handlers);
  ui.renderDeckPanel(state, handlers);
  ui.renderConsideringPanel(state, handlers);
  ui.renderRecommendationsPanel(state, handlers);
  ui.renderCutsPanel(state, handlers);
  ui.renderStatsPanel(state);
}

// ============================================================
// INITIALIZATION
// ============================================================

function init() {
  // Restore state from sessionStorage
  const saved = loadState();
  if (saved) {
    state = { ...createDefaultState(), ...saved };
  }

  // Initialize collapsible sections
  initSections();

  // Set initial section states based on whether a commander is selected
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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) {
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
