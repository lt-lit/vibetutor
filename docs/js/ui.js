/**
 * ui.js — DOM manipulation and rendering
 * Renders panels and handles user interactions.
 */

import { searchCards, autocomplete, lookupCard, bulkLookup, parseDecklistText } from './scryfall.js';
import { exportPlain, exportMoxfield, exportArena } from './export.js';

/** Track which panels have been initialized to avoid re-rendering on every state change */
const initialized = new Set();

/** Debounce helper */
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ============================================================
// STRATEGY PANEL
// ============================================================

/**
 * Render the Strategy panel.
 * First call builds the DOM; subsequent calls update dynamic elements.
 */
export function renderStrategyPanel(state, handlers) {
  const el = document.getElementById('strategy-panel');
  if (!el) return;

  if (!initialized.has('strategy')) {
    initialized.add('strategy');
    buildStrategyPanel(el, state, handlers);
  }

  // Update dynamic elements
  updateStrategyDisplay(el, state);
}

function buildStrategyPanel(el, state, handlers) {
  el.innerHTML = `
    <div class="strategy-content">
      <div class="strategy-fields">
        <div class="field-group">
          <label class="field-label" for="strategy-notes">Strategy / Vibe</label>
          <textarea id="strategy-notes" class="input" rows="3"
                    placeholder="e.g., Political chaos, donate bad permanents, pillowfort"></textarea>
        </div>

        <div class="field-group">
          <label class="field-label">Power Level</label>
          <div class="segmented-control" id="power-level-control">
            <button data-level="casual">Casual</button>
            <button data-level="mid">Mid</button>
            <button data-level="high">High</button>
            <button data-level="cedh">cEDH</button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="budget-cap">Budget Cap ($ per card, optional)</label>
          <input type="number" id="budget-cap" class="input" min="0" step="0.5"
                 placeholder="No limit">
        </div>
      </div>
    </div>
  `;

  // Strategy notes
  el.querySelector('#strategy-notes').addEventListener('input', debounce((e) => {
    if (handlers.onStrategyUpdate) {
      handlers.onStrategyUpdate({ notes: e.target.value });
    }
  }, 500));

  // Power level
  el.querySelector('#power-level-control').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-level]');
    if (!btn) return;
    if (handlers.onStrategyUpdate) {
      handlers.onStrategyUpdate({ powerLevel: btn.dataset.level });
    }
  });

  // Budget cap
  el.querySelector('#budget-cap').addEventListener('input', debounce((e) => {
    const val = e.target.value ? parseFloat(e.target.value) : null;
    if (handlers.onStrategyUpdate) {
      handlers.onStrategyUpdate({ budgetCap: val });
    }
  }, 500));

}

function updateStrategyDisplay(el, state) {
  // Update strategy fields (only if not focused to avoid clobbering user input)
  const notesEl = el.querySelector('#strategy-notes');
  if (notesEl && document.activeElement !== notesEl) {
    notesEl.value = state.strategy.notes || '';
  }

  // Update power level buttons
  const powerBtns = el.querySelectorAll('#power-level-control button');
  powerBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === state.strategy.powerLevel);
  });

  // Update budget cap (only if not focused)
  const budgetEl = el.querySelector('#budget-cap');
  if (budgetEl && document.activeElement !== budgetEl) {
    budgetEl.value = state.strategy.budgetCap ?? '';
  }

}

// ============================================================
// SETTINGS MENU (gear icon dropdown)
// ============================================================

export function initSettingsMenu(handlers, state) {
  const toggle = document.getElementById('settings-toggle');
  const dropdown = document.getElementById('settings-dropdown');
  if (!toggle || !dropdown) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== toggle) {
      dropdown.hidden = true;
    }
  });

  // Model selector
  dropdown.querySelector('#settings-model').addEventListener('change', (e) => {
    if (handlers.onSettingsUpdate) {
      handlers.onSettingsUpdate({ model: e.target.value });
    }
  });

  // API key
  dropdown.querySelector('#settings-api-key').addEventListener('input', debounce((e) => {
    if (handlers.onApiKeyChange) {
      handlers.onApiKeyChange(e.target.value.trim());
    }
  }, 300));

  // Initial sync
  updateSettingsMenu(state);
}

export function updateSettingsMenu(state) {
  const modelEl = document.getElementById('settings-model');
  if (modelEl) modelEl.value = state.settings.model;

  const keyEl = document.getElementById('settings-api-key');
  if (keyEl && document.activeElement !== keyEl) {
    keyEl.value = localStorage.getItem('vibetutor_api_key') || '';
  }

  const counterEl = document.getElementById('settings-iteration-counter');
  if (counterEl) counterEl.textContent = `Suggestions used: ${state.iterationCount}`;
}

// ============================================================
// DECK PANEL
// ============================================================

/** Deck panel view preferences (persisted to localStorage) */
const VIEW_PREFS_KEY = 'vibetutor_view_prefs';

