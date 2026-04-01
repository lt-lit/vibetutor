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
      <!-- Commander Search -->
      <div class="strategy-commander">
        <label class="field-label" for="commander-search">Commander</label>
        <div class="relative">
          <input type="text" id="commander-search" class="input"
                 placeholder="Search for a commander..."
                 autocomplete="off">
          <div id="commander-dropdown" class="dropdown" hidden></div>
        </div>
        <div id="commander-display" class="commander-display" hidden>
          <img id="commander-image" class="commander-image card-image" src="" alt="">
          <button id="commander-change" class="btn btn-sm mt-sm">Change Commander</button>
        </div>
      </div>

      <!-- Strategy Fields (shown after commander selected) -->
      <div id="strategy-fields" class="strategy-fields" hidden>
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

      <!-- Settings -->
      <div class="strategy-settings mt-md">
        <div class="settings-header field-label">Settings</div>

        <div class="field-group">
          <label class="field-label" for="model-select">LLM Model</label>
          <select id="model-select" class="input">
            <option value="anthropic/claude-sonnet-4">Claude Sonnet 4</option>
            <option value="anthropic/claude-haiku-4">Claude Haiku 4</option>
            <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
            <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
            <option value="openai/gpt-4o">GPT-4o</option>
          </select>
        </div>

        <div class="field-group">
          <label class="field-label" for="api-key-input">OpenRouter API Key</label>
          <input type="password" id="api-key-input" class="input"
                 placeholder="sk-or-v1-...">
          <p class="field-hint">Required for AI features. Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a></p>
        </div>

        <div class="iteration-counter" id="iteration-counter">
          Suggestions used: 0
        </div>
      </div>
    </div>
  `;

  // Wire up commander search
  const searchInput = el.querySelector('#commander-search');
  const dropdown = el.querySelector('#commander-dropdown');

  const doSearch = debounce(async (query) => {
    if (query.length < 2) {
      dropdown.hidden = true;
      return;
    }

    // Search for commanders specifically
    const results = await searchCards(`is:commander ${query}`);
    if (results.length === 0) {
      dropdown.hidden = true;
      return;
    }

    dropdown.innerHTML = results.slice(0, 8).map((card, i) => `
      <div class="dropdown-item" data-index="${i}">
        ${card.imageUris.small ? `<img src="${card.imageUris.small}" alt="${card.name}" loading="lazy">` : ''}
        <span>${card.name}</span>
      </div>
    `).join('');
    dropdown.hidden = false;

    // Store results for selection
    dropdown._results = results.slice(0, 8);
  }, 300);

  searchInput.addEventListener('input', (e) => {
    doSearch(e.target.value.trim());
  });

  // Close dropdown on blur (with delay for click)
  searchInput.addEventListener('blur', () => {
    setTimeout(() => { dropdown.hidden = true; }, 200);
  });

  // Handle commander selection
  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item || !dropdown._results) return;
    const index = parseInt(item.dataset.index, 10);
    const card = dropdown._results[index];
    if (card && handlers.onCommanderSelect) {
      handlers.onCommanderSelect(card);
    }
    dropdown.hidden = true;
    searchInput.value = '';
  });

  // Change commander button
  el.querySelector('#commander-change').addEventListener('click', () => {
    if (handlers.onCommanderChange) handlers.onCommanderChange();
  });

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

  // Model selector
  el.querySelector('#model-select').addEventListener('change', (e) => {
    if (handlers.onSettingsUpdate) {
      handlers.onSettingsUpdate({ model: e.target.value });
    }
  });

  // API key
  el.querySelector('#api-key-input').addEventListener('input', debounce((e) => {
    if (handlers.onApiKeyChange) {
      handlers.onApiKeyChange(e.target.value.trim());
    }
  }, 300));
}

function updateStrategyDisplay(el, state) {
  const searchInput = el.querySelector('#commander-search');
  const commanderDisplay = el.querySelector('#commander-display');
  const commanderImage = el.querySelector('#commander-image');
  const strategyFields = el.querySelector('#strategy-fields');

  if (state.commander) {
    // Show commander image, hide search
    searchInput.parentElement.hidden = true;
    commanderDisplay.hidden = false;
    commanderImage.src = state.commander.imageUris?.normal || '';
    commanderImage.alt = state.commander.name;
    strategyFields.hidden = false;
  } else {
    // Show search, hide commander
    searchInput.parentElement.hidden = false;
    commanderDisplay.hidden = true;
    strategyFields.hidden = true;
  }

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

  // Update model selector
  const modelEl = el.querySelector('#model-select');
  if (modelEl) modelEl.value = state.settings.model;

  // Update API key (only if not focused)
  const keyEl = el.querySelector('#api-key-input');
  if (keyEl && document.activeElement !== keyEl) {
    keyEl.value = localStorage.getItem('vibetutor_api_key') || '';
  }

  // Update iteration counter
  const counterEl = el.querySelector('#iteration-counter');
  if (counterEl) counterEl.textContent = `Suggestions used: ${state.iterationCount}`;
}

// ============================================================
// DECK PANEL
// ============================================================

/** Deck panel view preferences (ephemeral, not persisted) */
let deckViewMode = 'stacks'; // 'stacks' | 'grid'
let deckGrouping = 'tag';    // 'tag' | 'type' | 'cmc' | 'none'
const collapsedGroups = new Set();

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
      <div id="deck-commander" class="deck-commander-display"></div>

      <div class="deck-toolbar">
        <div class="deck-search-wrapper relative">
          <input type="text" id="deck-search" class="input" placeholder="Add a card..." autocomplete="off">
          <div id="deck-search-dropdown" class="dropdown" hidden></div>
        </div>
        <div class="deck-toolbar-actions">
          <div class="segmented-control deck-view-toggle" id="deck-view-toggle">
            <button data-view="stacks" class="active">Stacks</button>
            <button data-view="grid">Grid</button>
          </div>
          <div class="segmented-control deck-grouping-toggle" id="deck-grouping-toggle">
            <button data-group="tag" class="active">Tag</button>
            <button data-group="type">Type</button>
            <button data-group="cmc">CMC</button>
            <button data-group="none">All</button>
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
    el.querySelectorAll('#deck-view-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.view === deckViewMode));
    updateDeckDisplay(el, _deckState);
  });

  // --- Grouping toggle ---
  el.querySelector('#deck-grouping-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-group]');
    if (!btn) return;
    deckGrouping = btn.dataset.group;
    el.querySelectorAll('#deck-grouping-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.group === deckGrouping));
    collapsedGroups.clear();
    updateDeckDisplay(el, _deckState);
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

    // Remove card
    const removeBtn = e.target.closest('.card-remove-btn');
    if (removeBtn) {
      e.stopPropagation();
      const cardName = removeBtn.dataset.card;
      if (cardName && _deckHandlers.onRemoveCard) _deckHandlers.onRemoveCard(cardName);
      return;
    }

    // Tag badge click — open tag editor
    const tagBadge = e.target.closest('.tag-badge[data-card]');
    if (tagBadge) {
      e.stopPropagation();
      openTagEditor(tagBadge, tagBadge.dataset.card, _deckState, _deckHandlers);
      return;
    }

    // Card image click — show overlay
    const cardItem = e.target.closest('.card-stack-item, .deck-grid-item');
    if (cardItem) {
      const img = cardItem.querySelector('img');
      if (img && img.src) showCardOverlay(img.src, cardItem.dataset.card);
    }
  });
}

function updateDeckDisplay(el, state) {
  // Update commander display
  const cmdEl = el.querySelector('#deck-commander');
  if (cmdEl) {
    if (state.commander) {
      cmdEl.innerHTML = `<img src="${state.commander.imageUris?.normal || ''}" alt="${escapeAttr(state.commander.name)}" loading="lazy">`;
      cmdEl.hidden = false;
    } else {
      cmdEl.innerHTML = '';
      cmdEl.hidden = true;
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
}

function renderStackGroup({ label, cards }) {
  const isCollapsed = collapsedGroups.has(label);
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
          const tag = c.tag || 'untagged';
          return `
            <div class="card-stack-item" data-card="${escapeAttr(c.name)}">
              <img src="${imgUrl}" alt="${escapeAttr(c.name)}" loading="lazy">
              <div class="stack-item-overlay">
                <span class="tag-badge" data-card="${escapeAttr(c.name)}">${escapeHtml(tag)}</span>
                <button class="card-remove-btn" data-card="${escapeAttr(c.name)}">&times;</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function renderGridGroup({ label, cards }) {
  const isCollapsed = collapsedGroups.has(label);
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
          const tag = c.tag || 'untagged';
          return `
            <div class="deck-grid-item" data-card="${escapeAttr(c.name)}">
              <img src="${imgUrl}" alt="${escapeAttr(c.name)}" loading="lazy">
              <div class="grid-item-overlay">
                <span class="tag-badge" data-card="${escapeAttr(c.name)}">${escapeHtml(tag)}</span>
                <button class="card-remove-btn" data-card="${escapeAttr(c.name)}">&times;</button>
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

function groupCards(cards, grouping) {
  const groups = new Map();

  for (const card of cards) {
    let key;
    switch (grouping) {
      case 'tag':
        key = card.tag || 'Untagged';
        break;
      case 'type':
        key = extractPrimaryType(card.scryfallData?.typeLine || '');
        break;
      case 'cmc': {
        const cmc = Math.floor(card.scryfallData?.cmc ?? 0);
        key = cmc >= 7 ? '7+' : String(cmc);
        break;
      }
      default:
        key = 'All Cards';
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }

  // Sort groups
  let sortedKeys;
  switch (grouping) {
    case 'tag':
      sortedKeys = [...groups.keys()].sort((a, b) => {
        if (a === 'Untagged') return 1;
        if (b === 'Untagged') return -1;
        return a.localeCompare(b);
      });
      break;
    case 'type':
      sortedKeys = TYPE_ORDER.filter(t => groups.has(t));
      break;
    case 'cmc':
      sortedKeys = ['0', '1', '2', '3', '4', '5', '6', '7+'].filter(k => groups.has(k));
      break;
    default:
      sortedKeys = [...groups.keys()];
  }

  return sortedKeys.map(key => ({ label: key, cards: groups.get(key) }));
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

  const existingTags = [...new Set(state.cards.map(c => c.tag).filter(Boolean))].sort();
  const currentTag = state.cards.find(c => c.name === cardName)?.tag;

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
  input.focus();
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
      <div id="recs-skipped" hidden>
        <div class="card-stack-header" id="recs-skipped-header" style="cursor:pointer">
          <span class="section-arrow">\u25B6</span>
          <span>Skipped cards</span>
          <span class="stack-count" id="recs-skipped-count"></span>
        </div>
        <div id="recs-skipped-list" hidden></div>
      </div>
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
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const cardName = btn.dataset.card;
    const action = btn.dataset.action;
    if (action === 'add' && _recsHandlers.onAddRecommendation) _recsHandlers.onAddRecommendation(cardName);
    if (action === 'consider' && _recsHandlers.onConsiderRecommendation) _recsHandlers.onConsiderRecommendation(cardName);
    if (action === 'skip' && _recsHandlers.onSkipRecommendation) _recsHandlers.onSkipRecommendation(cardName);
  });

  // Skipped section toggle
  el.querySelector('#recs-skipped-header').addEventListener('click', () => {
    const list = el.querySelector('#recs-skipped-list');
    const arrow = el.querySelector('#recs-skipped-header .section-arrow');
    list.hidden = !list.hidden;
    arrow.textContent = list.hidden ? '\u25B6' : '\u25BC';
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
  if (state._recsLoading) {
    resultsEl.innerHTML = `
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    `;
    return;
  }

  if (state._recsError) {
    resultsEl.innerHTML = `<div class="empty-state">${escapeHtml(state._recsError)}</div>`;
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
          <div class="action-buttons">
            <button class="btn btn-sm btn-success" data-action="add" data-card="${escapeAttr(rec.name)}">Add</button>
            <button class="btn btn-sm btn-warning" data-action="consider" data-card="${escapeAttr(rec.name)}">Consider</button>
            <button class="btn btn-sm" data-action="skip" data-card="${escapeAttr(rec.name)}">Skip</button>
          </div>
        </div>
      </div>`;
  }).join('');

  // Skipped list
  const skippedContainer = el.querySelector('#recs-skipped');
  if (state.skippedRecommendations.length > 0) {
    skippedContainer.hidden = false;
    el.querySelector('#recs-skipped-count').textContent = `(${state.skippedRecommendations.length})`;
    el.querySelector('#recs-skipped-list').innerHTML = state.skippedRecommendations
      .map(name => `<div class="field-hint" style="padding:2px 0">${escapeHtml(name)}</div>`).join('');
  } else {
    skippedContainer.hidden = true;
  }
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
          <div class="action-buttons">
            <button class="btn btn-sm btn-danger" data-action="cut" data-card="${escapeAttr(cut.name)}">Cut</button>
            <button class="btn btn-sm btn-warning" data-action="consider" data-card="${escapeAttr(cut.name)}">Consider</button>
            <button class="btn btn-sm" data-action="keep" data-card="${escapeAttr(cut.name)}">Keep</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// CONSIDERING PANEL
