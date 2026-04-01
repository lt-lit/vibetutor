/**
 * ui.js — DOM manipulation and rendering
 * Renders panels and handles user interactions.
 */

import { searchCards, autocomplete, lookupCard } from './scryfall.js';

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
// DECK PANEL (stub — Session 4)
// ============================================================

export function renderDeckPanel(state, handlers) {
  const el = document.getElementById('deck-panel');
  if (!el || initialized.has('deck')) return;
  el.innerHTML = '<div class="empty-state">Your deck will appear here</div>';
}

// ============================================================
// CONSIDERING PANEL (stub — Session 6)
// ============================================================

export function renderConsideringPanel(state, handlers) {
  const el = document.getElementById('considering-panel');
  if (!el || initialized.has('considering')) return;
  el.innerHTML = '<div class="empty-state">Cards you\'re thinking about will appear here</div>';
}

// ============================================================
// RECOMMENDATIONS PANEL (stub — Session 6)
// ============================================================

export function renderRecommendationsPanel(state, handlers) {
  const el = document.getElementById('recommendations-panel');
  if (!el || initialized.has('recommendations')) return;
  el.innerHTML = '<div class="empty-state">AI-powered card suggestions</div>';
}

// ============================================================
// CUTS PANEL (stub — Session 6)
// ============================================================

export function renderCutsPanel(state, handlers) {
  const el = document.getElementById('cuts-panel');
  if (!el || initialized.has('cuts')) return;
  el.innerHTML = '<div class="empty-state">Suggest cards to remove</div>';
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