function loadViewPrefs() {
  try {
    const saved = localStorage.getItem(VIEW_PREFS_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
}

function saveViewPrefs() {
  localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify({
    viewMode: deckViewMode,
    grouping: deckGrouping,
    sorting: deckSorting,
    twoCols: mobileDoubleColumn,
  }));
}

const prefs = loadViewPrefs();
let deckViewMode = prefs?.viewMode || 'stacks';
let deckGrouping = prefs?.grouping || 'tag';
let deckSorting = prefs?.sorting || 'cmc';
const collapsedGroups = new Set();

let mobileDoubleColumn = prefs?.twoCols ?? true;

/** Stored handlers reference for event delegation */
let _deckHandlers = null;
/** Stored state reference for event delegation */
let _deckState = null;

export function renderDeckPanel(state, handlers) {
  const el = document.getElementById('deck-panel');
  if (!el) return;

  _deckHandlers = handlers;
  _deckState = state;

  if (!initialized.has('deck')) {
    initialized.add('deck');
    buildDeckPanel(el, state, handlers);
  }

  updateDeckDisplay(el, state);
}

function buildDeckPanel(el, state, handlers) {
  el.innerHTML = `
    <div class="deck-content">
      <!-- Commander Search -->
      <div id="deck-commander" class="deck-commander-section">
        <div id="deck-commander-search" class="relative">
          <label class="field-label" for="deck-commander-input">Commander</label>
          <input type="text" id="deck-commander-input" class="input"
                 placeholder="Search for a commander..." autocomplete="off">
          <div id="deck-commander-dropdown" class="dropdown" hidden></div>
        </div>
        <div id="deck-commander-selected" hidden>
          <img id="deck-commander-image" class="commander-image card-image" src="" alt="">
          <button id="deck-commander-change" class="btn btn-sm mt-sm">Change Commander</button>
        </div>
      </div>

      <div class="deck-toolbar">
        <div class="deck-search-wrapper relative">
          <input type="text" id="deck-search" class="input" placeholder="Add a card..." autocomplete="off">
          <div id="deck-search-dropdown" class="dropdown" hidden></div>
        </div>
        <div class="deck-toolbar-actions">
          <div class="segmented-control deck-view-toggle" id="deck-view-toggle">
            <button data-view="stacks" class="${deckViewMode === 'stacks' ? 'active' : ''}">Stacks</button>
            <button data-view="grid" class="${deckViewMode === 'grid' ? 'active' : ''}">Grid</button>
          </div>
          <div class="segmented-control deck-grouping-toggle" id="deck-grouping-toggle">
            <button data-group="tag" class="${deckGrouping === 'tag' ? 'active' : ''}">Tag</button>
            <button data-group="type" class="${deckGrouping === 'type' ? 'active' : ''}">Type</button>
          </div>
          <div class="segmented-control deck-sorting-toggle" id="deck-sorting-toggle">
            <button data-sort="cmc" class="${deckSorting === 'cmc' ? 'active' : ''}">CMC</button>
            <button data-sort="az" class="${deckSorting === 'az' ? 'active' : ''}">A-Z</button>
          </div>
          <div class="segmented-control deck-cols-toggle deck-mobile-cols-btn" id="deck-cols-toggle">
            <button data-cols="1" class="${!mobileDoubleColumn ? 'active' : ''}">1-Col</button>
            <button data-cols="2" class="${mobileDoubleColumn ? 'active' : ''}">2-Col</button>
          </div>
          <button class="btn btn-sm" id="deck-import-btn">Import</button>
          <div class="relative">
            <button class="btn btn-sm" id="deck-export-btn">Export</button>
          </div>
          <button class="btn btn-sm btn-primary" id="deck-autotag-btn">Auto-Tag</button>
        </div>
      </div>

      <div id="deck-cards"></div>
    </div>
  `;

  // --- Commander search autocomplete ---
  const cmdSearchInput = el.querySelector('#deck-commander-input');
  const cmdDropdown = el.querySelector('#deck-commander-dropdown');

  const doCmdSearch = debounce(async (query) => {
    if (query.length < 2) { cmdDropdown.hidden = true; return; }
    const results = await searchCards(`is:commander ${query}`);
    if (results.length === 0) { cmdDropdown.hidden = true; return; }
    cmdDropdown.innerHTML = results.slice(0, 8).map((card, i) => `
      <div class="dropdown-item" data-index="${i}">
        ${card.imageUris.small ? `<img src="${card.imageUris.small}" alt="${card.name}" loading="lazy">` : ''}
        <span>${card.name}</span>
      </div>
    `).join('');
    cmdDropdown.hidden = false;
    cmdDropdown._results = results.slice(0, 8);
  }, 300);

  cmdSearchInput.addEventListener('input', (e) => doCmdSearch(e.target.value.trim()));
  cmdSearchInput.addEventListener('blur', () => setTimeout(() => { cmdDropdown.hidden = true; }, 200));

  cmdDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item || !cmdDropdown._results) return;
    const index = parseInt(item.dataset.index, 10);
    const card = cmdDropdown._results[index];
    if (card && handlers.onCommanderSelect) handlers.onCommanderSelect(card);
    cmdDropdown.hidden = true;
    cmdSearchInput.value = '';
  });

  el.querySelector('#deck-commander-change').addEventListener('click', () => {
    if (handlers.onCommanderChange) handlers.onCommanderChange();
  });

  // --- Card search autocomplete ---
  const searchInput = el.querySelector('#deck-search');
  const searchDropdown = el.querySelector('#deck-search-dropdown');

  const doCardSearch = debounce(async (query) => {
    if (query.length < 2) { searchDropdown.hidden = true; return; }
    const names = await autocomplete(query);
    if (names.length === 0) { searchDropdown.hidden = true; return; }
    searchDropdown.innerHTML = names.slice(0, 8).map(name =>
      `<div class="dropdown-item" data-name="${escapeAttr(name)}"><span>${escapeHtml(name)}</span></div>`
    ).join('');
    searchDropdown.hidden = false;
  }, 300);

  searchInput.addEventListener('input', (e) => doCardSearch(e.target.value.trim()));
  searchInput.addEventListener('blur', () => setTimeout(() => { searchDropdown.hidden = true; }, 200));

  searchDropdown.addEventListener('click', async (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    const name = item.dataset.name;
    searchDropdown.hidden = true;
    searchInput.value = '';
    const card = await lookupCard(name);
    if (card && handlers.onAddCard) handlers.onAddCard(card);
  });

  // --- View toggle ---
  el.querySelector('#deck-view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    deckViewMode = btn.dataset.view;
    saveViewPrefs();
    el.querySelectorAll('#deck-view-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.view === deckViewMode));
    updateDeckDisplay(el, _deckState);
    // Also update considering and dismissed panels with same view mode
    const consideringEl = document.getElementById('considering-panel');
    if (consideringEl && _consideringState) updateConsideringDisplay(consideringEl, _consideringState);
    const dismissedEl = document.getElementById('dismissed-panel');
    if (dismissedEl && _dismissedState) updateDismissedDisplay(dismissedEl, _dismissedState);
  });

  // --- Grouping toggle ---
  el.querySelector('#deck-grouping-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-group]');
    if (!btn) return;
    deckGrouping = btn.dataset.group;
    saveViewPrefs();
    el.querySelectorAll('#deck-grouping-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.group === deckGrouping));
    collapsedGroups.clear();
    consideringCollapsedGroups.clear();
    dismissedCollapsedGroups.clear();
    updateDeckDisplay(el, _deckState);
    // Also update considering and dismissed panels with same grouping
    const consideringEl = document.getElementById('considering-panel');
    if (consideringEl && _consideringState) updateConsideringDisplay(consideringEl, _consideringState);
    const dismissedEl = document.getElementById('dismissed-panel');
    if (dismissedEl && _dismissedState) updateDismissedDisplay(dismissedEl, _dismissedState);
  });

  // --- Sorting toggle ---
  el.querySelector('#deck-sorting-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    deckSorting = btn.dataset.sort;
    saveViewPrefs();
    el.querySelectorAll('#deck-sorting-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.sort === deckSorting));
    updateDeckDisplay(el, _deckState);
    const consideringEl = document.getElementById('considering-panel');
    if (consideringEl && _consideringState) updateConsideringDisplay(consideringEl, _consideringState);
    const dismissedEl = document.getElementById('dismissed-panel');
    if (dismissedEl && _dismissedState) updateDismissedDisplay(dismissedEl, _dismissedState);
  });

  // --- Import ---
  el.querySelector('#deck-import-btn').addEventListener('click', () => {
    showImportModal(handlers);
  });

  // --- Export ---
  el.querySelector('#deck-export-btn').addEventListener('click', (e) => {
    showExportDropdown(e.target.closest('.relative'), _deckState);
  });

  // --- Auto-Tag ---
  el.querySelector('#deck-autotag-btn').addEventListener('click', async () => {
    if (handlers.onAutoTag) {
      const btn = el.querySelector('#deck-autotag-btn');
      btn.disabled = true;
      btn.textContent = 'Tagging...';
      await handlers.onAutoTag();
      btn.disabled = false;
      btn.textContent = 'Auto-Tag';
    }
  });

  // --- Mobile column toggle ---
  el.querySelector('#deck-cols-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cols]');
    if (!btn) return;
    mobileDoubleColumn = btn.dataset.cols === '2';
    saveViewPrefs();
    el.querySelectorAll('#deck-cols-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.cols === btn.dataset.cols));
    const cardsEl = el.querySelector('#deck-cards');
    cardsEl.classList.toggle('mobile-two-col', mobileDoubleColumn);
    // Also update considering and dismissed panels
    const consideringEl = document.getElementById('considering-panel');
    if (consideringEl && _consideringState) updateConsideringDisplay(consideringEl, _consideringState);
    const dismissedEl = document.getElementById('dismissed-panel');
    if (dismissedEl && _dismissedState) updateDismissedDisplay(dismissedEl, _dismissedState);
  });

  // --- Event delegation on cards container ---
  el.querySelector('#deck-cards').addEventListener('click', (e) => {
    // Stack header collapse/expand
    const stackHeader = e.target.closest('.card-stack-header');
    if (stackHeader) {
      const group = stackHeader.dataset.group;
      const items = stackHeader.nextElementSibling;
      const arrow = stackHeader.querySelector('.section-arrow');
      if (collapsedGroups.has(group)) {
        collapsedGroups.delete(group);
        items.hidden = false;
        arrow.textContent = '\u25BC';
      } else {
        collapsedGroups.add(group);
        items.hidden = true;
        arrow.textContent = '\u25B6';
      }
      return;
    }

    // Card options menu
    const optionsBtn = e.target.closest('.card-options-btn');
    if (optionsBtn) {
      e.stopPropagation();
      const cardName = optionsBtn.dataset.card;
      if (cardName) openCardOptionsMenu(optionsBtn, cardName);
      return;
    }

    // Card image click — inline expand (stacks) or full overlay (grid)
    const cardItem = e.target.closest('.card-stack-item, .deck-grid-item');
    if (cardItem) {
      if (cardItem.classList.contains('card-stack-item')) {
        const wasExpanded = cardItem.classList.contains('expanded');
        if (wasExpanded) {
          const img = cardItem.querySelector('img');
          if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
        } else {
          el.querySelectorAll('.card-stack-item.expanded').forEach(c => c.classList.remove('expanded'));
          cardItem.classList.add('expanded');
        }
      } else {
        const img = cardItem.querySelector('img');
        if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
      }
    }
  });
}