// ============================================================

let _consideringHandlers = null;

export function renderConsideringPanel(state, handlers) {
  const el = document.getElementById('considering-panel');
  if (!el) return;

  _consideringHandlers = handlers;

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

  el.querySelector('#considering-cards').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const cardName = btn.dataset.card;
    const action = btn.dataset.action;
    if (action === 'add' && _consideringHandlers.onAddFromConsidering) _consideringHandlers.onAddFromConsidering(cardName);
    if (action === 'dismiss' && _consideringHandlers.onDismissConsidering) _consideringHandlers.onDismissConsidering(cardName);
    if (action === 'cut' && _consideringHandlers.onCutFromConsidering) _consideringHandlers.onCutFromConsidering(cardName);
    if (action === 'keep' && _consideringHandlers.onKeepFromConsidering) _consideringHandlers.onKeepFromConsidering(cardName);
  });
}

function updateConsideringDisplay(el, state) {
  const cardsEl = el.querySelector('#considering-cards');
  if (!cardsEl) return;

  if (state.considering.length === 0) {
    cardsEl.innerHTML = '<div class="empty-state">Cards you\'re thinking about will appear here</div>';
    return;
  }

  cardsEl.innerHTML = state.considering.map(card => {
    const imgUrl = card.scryfallData?.imageUris?.normal || '';
    const isInDeck = card.inDeck;

    const buttons = isInDeck
      ? `<button class="btn btn-sm btn-danger" data-action="cut" data-card="${escapeAttr(card.name)}">Cut from Deck</button>
         <button class="btn btn-sm" data-action="keep" data-card="${escapeAttr(card.name)}">Keep in Deck</button>`
      : `<button class="btn btn-sm btn-success" data-action="add" data-card="${escapeAttr(card.name)}">Add to Deck</button>
         <button class="btn btn-sm" data-action="dismiss" data-card="${escapeAttr(card.name)}">Dismiss</button>`;

    const sourceBadges = (card.sources || []).map(s => {
      const labels = { scryfall: 'S', edhrec: 'E', spellbook: 'C' };
      const classes = { scryfall: 'source-scryfall', edhrec: 'source-edhrec', spellbook: 'source-spellbook' };
      return `<span class="source-badge ${classes[s] || ''}">${labels[s] || s}</span>`;
    }).join('');

    return `
      <div class="rec-card" data-card="${escapeAttr(card.name)}">
        ${imgUrl ? `<img class="card-image" src="${imgUrl}" alt="${escapeAttr(card.name)}" loading="lazy">` : ''}
        <div class="rec-card-info">
          <div class="flex gap-sm" style="align-items:center">${sourceBadges}</div>
          <p class="rec-pitch">${escapeHtml(card.aiText || '')}</p>
          <div class="action-buttons">${buttons}</div>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// STATS PANEL (stub — Session 7)
// ============================================================

export function renderStatsPanel(state) {
  const el = document.getElementById('stats-panel');
  if (!el || initialized.has('stats')) return;
  el.innerHTML = '<div class="empty-state">Add cards to see stats</div>';
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
