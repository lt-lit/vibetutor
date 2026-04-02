/**
 * app.js — Main app entry, state management, panel routing
 * Initializes the app, manages deckState, and wires up panels.
 */

import { initSections, expandSection, collapseSection, updateBadge, updateSummary } from './sections.js';
import { saveState, loadState } from './storage.js';
import { fetchEdhrec, commanderToSlug, setApiKey, getApiKey } from './api.js';
import { findCombos, estimateBracket } from './spellbook.js';
import * as ui from './ui.js';

/** Debounce helper for combo refresh */
let comboRefreshTimer = null;

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
  const prevCardCount = state.cards.length;
  state = { ...state, ...updates };
  saveState(state);
  render();

  // Refresh combos when deck changes (debounced 2s)
  if (updates.cards && updates.cards.length !== prevCardCount) {
    refreshCombos();
  }
}

/** Debounced combo refresh via Commander Spellbook */
function refreshCombos() {
  clearTimeout(comboRefreshTimer);
  comboRefreshTimer = setTimeout(async () => {
    if (state.cards.length === 0) return;
    const cardNames = state.cards.map(c => c.name);
    const [combosResult, bracket] = await Promise.allSettled([
      findCombos(cardNames),
      estimateBracket(cardNames),
    ]);
    const combos = combosResult.status === 'fulfilled' ? combosResult.value : { present: [], nearMiss: [] };
    const bracketVal = bracket.status === 'fulfilled' ? bracket.value : null;
    state = {
      ...state,
      combos: { ...combos, bracket: bracketVal },
    };
    saveState(state);
    render();
  }, 2000);
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
    ui.resetPanel('deck');
    render();
    expandSection('deck');
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

  // ---- Deck handlers ----

  /** Add a card to the deck */
  onAddCard(card) {
    if (state.cards.some(c => c.name === card.name)) {
      ui.showToast('Card already in deck');
      return;
    }
    const deckCard = {
      name: card.name,
      tag: null,
      scryfallData: card,
      aiPitch: null,
      edhrecSynergy: null,
      sources: ['manual'],
    };
    updateState({ cards: [...state.cards, deckCard] });
    ui.showToast(`Added ${card.name}`);
  },

  /** Remove a card from the deck */
  onRemoveCard(cardName) {
    updateState({ cards: state.cards.filter(c => c.name !== cardName) });
    ui.showToast('Card removed');
  },

  /** Move a card from deck to considering */
  onMoveToConsidering(cardName) {
    const card = state.cards.find(c => c.name === cardName);
    if (!card) return;
    const considerCard = {
      name: card.name,
      scryfallData: card.scryfallData,
      aiText: card.aiPitch,
      source: 'deck',
      inDeck: false,
      sources: card.sources || [],
    };
    updateState({
      cards: state.cards.filter(c => c.name !== cardName),
      considering: [...state.considering, considerCard],
    });
    ui.showToast(`${cardName} moved to Considering`);
  },

  /** Change a card's tag */
  onTagChange(cardName, newTag) {
    const cards = state.cards.map(c =>
      c.name === cardName ? { ...c, tag: newTag } : c
    );
    updateState({ cards });
  },

  /** Import cards from a parsed decklist */
  onImportCards(scryfallCards) {
    const existing = new Set(state.cards.map(c => c.name));
    const newCards = scryfallCards
      .filter(c => !existing.has(c.name))
      .map(c => ({
        name: c.name,
        tag: null,
        scryfallData: c,
        aiPitch: null,
        edhrecSynergy: null,
        sources: ['import'],
      }));
    updateState({ cards: [...state.cards, ...newCards] });
    ui.showToast(`Added ${newCards.length} cards`);
  },

  /** Auto-tag all cards via LLM */
  async onAutoTag() {
    if (state.cards.length === 0) {
      ui.showToast('Add cards first');
      return;
    }
    try {
      const { autoTag } = await import('./engine.js');
      const results = await autoTag(state);
      const tagMap = new Map(results.map(r => [r.name, r.tag]));
      const cards = state.cards.map(c => ({
        ...c,
        tag: tagMap.get(c.name) ?? c.tag,
      }));
      updateState({ cards, iterationCount: state.iterationCount + 1 });
      ui.showToast('Cards tagged!');
    } catch (e) {
      ui.showToast(e.message || 'Auto-tag failed');
    }
  },

  // ---- Recommendations handlers ----

  async onSuggestRecommendations(prompt) {
    // Check API key first
    if (!getApiKey()) {
      ui.showToast('Add your OpenRouter API key in Strategy settings first');
      return;
    }

    updateState({
      _recsLoading: true,
      _recsLoadingStatus: 'Analyzing deck...',
      _recsError: null,
      recommendationsResults: [],
      recommendationsPrompt: prompt,
    });

    // Add to recent prompts
    if (prompt) {
      const recent = [prompt, ...state.recentPrompts.filter(p => p !== prompt)].slice(0, 5);
      updateState({ recentPrompts: recent, _recsLoading: true, _recsLoadingStatus: 'Analyzing deck...' });
    }

    try {
      const { suggestRecommendations } = await import('./engine.js');

      // Update loading status as the engine progresses
      setTimeout(() => {
        if (state._recsLoading) updateState({ _recsLoading: true, _recsLoadingStatus: 'Searching 3 sources...' });
      }, 3000);
      setTimeout(() => {
        if (state._recsLoading) updateState({ _recsLoading: true, _recsLoadingStatus: 'AI is choosing cards...' });
      }, 7000);

      const results = await suggestRecommendations(state, prompt);
      updateState({
        recommendationsResults: results,
        _recsLoading: false,
        _recsLoadingStatus: null,
        iterationCount: state.iterationCount + 2,
      });
    } catch (e) {
      updateState({
        _recsLoading: false,
        _recsLoadingStatus: null,
        _recsError: e.message || 'Recommendation failed. Try again.',
      });
    }
  },

  onAddRecommendation(cardName) {
    const rec = state.recommendationsResults.find(r => r.name === cardName);
    if (!rec) return;

    // Add to deck
    if (!state.cards.some(c => c.name === cardName)) {
      const deckCard = {
        name: rec.name,
        tag: rec.tag || null,
        scryfallData: rec.scryfallData,
        aiPitch: rec.pitch,
        edhrecSynergy: rec.edhrecSynergy,
        sources: rec.sources || [],
      };
      updateState({
        cards: [...state.cards, deckCard],
        recommendationsResults: state.recommendationsResults.filter(r => r.name !== cardName),
      });
      ui.showToast(`Added ${cardName}`);
    }
  },

  onConsiderRecommendation(cardName) {
    const rec = state.recommendationsResults.find(r => r.name === cardName);
    if (!rec) return;

    const considerCard = {
      name: rec.name,
      scryfallData: rec.scryfallData,
      aiText: rec.pitch,
      source: 'recommendations',
      inDeck: false,
      sources: rec.sources || [],
    };
    updateState({
      considering: [...state.considering, considerCard],
      recommendationsResults: state.recommendationsResults.filter(r => r.name !== cardName),
    });
    ui.showToast(`${cardName} moved to Considering`);
  },

  onSkipRecommendation(cardName) {
    updateState({
      recommendationsResults: state.recommendationsResults.filter(r => r.name !== cardName),
      skippedRecommendations: [...state.skippedRecommendations, cardName],
    });
  },

  // ---- Cuts handlers ----

  async onSuggestCuts() {
    if (state.cards.length === 0) {
      ui.showToast('Add cards first');
      return;
    }
    if (!getApiKey()) {
      ui.showToast('Add your OpenRouter API key in Strategy settings first');
      return;
    }

    updateState({ _cutsLoading: true, _cutsError: null, cutsResults: [] });

    try {
      const { suggestCuts } = await import('./engine.js');
      const results = await suggestCuts(state);
      updateState({
        cutsResults: results,
        _cutsLoading: false,
        iterationCount: state.iterationCount + 1,
      });
    } catch (e) {
      updateState({
        _cutsLoading: false,
        _cutsError: e.message || 'Cut analysis failed. Try again.',
      });
    }
  },

  onCutCard(cardName) {
    updateState({
      cards: state.cards.filter(c => c.name !== cardName),
      cutsResults: state.cutsResults.filter(c => c.name !== cardName),
    });
    ui.showToast(`${cardName} cut from deck`);
  },

  onConsiderCut(cardName) {
    const cut = state.cutsResults.find(c => c.name === cardName);
    if (!cut) return;

    const deckCard = state.cards.find(c => c.name === cardName);
    const considerCard = {
      name: cardName,
      scryfallData: cut.scryfallData || deckCard?.scryfallData,
      aiText: cut.reason,
      source: 'cuts',
      inDeck: true,
      sources: deckCard?.sources || [],
    };
    updateState({
      considering: [...state.considering, considerCard],
      cutsResults: state.cutsResults.filter(c => c.name !== cardName),
    });
    ui.showToast(`${cardName} moved to Considering`);
  },

  onKeepCard(cardName) {
    updateState({
      cutsResults: state.cutsResults.filter(c => c.name !== cardName),
      keptCards: [...state.keptCards, cardName],
    });
    ui.showToast(`${cardName} kept`);
  },

  // ---- Considering handlers ----

  onAddFromConsidering(cardName) {
    const card = state.considering.find(c => c.name === cardName);
    if (!card) return;

    if (!state.cards.some(c => c.name === cardName)) {
      const deckCard = {
        name: card.name,
        tag: null,
        scryfallData: card.scryfallData,
        aiPitch: card.aiText,
        edhrecSynergy: null,
        sources: card.sources || [],
      };
      updateState({
        cards: [...state.cards, deckCard],
        considering: state.considering.filter(c => c.name !== cardName),
      });
      ui.showToast(`Added ${cardName} to deck`);
    }
  },

  onDismissConsidering(cardName) {
    updateState({
      considering: state.considering.filter(c => c.name !== cardName),
    });
  },

  onCutFromConsidering(cardName) {
    updateState({
      cards: state.cards.filter(c => c.name !== cardName),
      considering: state.considering.filter(c => c.name !== cardName),
    });
    ui.showToast(`${cardName} cut from deck`);
  },

  onKeepFromConsidering(cardName) {
    updateState({
      considering: state.considering.filter(c => c.name !== cardName),
    });
    ui.showToast(`${cardName} kept in deck`);
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
  if (state.cards.length > 0) {
    updateSummary('deck', `${state.cards.length}/99 cards`);
  }

  // Render panels
  ui.renderStrategyPanel(state, handlers);
  ui.renderDeckPanel(state, handlers);
  ui.renderConsideringPanel(state, handlers);
  ui.renderRecommendationsPanel(state, handlers);
  ui.renderCutsPanel(state, handlers);
  ui.renderStatsPanel(state);
  ui.updateSettingsMenu(state);
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

  // Initialize settings menu
  ui.initSettingsMenu(handlers, state);

  // Initial render
  render();
}

// Boot the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