function updateDeckDisplay(el, state) {
  // Update commander search/display toggle
  const cmdSearch = el.querySelector('#deck-commander-search');
  const cmdSelected = el.querySelector('#deck-commander-selected');
  const cmdImage = el.querySelector('#deck-commander-image');

  if (cmdSearch && cmdSelected) {
    if (state.commander) {
      cmdSearch.hidden = true;
      cmdSelected.hidden = false;
      cmdImage.src = state.commander.imageUris?.normal || '';
      cmdImage.alt = state.commander.name;
    } else {
      cmdSearch.hidden = false;
      cmdSelected.hidden = true;
    }
  }

  // Update cards display
  const cardsEl = el.querySelector('#deck-cards');
  if (!cardsEl) return;

  if (state.cards.length === 0) {
    cardsEl.innerHTML = '<div class="empty-state">Add cards using the search above, or import a decklist</div>';
    return;
  }

  const groups = groupCards(state.cards, deckGrouping);

  if (deckViewMode === 'stacks') {
    cardsEl.innerHTML = groups.map(g => renderStackGroup(g)).join('');
  } else {
    cardsEl.innerHTML = groups.map(g => renderGridGroup(g)).join('');
  }

  // Re-apply mobile 2-column class if active
  if (mobileDoubleColumn) {
    cardsEl.classList.add('mobile-two-col');
  }
}

