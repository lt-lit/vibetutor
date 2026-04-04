/**
 * app.js — Main app entry, state management, panel routing
 * Initializes the app, manages deckState, and wires up panels.
 */

import { initSections, expandSection, collapseSection, updateBadge, updateSummary } from './sections.js';
import { saveState, loadState, loadDecks, saveDeckToLibrary, loadDeckFromLibrary, deleteDeckFromLibrary, duplicateDeck, renameDeck } from './storage.js';
import { fetchEdhrec, commanderToSlug, setApiKey, getApiKey } from './api.js';
import { findCombos, estimateBracket } from './spellbook.js';
import * as ui from './ui.js';

/** Debounce helper for combo refresh */
let comboRefreshTimer = null;

/** Debounce timer for auto-saving to deck library */
let librarySaveTimer = null;

/** Render batching — coalesce multiple updateState() calls into one render */
let renderScheduled = false;
let savedScrollY = null;
let dirtyKeys = new Set();

function scheduleRender() {
  if (!renderScheduled) {
    savedScrollY = window.scrollY;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      const scrollToRestore = savedScrollY;
      savedScrollY = null;
      renderActual(scrollToRestore);
    });
  }
}

/** Default deck state */
function createDefaultState() {
  return {
    deckId: null,
    deckName: null,

    commander: null,

    strategy: {
      notes: '',
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
  for (const k of Object.keys(updates)) dirtyKeys.add(k);
  scheduleRender();

  // Refresh combos when deck changes (debounced 2s)
  if (updates.cards && updates.cards.length !== prevCardCount) {
    refreshCombos();
  }

  // Auto-save to deck library (debounced 1s)
  if (state.deckId) {
    clearTimeout(librarySaveTimer);
    librarySaveTimer = setTimeout(() => {
      saveDeckToLibrary(state);
      dirtyKeys.add('_decksLibrary');
      scheduleRender();
    }, 1000);
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
    dirtyKeys.add('combos');
    scheduleRender();
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
  dirtyKeys.add(key);
  scheduleRender();
}

// ============================================================
// EVENT HANDLERS
// ============================================================

const handlers = {
  /** Commander selected from autocomplete dropdown */
  onCommanderSelect(card) {
    const updates = { commander: card };
    // Auto-create deck if this is a new/unsaved deck
    if (!state.deckId) {
      updates.deckId = crypto.randomUUID();
      updates.deckName = card.name;
    }
    updateState(updates);

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
      tag: card.tag || null,
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

  /** Change a card's tag (works for both deck and considering cards) */
  onTagChange(cardName, newTag) {
    const updates = {};
    if (state.cards.some(c => c.name === cardName)) {
      updates.cards = state.cards.map(c =>
        c.name === cardName ? { ...c, tag: newTag } : c
      );
    }
    if (state.considering.some(c => c.name === cardName)) {
      updates.considering = state.considering.map(c =>
        c.name === cardName ? { ...c, tag: newTag } : c
      );
    }
    if (state.skippedRecommendations.some(c => c.name === cardName)) {
      updates.skippedRecommendations = state.skippedRecommendations.map(c =>
        c.name === cardName ? { ...c, tag: newTag } : c
      );
    }
    updateState(updates);
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
      tag: rec.tag || null,
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
    const rec = state.recommendationsResults.find(r => r.name === cardName);
    const dismissedCard = rec ? {
      name: rec.name,
      tag: rec.tag || null,
      scryfallData: rec.scryfallData,
      pitch: rec.pitch,
      sources: rec.sources || [],
    } : { name: cardName };
    updateState({
      recommendationsResults: state.recommendationsResults.filter(r => r.name !== cardName),
      skippedRecommendations: [...state.skippedRecommendations, dismissedCard],
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
      tag: deckCard?.tag || null,
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
        tag: card.tag || null,
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

  // ---- Dismissed handlers ----

  onRemoveDismissed(cardName) {
    updateState({
      skippedRecommendations: state.skippedRecommendations.filter(c => (c.name || c) !== cardName),
    });
    ui.showToast(`${cardName} removed — will appear in future recommendations`);
  },

  onAddFromDismissed(cardName) {
    const card = state.skippedRecommendations.find(c => (c.name || c) === cardName);
    if (!card || typeof card === 'string') return;

    if (!state.cards.some(c => c.name === cardName)) {
      const deckCard = {
        name: card.name,
        tag: card.tag || null,
        scryfallData: card.scryfallData,
        aiPitch: card.pitch,
        edhrecSynergy: null,
        sources: card.sources || [],
      };
      updateState({
        cards: [...state.cards, deckCard],
        skippedRecommendations: state.skippedRecommendations.filter(c => (c.name || c) !== cardName),
      });
      ui.showToast(`Added ${cardName} to deck`);
    }
  },

  onConsiderFromDismissed(cardName) {
    const card = state.skippedRecommendations.find(c => (c.name || c) === cardName);
    if (!card || typeof card === 'string') return;

    const considerCard = {
      name: card.name,
      tag: card.tag || null,
      scryfallData: card.scryfallData,
      aiText: card.pitch,
      source: 'dismissed',
      inDeck: false,
      sources: card.sources || [],
    };
    updateState({
      considering: [...state.considering, considerCard],
      skippedRecommendations: state.skippedRecommendations.filter(c => (c.name || c) !== cardName),
    });
    ui.showToast(`${cardName} moved to Considering`);
  },

  // ---- My Decks handlers ----

  onNewDeck() {
    // Save current deck first if it exists
    if (state.deckId) {
      saveDeckToLibrary(state);
    }
    // Reset to blank state, preserving settings
    const settings = state.settings;
    state = { ...createDefaultState(), settings };
    saveState(state);
    ui.resetPanel('mydecks');
    ui.resetPanel('strategy');
    ui.resetPanel('deck');
    ui.resetPanel('considering');
    ui.resetPanel('dismissed');
    ui.resetPanel('recommendations');
    ui.resetPanel('cuts');
    ui.resetPanel('stats');
    dirtyKeys = new Set();
    expandSection('strategy');
    renderActual(null);
    ui.showToast('New deck started');
  },

  async onLoadDeck(deckId) {
    if (deckId === state.deckId) return;
    // Save current deck first
    if (state.deckId) {
      saveDeckToLibrary(state);
    }
    const deckData = loadDeckFromLibrary(deckId);
    if (!deckData) {
      ui.showToast('Deck not found');
      return;
    }
    // Reset panels so they rebuild fresh
    ui.resetPanel('mydecks');
    ui.resetPanel('strategy');
    ui.resetPanel('deck');
    ui.resetPanel('considering');
    ui.resetPanel('dismissed');
    ui.resetPanel('recommendations');
    ui.resetPanel('cuts');
    ui.resetPanel('stats');

    // Rebuild state from saved data
    const settings = state.settings;
    state = {
      ...createDefaultState(),
      settings,
      deckId: deckData.deckId,
      deckName: deckData.deckName,
      strategy: deckData.strategy || createDefaultState().strategy,
      cards: deckData.cards.map(c => ({
        name: c.name,
        tag: c.tag,
        scryfallData: null,
        aiPitch: null,
        edhrecSynergy: null,
        sources: c.sources || [],
      })),
      considering: (deckData.considering || []).map(c => ({
        name: c.name,
        tag: c.tag,
        scryfallData: null,
        aiText: null,
        source: 'saved',
        inDeck: false,
        sources: [],
      })),
      skippedRecommendations: (deckData.skippedRecommendations || []).map(name =>
        typeof name === 'string' ? { name, scryfallData: null } : name
      ),
      recentPrompts: deckData.recentPrompts || [],
      iterationCount: deckData.iterationCount || 0,
    };
    saveState(state);
    dirtyKeys = new Set();
    renderActual(null);

    // Rehydrate commander + Scryfall data in background
    if (deckData.commander) {
      try {
        const { lookupCard } = await import('./scryfall.js');
        const card = await lookupCard(deckData.commander.name);
        if (card) {
          updateState({ commander: card });
          // Fetch EDHREC data
          const slug = commanderToSlug(card.name);
          fetchEdhrec(slug).then(data => {
            if (data) updateState({ edhrecData: data });
          });
        }
      } catch (e) {
        console.warn('Failed to rehydrate commander:', e);
      }
    }

    // Rehydrate card Scryfall data
    if (deckData.cards.length > 0) {
      try {
        const { bulkLookup } = await import('./scryfall.js');
        const allNames = [
          ...deckData.cards.map(c => c.name),
          ...(deckData.considering || []).map(c => c.name),
        ];
        const results = await bulkLookup(allNames);
        const cardMap = new Map(results.map(c => [c.name, c]));

        const cards = state.cards.map(c => ({
          ...c,
          scryfallData: cardMap.get(c.name) || null,
        }));
        const considering = state.considering.map(c => ({
          ...c,
          scryfallData: cardMap.get(c.name) || null,
        }));
        updateState({ cards, considering });
      } catch (e) {
        console.warn('Failed to rehydrate card data:', e);
      }
    }

    ui.showToast(`Loaded "${deckData.deckName}"`);
  },

  onDeleteDeck(deckId) {
    deleteDeckFromLibrary(deckId);
    // If deleting the active deck, reset to new
    if (deckId === state.deckId) {
      handlers.onNewDeck();
    } else {
      dirtyKeys.add('_decksLibrary');
      scheduleRender();
    }
    ui.showToast('Deck deleted');
  },

  onDuplicateDeck(deckId) {
    const newId = duplicateDeck(deckId);
    if (newId) {
      dirtyKeys.add('_decksLibrary');
      scheduleRender();
      ui.showToast('Deck duplicated');
    }
  },

  onRenameDeck(deckId, name) {
    renameDeck(deckId, name);
    // If renaming the active deck, update working state too
    if (deckId === state.deckId) {
      state = { ...state, deckName: name };
      saveState(state);
    }
    dirtyKeys.add('_decksLibrary');
    dirtyKeys.add('deckName');
    scheduleRender();
  },
};

// ============================================================
// RENDERING
// ============================================================

/**
 * Render all panels based on current state.
 */
function renderActual(scrollToRestore) {
  // Snapshot and clear dirty keys; empty set = full render (init path)
  const dirty = dirtyKeys;
  dirtyKeys = new Set();
  const fullRender = dirty.size === 0;

  // Badges and summaries always update (cheap, no innerHTML churn)
  const decks = loadDecks();
  updateBadge('mydecks', decks.length > 0 ? `${decks.length}` : '');
  updateBadge('deck', `${state.cards.length}/99`);
  updateBadge('considering', state.considering.length > 0 ? `${state.considering.length}` : '');
  updateBadge('dismissed', state.skippedRecommendations.length > 0 ? `${state.skippedRecommendations.length}` : '');
  updateBadge('recommendations', state.recommendationsResults.length > 0 ? `${state.recommendationsResults.length}` : '');
  updateBadge('cuts', state.cutsResults.length > 0 ? `${state.cutsResults.length}` : '');
  if (state.cards.length > 0) updateSummary('deck', `${state.cards.length}/99 cards`);
  ui.updateSettingsMenu(state);

  // Selective panel rendering — only rebuild panels whose data changed
  const needsMyDecks = fullRender || dirty.has('_decksLibrary') || dirty.has('deckId') || dirty.has('deckName');
  const needsDeck = fullRender || dirty.has('cards') || dirty.has('commander') || dirty.has('strategy');
  const needsConsidering = fullRender || dirty.has('considering');
  const needsDismissed = fullRender || dirty.has('skippedRecommendations');
  const needsRecs = fullRender || dirty.has('recommendationsResults') || dirty.has('_recsLoading')
    || dirty.has('_recsError') || dirty.has('_recsLoadingStatus') || dirty.has('recentPrompts')
    || dirty.has('strategy');
  const needsCuts = fullRender || dirty.has('cutsResults') || dirty.has('_cutsLoading') || dirty.has('_cutsError');
  const needsStats = fullRender || dirty.has('cards') || dirty.has('combos');

  if (needsMyDecks) ui.renderMyDecksPanel(state, decks, handlers);
  if (needsDeck) ui.renderDeckPanel(state, handlers);
  if (needsConsidering) ui.renderConsideringPanel(state, handlers);
  if (needsDismissed) ui.renderDismissedPanel(state, handlers);
  if (needsRecs) ui.renderRecommendationsPanel(state, handlers);
  if (needsCuts) ui.renderCutsPanel(state, handlers);
  if (needsStats) ui.renderStatsPanel(state);

  // Reinforced scroll restoration — sync + rAF to catch browser paint-phase adjustments
  if (scrollToRestore !== null) {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const target = Math.min(scrollToRestore, Math.max(0, maxScroll));
    window.scrollTo(0, target);
    requestAnimationFrame(() => window.scrollTo(0, target));
  }
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
    overlay.addEventListener('click', () => {
      ui.hideCardOverlay();
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
  renderActual(null);
}

// Boot the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