function renderStackGroup({ label, cards }, options = {}) {
  const isCollapsed = (options.collapsedSet || collapsedGroups).has(label);
  const arrow = isCollapsed ? '\u25B6' : '\u25BC';
  return `
    <div class="card-stack" data-group="${escapeAttr(label)}">
      <div class="card-stack-header" data-group="${escapeAttr(label)}">
        <span class="section-arrow">${arrow}</span>
        <span>${escapeHtml(label)}</span>
        <span class="stack-count">(${cards.length})</span>
      </div>
      <div class="card-stack-items" ${isCollapsed ? 'hidden' : ''}>
        ${cards.map(c => {
          const imgUrl = c.scryfallData?.imageUris?.normal || '';
          return `
            <div class="card-stack-item" data-card="${escapeAttr(c.name)}">
              <img src="${imgUrl}" alt="${escapeAttr(c.name)}" loading="lazy">
              <div class="stack-item-overlay">
                <button class="card-options-btn" data-card="${escapeAttr(c.name)}">&#8942;</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function renderGridGroup({ label, cards }, options = {}) {
  const isCollapsed = (options.collapsedSet || collapsedGroups).has(label);
  const arrow = isCollapsed ? '\u25B6' : '\u25BC';
  return `
    <div class="card-stack" data-group="${escapeAttr(label)}">
      <div class="card-stack-header" data-group="${escapeAttr(label)}">
        <span class="section-arrow">${arrow}</span>
        <span>${escapeHtml(label)}</span>
        <span class="stack-count">(${cards.length})</span>
      </div>
      <div class="card-grid" ${isCollapsed ? 'hidden' : ''}>
        ${cards.map(c => {
          const imgUrl = c.scryfallData?.imageUris?.normal || '';
          return `
            <div class="deck-grid-item" data-card="${escapeAttr(c.name)}">
              <img src="${imgUrl}" alt="${escapeAttr(c.name)}" loading="lazy">
              <div class="grid-item-overlay">
                <button class="card-options-btn" data-card="${escapeAttr(c.name)}">&#8942;</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ============================================================
// GROUPING HELPER
// ============================================================

const TYPE_ORDER = ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Land', 'Other'];

function sortCards(cards, sorting) {
  return [...cards].sort((a, b) => {
    if (sorting === 'az') return a.name.localeCompare(b.name);
    return (a.scryfallData?.cmc ?? 0) - (b.scryfallData?.cmc ?? 0);
  });
}

function groupCards(cards, grouping) {
  const groups = new Map();

  for (const card of cards) {
    let key;
    switch (grouping) {
      case 'type':
        key = extractPrimaryType(card.scryfallData?.typeLine || '');
        break;
      case 'tag':
      default:
        key = card.tag || 'Untagged';
        break;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }

  // Sort groups
  let sortedKeys;
  switch (grouping) {
    case 'type':
      sortedKeys = TYPE_ORDER.filter(t => groups.has(t));
      break;
    case 'tag':
    default:
      sortedKeys = [...groups.keys()].sort((a, b) => {
        if (a === 'Untagged') return 1;
        if (b === 'Untagged') return -1;
        return a.localeCompare(b);
      });
      break;
  }

  return sortedKeys.map(key => ({
    label: key,
    cards: sortCards(groups.get(key), deckSorting),
  }));
}

function extractPrimaryType(typeLine) {
  const lower = typeLine.toLowerCase();
  if (lower.includes('creature')) return 'Creature';
  if (lower.includes('instant')) return 'Instant';
  if (lower.includes('sorcery')) return 'Sorcery';
  if (lower.includes('enchantment')) return 'Enchantment';
  if (lower.includes('artifact')) return 'Artifact';
  if (lower.includes('planeswalker')) return 'Planeswalker';
  if (lower.includes('land')) return 'Land';
  return 'Other';
}

// ============================================================
// TAG EDITOR
// ============================================================

function openTagEditor(anchorEl, cardName, state, handlers) {
  // Remove any existing tag editor
  document.querySelectorAll('.tag-editor').forEach(e => e.remove());

  const allCards = [...(state.cards || []), ...(state.considering || []), ...(state.skippedRecommendations || [])];
  const existingTags = [...new Set(allCards.map(c => c.tag).filter(Boolean))].sort();
  const currentTag = allCards.find(c => c.name === cardName)?.tag;

  const editor = document.createElement('div');
  editor.className = 'tag-editor';
  editor.innerHTML = `
    ${existingTags.map(tag =>
      `<div class="tag-editor-item ${tag === currentTag ? 'active' : ''}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</div>`
    ).join('')}
    <div class="tag-editor-item" data-tag="">untagged</div>
    <div class="tag-editor-input">
      <input type="text" placeholder="New tag..." autocomplete="off">
    </div>
  `;

  // Position relative to anchor
  anchorEl.style.position = 'relative';
  anchorEl.appendChild(editor);

  // Handle tag selection
  editor.addEventListener('click', (e) => {
    const item = e.target.closest('.tag-editor-item');
    if (!item) return;
    const newTag = item.dataset.tag || null;
    if (handlers.onTagChange) handlers.onTagChange(cardName, newTag);
    editor.remove();
  });

  // Handle new tag input
  const input = editor.querySelector('input');
  input.focus({ preventScroll: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      const newTag = input.value.trim().toLowerCase();
      if (handlers.onTagChange) handlers.onTagChange(cardName, newTag);
      editor.remove();
    }
    if (e.key === 'Escape') editor.remove();
  });

  // Close on click outside
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!editor.contains(e.target)) {
        editor.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 0);
}

// ============================================================
// CARD OPTIONS MENU
// ============================================================

function openCardOptionsMenu(anchorEl, cardName) {
  // Remove any existing options menu
  document.querySelectorAll('.card-options-menu').forEach(e => e.remove());

  const menu = document.createElement('div');
  menu.className = 'card-options-menu';
  menu.innerHTML = `
    <div class="card-options-item" data-action="remove">Remove from deck</div>
    <div class="card-options-item" data-action="considering">Move to Considering</div>
    <div class="card-options-item" data-action="tags">Manage Tags</div>
  `;

  // Position using fixed positioning relative to the button
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 120}px`;
  document.body.appendChild(menu);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.left < 8) menu.style.left = '8px';
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = `${rect.top - menuRect.height - 4}px`;
    }
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.card-options-item');
    if (!item) return;
    const action = item.dataset.action;
    if (action === 'remove') {
      if (_deckHandlers.onRemoveCard) _deckHandlers.onRemoveCard(cardName);
    } else if (action === 'considering') {
      if (_deckHandlers.onMoveToConsidering) _deckHandlers.onMoveToConsidering(cardName);
    } else if (action === 'tags') {
      openTagEditor(anchorEl, cardName, _deckState, _deckHandlers);
    }
    menu.remove();
  });

  // Close on outside click
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 0);
}

// ============================================================
// CONSIDERING OPTIONS MENU
// ============================================================

function openConsideringOptionsMenu(anchorEl, cardName) {
  document.querySelectorAll('.card-options-menu').forEach(e => e.remove());

  const card = _consideringState?.considering.find(c => c.name === cardName);
  if (!card) return;

  const menuItems = card.inDeck
    ? `<div class="card-options-item" data-action="cut">Cut from Deck</div>
       <div class="card-options-item" data-action="keep">Keep in Deck</div>
       <div class="card-options-item" data-action="tags">Manage Tags</div>`
    : `<div class="card-options-item" data-action="add">Add to Deck</div>
       <div class="card-options-item" data-action="dismiss">Dismiss</div>
       <div class="card-options-item" data-action="tags">Manage Tags</div>`;

  const menu = document.createElement('div');
  menu.className = 'card-options-menu';
  menu.innerHTML = menuItems;

  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 120}px`;
  document.body.appendChild(menu);

  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.left < 8) menu.style.left = '8px';
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = `${rect.top - menuRect.height - 4}px`;
    }
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.card-options-item');
    if (!item) return;
    const action = item.dataset.action;
    if (action === 'add') _consideringHandlers?.onAddFromConsidering?.(cardName);
    if (action === 'dismiss') _consideringHandlers?.onDismissConsidering?.(cardName);
    if (action === 'cut') _consideringHandlers?.onCutFromConsidering?.(cardName);
    if (action === 'keep') _consideringHandlers?.onKeepFromConsidering?.(cardName);
    if (action === 'tags') {
      openTagEditor(anchorEl, cardName, _consideringState, _consideringHandlers);
    }
    menu.remove();
  });

  setTimeout(() => {
    const closeHandler = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 0);
}

// ============================================================
// IMPORT MODAL
// ============================================================

function showImportModal(handlers) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>Import Decklist</h2>
      <textarea class="input" id="import-textarea" rows="10"
                placeholder="Paste your decklist here...&#10;&#10;Supported formats:&#10;1 Sol Ring&#10;1x Lightning Greaves&#10;Card Name&#10;1 Card Name (SET) 123"></textarea>
      <div id="import-results" class="import-results" hidden></div>
      <div class="action-buttons mt-md">
        <button class="btn" id="import-cancel">Cancel</button>
        <button class="btn btn-primary" id="import-submit">Import</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  // Cancel
  backdrop.querySelector('#import-cancel').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  // Submit
  backdrop.querySelector('#import-submit').addEventListener('click', async () => {
    const textarea = backdrop.querySelector('#import-textarea');
    const text = textarea.value.trim();
    if (!text) return;

    const resultsEl = backdrop.querySelector('#import-results');
    const submitBtn = backdrop.querySelector('#import-submit');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing...';
    resultsEl.hidden = false;
    resultsEl.innerHTML = '<div class="import-loading">Looking up cards...</div>';

    const entries = parseDecklistText(text);
    const names = entries.map(e => e.name);
    const found = await bulkLookup(names);
    const foundNames = new Set(found.map(c => c.name));
    const notFound = names.filter(n => !foundNames.has(n));

    if (found.length > 0 && handlers.onImportCards) {
      handlers.onImportCards(found);
    }

    if (notFound.length > 0) {
      resultsEl.innerHTML = `
        <div class="import-found">Added ${found.length} cards</div>
        <div class="import-missing">
          ${notFound.length} not found:
          <ul>${notFound.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
        </div>
      `;
      submitBtn.textContent = 'Done';
      submitBtn.disabled = false;
      submitBtn.addEventListener('click', () => backdrop.remove(), { once: true });
    } else {
      showToast(`Imported ${found.length} cards`);
      backdrop.remove();
    }
  });
}

// ============================================================
// EXPORT DROPDOWN
// ============================================================

function showExportDropdown(anchorEl, state) {
  // Remove existing
  document.querySelectorAll('.export-dropdown').forEach(e => e.remove());

  const dropdown = document.createElement('div');
  dropdown.className = 'export-dropdown';
  dropdown.innerHTML = `
    <div class="export-dropdown-item" data-format="moxfield">Moxfield</div>
    <div class="export-dropdown-item" data-format="plain">Plain</div>
    <div class="export-dropdown-item" data-format="arena">Arena</div>
  `;
  anchorEl.appendChild(dropdown);

  dropdown.addEventListener('click', async (e) => {
    const item = e.target.closest('.export-dropdown-item');
    if (!item) return;
    const format = item.dataset.format;
    let text;
    switch (format) {
      case 'moxfield': text = exportMoxfield(state); break;
      case 'arena': text = exportArena(state); break;
      default: text = exportPlain(state);
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard!');
    } catch {
      showToast('Copy failed — check browser permissions');
    }
    dropdown.remove();
  });

  // Close on click outside
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== anchorEl.querySelector('#deck-export-btn')) {
        dropdown.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 0);
}

// ============================================================
// HTML ESCAPE HELPERS
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

// ============================================================
// RECOMMENDATIONS PANEL
// ============================================================

/** Stored handlers/state for recommendations event delegation */
let _recsHandlers = null;
let _recsState = null;

export function renderRecommendationsPanel(state, handlers) {
  const el = document.getElementById('recommendations-panel');
  if (!el) return;

  _recsHandlers = handlers;
  _recsState = state;

  if (!initialized.has('recommendations')) {
    initialized.add('recommendations');
    buildRecommendationsPanel(el, state, handlers);
  }

  updateRecommendationsDisplay(el, state);
}

function buildRecommendationsPanel(el, state, handlers) {
  el.innerHTML = `
    <div class="recs-content">
      <div class="recs-input-area">
        <div class="flex gap-sm">
          <input type="text" id="recs-prompt" class="input" style="flex:1"
                 placeholder="What are you looking for? (leave blank for smart suggestions)"
                 autocomplete="off">
          <button class="btn btn-primary" id="recs-suggest-btn">Suggest</button>
        </div>
        <p class="field-hint mt-sm" id="recs-hint">Try: removal, wheel effects, budget ramp under $2, the saltiest cards available</p>
        <div id="recs-recent-prompts" class="mt-sm"></div>
      </div>
      <div id="recs-results"></div>
    </div>
  `;

  // Suggest button
  el.querySelector('#recs-suggest-btn').addEventListener('click', () => {
    const prompt = el.querySelector('#recs-prompt').value.trim();
    if (handlers.onSuggestRecommendations) handlers.onSuggestRecommendations(prompt);
  });

  // Enter key on prompt
  el.querySelector('#recs-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const prompt = e.target.value.trim();
      if (handlers.onSuggestRecommendations) handlers.onSuggestRecommendations(prompt);
    }
  });

  // Recent prompts
  el.querySelector('#recs-recent-prompts').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    el.querySelector('#recs-prompt').value = pill.dataset.prompt;
    if (handlers.onSuggestRecommendations) handlers.onSuggestRecommendations(pill.dataset.prompt);
  });

  // Event delegation on results
  el.querySelector('#recs-results').addEventListener('click', (e) => {
    // Card image click — fullscreen overlay
    const recCard = e.target.closest('.rec-card');
    if (recCard && e.target.tagName === 'IMG') {
      showCardOverlay(e.target.src, recCard.dataset.card);
      return;
    }

    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const cardName = btn.dataset.card;
    const action = btn.dataset.action;
    if (action === 'add' && _recsHandlers.onAddRecommendation) _recsHandlers.onAddRecommendation(cardName);
    if (action === 'consider' && _recsHandlers.onConsiderRecommendation) _recsHandlers.onConsiderRecommendation(cardName);
    if (action === 'skip' && _recsHandlers.onSkipRecommendation) _recsHandlers.onSkipRecommendation(cardName);
  });

}

function updateRecommendationsDisplay(el, state) {
  // Recent prompts
  const recentEl = el.querySelector('#recs-recent-prompts');
  if (recentEl && state.recentPrompts.length > 0) {
    recentEl.innerHTML = state.recentPrompts.map(p =>
      `<span class="pill" data-prompt="${escapeAttr(p)}">${escapeHtml(p)}</span>`
    ).join(' ');
  }

  // Results
  const resultsEl = el.querySelector('#recs-results');
  const suggestBtn = el.querySelector('#recs-suggest-btn');

  if (state._recsLoading) {
    suggestBtn.disabled = true;
    suggestBtn.textContent = 'Searching...';
    resultsEl.innerHTML = `
      <div class="loading-status">${escapeHtml(state._recsLoadingStatus || 'Analyzing deck...')}</div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    `;
    return;
  }

  suggestBtn.disabled = false;
  suggestBtn.textContent = state.recommendationsResults.length > 0 ? 'Suggest More' : 'Suggest';

  if (state._recsError) {
    resultsEl.innerHTML = `<div class="error-state">${escapeHtml(state._recsError)}</div>`;
    return;
  }

  if (state.recommendationsResults.length === 0) {
    resultsEl.innerHTML = '';
    return;
  }

  resultsEl.innerHTML = state.recommendationsResults.map(rec => {
    const imgUrl = rec.scryfallData?.imageUris?.normal || '';
    const sourceBadges = (rec.sources || []).map(s => {
      const labels = { scryfall: 'S', edhrec: 'E', spellbook: 'C' };
      const classes = { scryfall: 'source-scryfall', edhrec: 'source-edhrec', spellbook: 'source-spellbook' };
      return `<span class="source-badge ${classes[s] || ''}">${labels[s] || s}</span>`;
    }).join('');

    let metaInfo = '';
    if (rec.edhrecSynergy != null) metaInfo += `<span class="field-hint">Synergy: ${(rec.edhrecSynergy * 100).toFixed(0)}%</span> `;
    if (rec.combosUnlocked?.length > 0) {
      metaInfo += `<div class="combo-alert">Completes combo with: ${rec.combosUnlocked.join(', ')}</div>`;
    }

    return `
      <div class="rec-card" data-card="${escapeAttr(rec.name)}">
        ${imgUrl ? `<img class="card-image" src="${imgUrl}" alt="${escapeAttr(rec.name)}" loading="lazy">` : ''}
        <div class="rec-card-info">
          <div class="flex gap-sm" style="align-items:center;flex-wrap:wrap">
            <span class="tag-badge">${escapeHtml(rec.tag || 'untagged')}</span>
            ${sourceBadges}
          </div>
          <p class="rec-pitch">${escapeHtml(rec.pitch || '')}</p>
          ${metaInfo}
        </div>
        <div class="action-buttons">
          <button class="btn btn-sm btn-danger" data-action="skip" data-card="${escapeAttr(rec.name)}">Dismiss</button>
          <button class="btn btn-sm btn-warning" data-action="consider" data-card="${escapeAttr(rec.name)}">Consider</button>
          <button class="btn btn-sm btn-success" data-action="add" data-card="${escapeAttr(rec.name)}">Add</button>
        </div>
      </div>`;
  }).join('');

}

// ============================================================
// CUTS PANEL
// ============================================================

let _cutsHandlers = null;
let _cutsState = null;

export function renderCutsPanel(state, handlers) {
  const el = document.getElementById('cuts-panel');
  if (!el) return;

  _cutsHandlers = handlers;
  _cutsState = state;

  if (!initialized.has('cuts')) {
    initialized.add('cuts');
    buildCutsPanel(el, state, handlers);
  }

  updateCutsDisplay(el, state);
}

function buildCutsPanel(el, state, handlers) {
  el.innerHTML = `
    <div class="cuts-content">
      <div class="text-center mb-md">
        <button class="btn btn-primary" id="cuts-suggest-btn">Suggest Cuts</button>
      </div>
      <div id="cuts-results"></div>
    </div>
  `;

  el.querySelector('#cuts-suggest-btn').addEventListener('click', () => {
    if (handlers.onSuggestCuts) handlers.onSuggestCuts();
  });

  el.querySelector('#cuts-results').addEventListener('click', (e) => {
    // Card image click — fullscreen overlay
    const recCard = e.target.closest('.rec-card');
    if (recCard && e.target.tagName === 'IMG') {
      showCardOverlay(e.target.src, recCard.dataset.card);
      return;
    }

    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const cardName = btn.dataset.card;
    const action = btn.dataset.action;
    if (action === 'cut' && _cutsHandlers.onCutCard) _cutsHandlers.onCutCard(cardName);
    if (action === 'consider' && _cutsHandlers.onConsiderCut) _cutsHandlers.onConsiderCut(cardName);
    if (action === 'keep' && _cutsHandlers.onKeepCard) _cutsHandlers.onKeepCard(cardName);
  });
}

function updateCutsDisplay(el, state) {
  const resultsEl = el.querySelector('#cuts-results');
  const suggestBtn = el.querySelector('#cuts-suggest-btn');

  if (state._cutsLoading) {
    suggestBtn.disabled = true;
    suggestBtn.textContent = 'Analyzing...';
    resultsEl.innerHTML = `
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    `;
    return;
  }

  suggestBtn.disabled = false;
  suggestBtn.textContent = state.cutsResults.length > 0 ? 'Suggest More Cuts' : 'Suggest Cuts';

  if (state._cutsError) {
    resultsEl.innerHTML = `<div class="empty-state">${escapeHtml(state._cutsError)}</div>`;
    return;
  }

  if (state.cutsResults.length === 0) {
    resultsEl.innerHTML = '';
    return;
  }

  resultsEl.innerHTML = state.cutsResults.map(cut => {
    const imgUrl = cut.scryfallData?.imageUris?.normal || '';
    let metaInfo = '';
    if (cut.edhrecInclusion != null) {
      metaInfo = `<span class="field-hint">In ${(cut.edhrecInclusion * 100).toFixed(0)}% of decks</span>`;
    }

    return `
      <div class="rec-card" data-card="${escapeAttr(cut.name)}">
        ${imgUrl ? `<img class="card-image" src="${imgUrl}" alt="${escapeAttr(cut.name)}" loading="lazy">` : ''}
        <div class="rec-card-info">
          <p class="rec-pitch">${escapeHtml(cut.reason || '')}</p>
          ${metaInfo}
        </div>
        <div class="action-buttons">
          <button class="btn btn-sm btn-danger" data-action="cut" data-card="${escapeAttr(cut.name)}">Cut</button>
          <button class="btn btn-sm btn-warning" data-action="consider" data-card="${escapeAttr(cut.name)}">Consider</button>
          <button class="btn btn-sm" data-action="keep" data-card="${escapeAttr(cut.name)}">Keep</button>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// CONSIDERING PANEL
// ============================================================

let _consideringHandlers = null;
let _consideringState = null;
const consideringCollapsedGroups = new Set();

export function renderConsideringPanel(state, handlers) {
  const el = document.getElementById('considering-panel');
  if (!el) return;

  _consideringHandlers = handlers;
  _consideringState = state;

  if (!initialized.has('considering')) {
    initialized.add('considering');
    buildConsideringPanel(el, state, handlers);
  }

  updateConsideringDisplay(el, state);
}

function buildConsideringPanel(el, state, handlers) {
  el.innerHTML = `
    <div class="considering-content">
      <div id="considering-cards"></div>
    </div>
  `;

  // Event delegation on cards container
  el.querySelector('#considering-cards').addEventListener('click', (e) => {
    // Stack header collapse/expand
    const stackHeader = e.target.closest('.card-stack-header');
    if (stackHeader) {
      const group = stackHeader.dataset.group;
      const items = stackHeader.nextElementSibling;
      const arrow = stackHeader.querySelector('.section-arrow');
      if (consideringCollapsedGroups.has(group)) {
        consideringCollapsedGroups.delete(group);
        items.hidden = false;
        arrow.textContent = '\u25BC';
      } else {
        consideringCollapsedGroups.add(group);
        items.hidden = true;
        arrow.textContent = '\u25B6';
      }
      return;
    }

    // Card options menu (considering-specific)
    const optionsBtn = e.target.closest('.card-options-btn');
    if (optionsBtn) {
      e.stopPropagation();
      const cardName = optionsBtn.dataset.card;
      if (cardName) openConsideringOptionsMenu(optionsBtn, cardName);
      return;
    }

    // Card image click — inline expand (stacks) or full overlay (grid)
    const cardItem = e.target.closest('.card-stack-item, .deck-grid-item');
    if (cardItem) {
      if (cardItem.classList.contains('card-stack-item')) {
        const wasExpanded = cardItem.classList.contains('expanded');
        if (wasExpanded) {
          const img = cardItem.querySelector('img');
          if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
        } else {
          el.querySelectorAll('.card-stack-item.expanded').forEach(c => c.classList.remove('expanded'));
          cardItem.classList.add('expanded');
        }
      } else {
        const img = cardItem.querySelector('img');
        if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
      }
    }
  });
}

function updateConsideringDisplay(el, state) {
  const cardsEl = el.querySelector('#considering-cards');
  if (!cardsEl) return;

  if (state.considering.length === 0) {
    cardsEl.innerHTML = '<div class="empty-state">Cards you\'re thinking about will appear here</div>';
    return;
  }

  const renderOpts = { collapsedSet: consideringCollapsedGroups };
  const groups = groupCards(state.considering, deckGrouping);

  if (deckViewMode === 'stacks') {
    cardsEl.innerHTML = groups.map(g => renderStackGroup(g, renderOpts)).join('');
  } else {
    cardsEl.innerHTML = groups.map(g => renderGridGroup(g, renderOpts)).join('');
  }

  if (mobileDoubleColumn) {
    cardsEl.classList.add('mobile-two-col');
  } else {
    cardsEl.classList.remove('mobile-two-col');
  }
}

// ============================================================
// DISMISSED PANEL
// ============================================================

let _dismissedHandlers = null;
let _dismissedState = null;
const dismissedCollapsedGroups = new Set();

export function renderDismissedPanel(state, handlers) {
  const el = document.getElementById('dismissed-panel');
  if (!el) return;

  _dismissedHandlers = handlers;
  _dismissedState = state;

  if (!initialized.has('dismissed')) {
    initialized.add('dismissed');
    buildDismissedPanel(el, state, handlers);
  }

  updateDismissedDisplay(el, state);
}

function buildDismissedPanel(el, state, handlers) {
  el.innerHTML = `
    <div class="dismissed-content">
      <div id="dismissed-cards"></div>
    </div>
  `;

  // Event delegation on cards container
  el.querySelector('#dismissed-cards').addEventListener('click', (e) => {
    // Stack header collapse/expand
    const stackHeader = e.target.closest('.card-stack-header');
    if (stackHeader) {
      const group = stackHeader.dataset.group;
      const items = stackHeader.nextElementSibling;
      const arrow = stackHeader.querySelector('.section-arrow');
      if (dismissedCollapsedGroups.has(group)) {
        dismissedCollapsedGroups.delete(group);
        items.hidden = false;
        arrow.textContent = '\u25BC';
      } else {
        dismissedCollapsedGroups.add(group);
        items.hidden = true;
        arrow.textContent = '\u25B6';
      }
      return;
    }

    // Card options menu
    const optionsBtn = e.target.closest('.card-options-btn');
    if (optionsBtn) {
      e.stopPropagation();
      const cardName = optionsBtn.dataset.card;
      if (cardName) openDismissedOptionsMenu(optionsBtn, cardName);
      return;
    }

    // Card image click — inline expand (stacks) or full overlay (grid)
    const cardItem = e.target.closest('.card-stack-item, .deck-grid-item');
    if (cardItem) {
      if (cardItem.classList.contains('card-stack-item')) {
        const wasExpanded = cardItem.classList.contains('expanded');
        if (wasExpanded) {
          const img = cardItem.querySelector('img');
          if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
        } else {
          el.querySelectorAll('.card-stack-item.expanded').forEach(c => c.classList.remove('expanded'));
          cardItem.classList.add('expanded');
        }
      } else {
        const img = cardItem.querySelector('img');
        if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
      }
    }
  });
}

function updateDismissedDisplay(el, state) {
  const cardsEl = el.querySelector('#dismissed-cards');
  if (!cardsEl) return;

  // Normalize: filter out any legacy string entries without scryfallData
  const dismissedCards = state.skippedRecommendations.filter(c => c && c.scryfallData);

  if (dismissedCards.length === 0) {
    cardsEl.innerHTML = '<div class="empty-state">Dismissed cards will appear here</div>';
    return;
  }

  const renderOpts = { collapsedSet: dismissedCollapsedGroups };
  const groups = groupCards(dismissedCards, deckGrouping);

  if (deckViewMode === 'stacks') {
    cardsEl.innerHTML = groups.map(g => renderStackGroup(g, renderOpts)).join('');
  } else {
    cardsEl.innerHTML = groups.map(g => renderGridGroup(g, renderOpts)).join('');
  }

  if (mobileDoubleColumn) {
    cardsEl.classList.add('mobile-two-col');
  } else {
    cardsEl.classList.remove('mobile-two-col');
  }
}

function openDismissedOptionsMenu(anchorEl, cardName) {
  document.querySelectorAll('.card-options-menu').forEach(e => e.remove());

  const card = _dismissedState?.skippedRecommendations.find(c => (c.name || c) === cardName);
  if (!card) return;

  const menuItems = `
    <div class="card-options-item" data-action="add">Add to Deck</div>
    <div class="card-options-item" data-action="consider">Move to Considering</div>
    <div class="card-options-item" data-action="remove">Remove</div>
    <div class="card-options-item" data-action="tags">Manage Tags</div>`;

  const menu = document.createElement('div');
  menu.className = 'card-options-menu';
  menu.innerHTML = menuItems;

  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 120}px`;
  document.body.appendChild(menu);

  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.left < 8) menu.style.left = '8px';
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = `${rect.top - menuRect.height - 4}px`;
    }
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.card-options-item');
    if (!item) return;
    const action = item.dataset.action;
    if (action === 'add') _dismissedHandlers?.onAddFromDismissed?.(cardName);
    if (action === 'consider') _dismissedHandlers?.onConsiderFromDismissed?.(cardName);
    if (action === 'remove') _dismissedHandlers?.onRemoveDismissed?.(cardName);
    if (action === 'tags') {
      openTagEditor(anchorEl, cardName, _dismissedState, _dismissedHandlers);
    }
    menu.remove();
  });

  setTimeout(() => {
    const closeHandler = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 0);
}

// ============================================================
// STATS PANEL
// ============================================================

const MTG_COLORS = {
  W: { name: 'White', color: '#f9faf4' },
  U: { name: 'Blue', color: '#0e68ab' },
  B: { name: 'Black', color: '#555555' },
  R: { name: 'Red', color: '#d3202a' },
  G: { name: 'Green', color: '#00733e' },
  C: { name: 'Colorless', color: '#9ca3a8' },
};

export function renderStatsPanel(state) {
  const el = document.getElementById('stats-panel');
  if (!el) return;

  // Stats panel always rebuilds since it's pure data display
  if (state.cards.length === 0) {
    el.innerHTML = '<div class="empty-state">Add cards to see stats</div>';
    return;
  }

  const cards = state.cards;
  const nonLands = cards.filter(c => !c.scryfallData?.typeLine?.toLowerCase().includes('land'));

  // --- Mana Curve ---
  const cmcBuckets = [0, 0, 0, 0, 0, 0, 0, 0]; // 0-7+
  for (const c of nonLands) {
    const cmc = Math.min(7, Math.floor(c.scryfallData?.cmc ?? 0));
    cmcBuckets[cmc]++;
  }
  const maxCmc = Math.max(1, ...cmcBuckets);

  // --- Color Pips ---
  const pipCounts = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of cards) {
    const cost = c.scryfallData?.manaCost || '';
    const pips = cost.match(/\{([WUBRGC])\}/gi) || [];
    for (const pip of pips) {
      const color = pip.replace(/[{}]/g, '').toUpperCase();
      if (pipCounts[color] !== undefined) pipCounts[color]++;
    }
  }
  const totalPips = Object.values(pipCounts).reduce((a, b) => a + b, 0);

  // --- Conic gradient for color pie ---
  let conicStops = '';
  if (totalPips > 0) {
    let cumulative = 0;
    const entries = Object.entries(pipCounts).filter(([, v]) => v > 0);
    conicStops = entries.map(([color, count], i) => {
      const start = cumulative;
      cumulative += (count / totalPips) * 360;
      return `${MTG_COLORS[color].color} ${start}deg ${cumulative}deg`;
    }).join(', ');
  }

  // --- Average CMC ---
  const avgCmc = nonLands.length > 0
    ? (nonLands.reduce((sum, c) => sum + (c.scryfallData?.cmc ?? 0), 0) / nonLands.length).toFixed(2)
    : '0.00';

  // --- Total Price ---
  const totalPrice = cards.reduce((sum, c) => {
    const price = parseFloat(c.scryfallData?.prices?.usd || '0');
    return sum + price;
  }, 0);

  // --- Type Breakdown ---
  const types = { Creature: 0, Instant: 0, Sorcery: 0, Enchantment: 0, Artifact: 0, Planeswalker: 0, Land: 0, Other: 0 };
  for (const c of cards) {
    const tl = (c.scryfallData?.typeLine || '').toLowerCase();
    if (tl.includes('creature')) types.Creature++;
    else if (tl.includes('instant')) types.Instant++;
    else if (tl.includes('sorcery')) types.Sorcery++;
    else if (tl.includes('enchantment')) types.Enchantment++;
    else if (tl.includes('artifact')) types.Artifact++;
    else if (tl.includes('planeswalker')) types.Planeswalker++;
    else if (tl.includes('land')) types.Land++;
    else types.Other++;
  }

  // --- Combos ---
  const combosHtml = renderCombosSection(state);

  // --- Bracket ---
  const bracketHtml = state.combos?.bracket != null
    ? `<div class="stat-bracket">Bracket: <strong>${state.combos.bracket}</strong></div>`
    : '';

  el.innerHTML = `
    <div class="stats-content">
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-value">${cards.length}/99</div>
          <div class="stat-label">Cards</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${avgCmc}</div>
          <div class="stat-label">Avg CMC</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">$${totalPrice.toFixed(0)}</div>
          <div class="stat-label">Est. Price</div>
        </div>
        ${bracketHtml ? `<div class="stat-box">${bracketHtml}</div>` : ''}
      </div>

      <div class="stats-section">
        <div class="field-label mb-sm">Mana Curve</div>
        <div class="mana-curve">
          ${cmcBuckets.map((count, i) => `
            <div class="mana-curve-bar">
              <span class="bar-count">${count || ''}</span>
              <div class="bar" style="height:${(count / maxCmc) * 100}%"></div>
              <span class="bar-label">${i === 7 ? '7+' : i}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="stats-section">
        <div class="field-label mb-sm">Color Distribution</div>
        <div class="stats-color-row">
          ${totalPips > 0
            ? `<div class="color-pie" style="background:conic-gradient(${conicStops})"></div>`
            : '<div class="empty-state" style="padding:8px">No colored pips</div>'}
          <div class="color-legend">
            ${Object.entries(pipCounts).filter(([, v]) => v > 0).map(([color, count]) => `
              <div class="color-legend-item">
                <span class="color-dot" style="background:${MTG_COLORS[color].color}"></span>
                <span>${MTG_COLORS[color].name}: ${count}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="stats-section">
        <div class="field-label mb-sm">Card Types</div>
        <div class="type-breakdown">
          ${Object.entries(types).filter(([, v]) => v > 0).map(([type, count]) => `
            <div class="type-row">
              <span>${type}</span>
              <span class="type-count">${count}</span>
              <div class="type-bar"><div class="type-bar-fill" style="width:${(count / cards.length) * 100}%"></div></div>
            </div>
          `).join('')}
        </div>
      </div>

      ${combosHtml}
    </div>
  `;
}

function renderCombosSection(state) {
  const combos = state.combos || {};
  const present = combos.present || [];
  const nearMiss = combos.nearMiss || [];

  if (present.length === 0 && nearMiss.length === 0) {
    return '';
  }

  let html = '<div class="stats-section">';
  html += '<div class="field-label mb-sm">Combos</div>';

  if (present.length > 0) {
    html += '<div class="combos-present mb-sm">';
    html += '<div class="field-hint mb-sm" style="font-weight:600;color:var(--accent-success)">In your deck:</div>';
    for (const combo of present) {
      html += `<div class="combo-item">
        <div class="combo-cards">${combo.cards.map(c => escapeHtml(c)).join(' + ')}</div>
        <div class="combo-desc">${escapeHtml(combo.description)}</div>
      </div>`;
    }
    html += '</div>';
  }

  if (nearMiss.length > 0) {
    html += '<div class="combos-near-miss">';
    html += '<div class="field-hint mb-sm" style="font-weight:600;color:var(--accent-warning)">1 card away:</div>';
    for (const combo of nearMiss.slice(0, 5)) {
      html += `<div class="combo-item">
        <div class="combo-cards">Add <strong>${escapeHtml(combo.missingCard)}</strong> to unlock: ${combo.cards.filter(c => c !== combo.missingCard).map(c => escapeHtml(c)).join(' + ')}</div>
        <div class="combo-desc">${escapeHtml(combo.description)}</div>
      </div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

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

// ============================================================
// CARD OVERLAY
// ============================================================

/**
 * Show the card overlay with a full-size image.
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

/**
 * Force a panel to re-initialize on next render.
 * Call this when the panel structure needs to be rebuilt.
 */
export function resetPanel(panelName) {
  initialized.delete(panelName);
}
