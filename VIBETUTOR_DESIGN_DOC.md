# VibeTutor — AI-Powered MTG Deck Building Assistant

## Design Document v3.1

---

## 1. Concept

VibeTutor is a browser-based AI-powered deck building assistant for Magic: The Gathering, focused on Commander/EDH. It does **not** manage or store decks — it helps you **build and refine** them through intelligent, context-aware card recommendations and analysis.

**There is no "build mode" or "doctor mode."** There's just your deck — whether it has 0 cards or 99. The app presents a set of panels that give you different views and tools:

- **Deck** — your current card list, always visible, always editable
- **Recommendations** — AI-suggested cards to add, steered by a free-form text prompt (user-triggered, 2 LLM calls)
- **Cuts** — AI-suggested cards to remove with reasoning (user-triggered, 1 LLM call)
- **Stats** — mana curve, color distribution, combos (free, auto-updates)
- **Strategy** — commander, power level, strategy notes, settings (no LLM cost)

You start by selecting a commander and optionally pasting in an existing decklist. Then you work at your own pace — browse your deck, check stats, and hit the button on the Recommendations or Cuts panel when you want AI suggestions. The AI only runs when you ask for it.

**What makes it different from EDHREC:**
- Recommendations are reactive to YOUR deck, not purely popularity-based
- The AI sees the deck as a system (mana balance, category coverage, synergy chains)
- Pulls from three data sources simultaneously: Scryfall, EDHREC, Commander Spellbook
- Surfaces obscure synergies EDHREC would never show
- Commander Spellbook: "add this card to unlock a combo with cards already in your deck"
- You control the pace — the AI doesn't run until you ask

---

## 2. Architecture

### Stack
- **Frontend:** Vanilla HTML / CSS / JS — no build tools, no framework
- **Middleware:** Cloudflare Worker — caching proxy, API key management, EDHREC access
- **LLM Routing:** OpenRouter (API key stored server-side in Worker)
- **Card Data:** Scryfall API + EDHREC JSON (via Worker proxy) + Commander Spellbook API
- **Deck Storage:** None. Export to clipboard in universal decklist format.
- **Hosting:** GitHub Pages (static site) + Cloudflare Workers (middleware)
- **Deployment:** GitHub Actions for Worker auto-deploy

### Monorepo Structure
```
/vibetutor
  /site                         ← static site served by GitHub Pages
    /css
      style.css
    /js
      app.js                    ← main app entry, state management, panel routing
      api.js                    ← calls to the Worker middleware
      engine.js                 ← multi-source card pool injection engine
      scryfall.js               ← direct Scryfall calls
      spellbook.js              ← direct Commander Spellbook calls
      ui.js                     ← DOM manipulation and rendering
      sections.js                ← collapsible section system
      export.js                 ← deck export format utilities
      storage.js                ← sessionStorage management
    index.html
  /worker                       ← Cloudflare Worker middleware
    src/
      index.js                  ← Worker entry point + route handler
      edhrec.js                 ← EDHREC proxy + cache logic
      llm.js                    ← OpenRouter proxy
      cache.js                  ← cache utilities (Cloudflare KV)
    wrangler.toml
  .github/
    workflows/
      deploy-worker.yml         ← deploys Worker on changes to /worker
```

### Key Principles

**BYOK for v1.** Users provide their own OpenRouter API key (stored in localStorage). The Cloudflare Worker proxies LLM requests with the user's key passed via header. The Worker scaffolding supports a server-side key (for a future free tier) but v1 is BYOK only.

**Three data sources, queried in parallel.** Each AI action queries Scryfall, EDHREC, and Commander Spellbook simultaneously, merges into a unified card pool, feeds to the LLM.

**EDHREC is a graceful enhancement.** If unavailable, everything continues. No error shown.

**User-triggered LLM calls only.** Stats and combo tracker update for free (pure math + free APIs). Recommendations, Cuts, and Strategy panels only fire LLM calls when the user clicks a button.

**Mobile-first.** Panels render as bottom-tab navigation on mobile (one at a time) and flexible multi-column grid on desktop (2-3 visible). Every interaction must work on a phone.

---

## 3. Data Sources

### 3.1 Scryfall (Direct — CORS-friendly, free, no auth)

Full card database. AI composes Scryfall queries to search for specific mechanical/conceptual card roles. Also used for commander autocomplete and card data hydration.

Key endpoints: card search, named lookup, bulk lookup via /cards/collection, autocomplete.

Rate limiting: 50-100ms between requests. Client-side debounce + in-session cache.

### 3.2 EDHREC (Via Worker proxy — no CORS)

`GET json.edhrec.com/pages/commanders/{slug}.json` → synergy scores, inclusion %, deck counts.

Fetched once per commander, cached 24h in Worker KV. Graceful degradation if unavailable.

### 3.3 Commander Spellbook (Direct — CORS-friendly, free, no auth)

`POST backend.commanderspellbook.com/find-my-combos` → combos present + "add 1 card" combos.

Auto-refreshes whenever the deck changes (free API). The "add 1 card" suggestions feed into the Recommendations card pool.

### 3.4 Source Comparison

| Source | Auth | CORS | Via | Cost | What it gives us |
|---|---|---|---|---|---|
| **Scryfall** | None | Yes | Direct | Free | Card database, search, validation |
| **Spellbook** | None | Yes | Direct | Free | Combos, near-miss combos, bracket |
| **EDHREC** | None | No | Worker | Free | Synergy scores, inclusion rates |
| **OpenRouter** | Key | N/A | Worker | Paid | LLM analysis + recommendations |

---

## 4. Cloudflare Worker Middleware

### 4.1 Routes

```
GET  /edhrec/commanders/{slug}     → proxy to json.edhrec.com, cache 24h in KV
POST /llm/chat                     → proxy to OpenRouter, attach API key
GET  /health                       → status check
```

### 4.2 LLM Proxy

Worker stores OpenRouter key as encrypted secret (scaffolded for future free tier, not used in v1). For v1, users send their own key via `X-User-API-Key` header. The Worker passes it through to OpenRouter.

Future: add a server-side key and rate limiting for a free tier. The plumbing is already in place — just add the key and uncomment the fallback logic.

### 4.3 Worker Code

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/edhrec/')) return handleEdhrec(url, env);
    if (url.pathname === '/llm/chat') return handleLLM(request, env);
    if (url.pathname === '/health') {
      return new Response('{"status":"ok"}', {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
    return new Response('Not found', { status: 404 });
  }
};

async function handleEdhrec(url, env) {
  const path = url.pathname.replace('/edhrec', '');
  const cacheKey = `edhrec:${path}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return new Response(cached, {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
  const resp = await fetch(`https://json.edhrec.com/pages${path}.json`);
  if (!resp.ok) return new Response('{"error":"unavailable"}', {
    status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
  const data = await resp.text();
  await env.CACHE.put(cacheKey, data, { expirationTtl: 86400 });
  return new Response(data, {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function handleLLM(request, env) {
  const body = await request.json();
  const userKey = request.headers.get('X-User-API-Key');

  // v1: BYOK only. Future: fall back to env.OPENROUTER_KEY for free tier
  if (!userKey) {
    return new Response(JSON.stringify({ error: 'API key required. Add your OpenRouter key in settings.' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userKey}` },
    body: JSON.stringify(body),
  });
  return new Response(await resp.text(), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-API-Key',
  };
}
```

### 4.4 Deployment

GitHub Actions auto-deploys on push to `/worker`. One-time setup: Cloudflare account, KV namespace, `CLOUDFLARE_API_TOKEN` in GitHub secrets. (Future: add `OPENROUTER_KEY` as Worker secret when implementing free tier.)

---

## 5. The Panel System

### 5.1 Card Display Style

**All panels use visual card display by default, not text lists.** Cards are shown as actual card images, not rows of text.

Two visual modes (user can toggle, default is stacks):

**Visual Stacks** — Moxfield-style. Cards in a group are stacked vertically, showing just the name/mana cost bar at the top of each card. The last card in each stack is fully revealed. Groups can be by tag (default), by card type, by CMC, or ungrouped. Compact and scannable while still showing real cards.

**Visual Grid** — cards shown as a grid of full card images (Scryfall `normal` size scaled down). More visual but takes more space. Better on desktop, usable on mobile in 2-column layout.

Card images come from Scryfall `image_uris`. Use `normal` (488×680) scaled to fit. Lazy-load images outside the viewport.

### 5.2 Panel Definitions

**DECK PANEL** (always available, no LLM cost except auto-tag)
- Cards displayed as visual stacks (default) or grid
- Default grouping: by tag (like Moxfield's custom tags)
  - Each tag group shows as a stack: "wheel (8)", "ramp (10)", "removal (4)"
  - Untagged cards appear in an "Untagged" group at the bottom
  - Toggle grouping: by tag (default), by type, by CMC, ungrouped
- **Tagging system:**
  - Cards from Recommendations arrive pre-tagged (the AI suggests a tag as part of its recommendation)
  - Manually added / imported cards start untagged
  - Tap a card's tag to edit: dropdown of existing tags + "new tag" text input
  - Tags are freeform strings — whatever makes sense for the deck ("wheel", "shinanigans", "too good", "gift", etc.)
  - **"Auto-Tag" button** (1 LLM call): sends the full deck + strategy notes + commander to the AI, which returns a tag for every card using tags that make sense for THIS deck's strategy. Re-tags everything, including already-tagged cards. User can review and adjust after.
- Group headers: "wheel (8)" with collapse/expand
- Each card: tap to expand/show full image, long-press or × button to remove
- Manual card search at top (Scryfall autocomplete) to add cards directly
- Commander card displayed prominently at the top
- Import: paste a decklist to bulk-add (cards arrive untagged)
- Export: copy to clipboard (Moxfield / Plain / Arena)
- Card count: "42/99"

**RECOMMENDATIONS PANEL** (user-triggered, 2 LLM calls per tap)
- Text prompt input at the top: "What are you looking for?" with placeholder examples
  - Rotating example text: "Try: removal, wheel effects, budget ramp under $2, the saltiest cards available, ways to win that aren't combat"
- "Suggest" button next to the input
- **Empty prompt = smart default.** AI analyzes the deck holistically and recommends whatever it thinks is most needed.
- **Custom prompt = targeted search.** AI translates natural language into creative Scryfall queries + EDHREC filters.
- Recent prompts: clickable pills below the input (last 5)
- Loading state: skeleton card shapes with shimmer
- Results: 3-5 cards displayed as full card images (not stacked — each card fully visible since there are only a few), each with:
  - Full card image
  - AI pitch text below the image (1-2 sentences)
  - Source badges (S = Scryfall, E = EDHREC, C = Spellbook)
  - EDHREC synergy % if available
  - Combo alert banner if it completes a combo
  - Three buttons: ✓ Add to Deck / 🤔 Consider / ✗ Skip
- After acting on batch: "Suggest More" reruns same prompt
- Collapsible skip history at bottom

**CUTS PANEL** (user-triggered, 1 LLM call per tap)
- Empty state: "Suggest Cuts" button
- Results: 3-5 cards as full card images with AI reasoning for the cut
- EDHREC inclusion % shown where available
- Per-card buttons: ✓ Cut / 🤔 Consider / ✗ Keep
- "Cut" removes from deck. "Consider" moves to Considering panel (card stays in deck but is flagged for review). "Keep" dismisses and adds to the keep list.
- "Suggest More Cuts" after acting on batch

**CONSIDERING PANEL** (no LLM cost — staging area)
- Cards you're on the fence about, displayed as visual stacks or grid
- Cards land here from:
  - Tapping 🤔 Consider on an Addition (card NOT in deck, just saved for later)
  - Tapping 🤔 Consider on a Cut (card IS still in deck, flagged for review)
- Each card shows:
  - Card image (visual stack or grid, same as Deck panel)
  - The AI pitch or cut reasoning that was attached when it was considered
  - Source badges
  - Action buttons:
    - For additions being considered: ✓ Add to Deck / ✗ Dismiss
    - For cuts being considered: ✓ Cut from Deck / ✗ Keep in Deck
- Cards can be manually added here too (drag from Deck panel, or search)
- Empty state: "Cards you're thinking about will appear here"
- Count badge on the tab: "(3)"

**STATS PANEL** (auto-updates, no LLM cost)
- Recalculates instantly on any deck change
- Mana curve bar chart (CMC 0–7+)
- Color pip distribution pie chart
- Average CMC, total price, card type breakdown
- Combo tracker (auto-refreshes via Commander Spellbook):
  - "Combos in your deck" with descriptions
  - "1 card away" — cards that would complete a combo (shown as card images, tappable to add or consider)
- Bracket estimation from Commander Spellbook

**STRATEGY PANEL** (no LLM cost — pure configuration)
- Commander search (Scryfall autocomplete) — shown prominently on first launch
- Commander card image once selected
- Strategy notes textarea: "Describe your deck's strategy or vibe" (optional — included as context in all LLM calls)
- Power level: Casual / Mid / High / cEDH
- Budget cap (optional, $ per card)
- Settings: model selector, OpenRouter API key input (required for v1)

### 5.4 Layout

**All screen sizes use the same foundation: a single scrollable page with collapsible sections.** No tabs, no hidden panels. Everything is visible, expandable, and in a natural order.

```
┌─────────────────────────┐
│ ▼ Strategy              │  ← collapsed: shows commander image + name
├─────────────────────────┤
│ ▼ Deck (42/99)          │  ← expanded: visual stacks
│   [card stacks]         │
│   [search / import]     │
├─────────────────────────┤
│ ▶ Considering (3)       │  ← collapsed: badge shows count
├─────────────────────────┤
│ ▶ Recommendations       │  ← collapsed: tap to expand, type prompt, suggest
├─────────────────────────┤
│ ▶ Cuts                  │  ← collapsed
├─────────────────────────┤
│ ▼ Stats                 │  ← expanded: curve, combos, etc
└─────────────────────────┘
```

**Section order:** Strategy → Deck → Considering → Recommendations → Cuts → Stats

Each section has a header bar that is tappable to expand/collapse:
- Arrow indicator (▶ collapsed, ▼ expanded)
- Section name
- Badge where relevant (Deck: card count, Considering: card count, Recommendations/Cuts: pending results count)
- Collapsed sections show a brief summary line (e.g., Strategy collapsed shows commander name, Stats collapsed shows "Avg CMC: 2.8 | $124.50")

**Responsive behavior:**
- **Mobile (< 768px):** Single column, full width. Sections stack vertically. This is the primary design.
- **Tablet (768px – 1024px):** Same vertical stack but wider, card stacks and grids get more room.
- **Desktop (> 1024px):** Could optionally split into 2 columns (Deck + Considering on left, everything else on right) but the single-column vertical stack works fine here too. Keep it simple for v1.

**Default collapse state on load:**
- Strategy: collapsed (unless no commander selected — then expanded, commander search prominent)
- Deck: expanded
- Considering: collapsed (unless it has cards)
- Recommendations: collapsed
- Cuts: collapsed
- Stats: expanded

### 5.5 Starting the App

**Fresh start (empty deck):**
1. Strategy section is expanded with commander search front and center
2. Select commander → EDHREC fetch in background
3. Optionally: write strategy notes, set power level
4. Collapse Strategy, expand Recommendations → type what you're looking for → "Suggest"

**Importing existing deck:**
1. Select commander in Strategy section
2. Expand Deck → "Import" → paste decklist
3. Cards bulk-added, Stats auto-update, Spellbook combo check auto-runs
4. Expand Recommendations or Cuts as desired

**No wizard. No flow. Just scroll and expand what you need.**

---

## 6. Card Pool Injection Engine

### 6.1 The Core Pattern

Every AI-powered action (Suggest Recommendations, Suggest Cuts) calls `engine.js`. The engine handles the multi-source fetch, merge, and LLM calls.

### 6.2 The Two-Call Iteration (Recommendations)

**LLM Call #1 — Analyze + Compose Queries** (fast, small response)

Input: deck state, strategy notes, skips, power level, **user prompt** (the text from the Recommendations panel input — may be empty)

When prompt is empty, the AI holistically analyzes the deck and decides what's most needed. When prompt is provided, the AI tailors its search to what the user asked for.

Example with prompt "politically toxic things to donate with Zedruu":
```json
{
  "type": "queries",
  "reasoning": "User wants donation targets that punish opponents. Looking for permanents with detrimental ongoing effects for their controller.",
  "scryfallQueries": [
    "ci:wur t:enchantment o:\"beginning of your upkeep\" (o:sacrifice OR o:damage OR o:lose) f:commander",
    "ci:wur t:artifact (o:\"can't\" OR o:\"damage to you\") f:commander",
    "ci:wur o:\"exchange control\" f:commander"
  ],
  "edhrecFilter": "donation targets, detrimental permanents, political tools"
}
```

Example with empty prompt (smart default):
```json
{
  "type": "queries",
  "reasoning": "Deck has 34 cards, no card draw engines. Prioritizing draw to avoid running out of gas.",
  "scryfallQueries": [
    "ci:wur o:\"draw\" t:enchantment f:commander cmc<=4",
    "ci:wur o:\"draw\" o:\"each\" f:commander",
    "ci:wur o:\"whenever\" o:\"draw\" f:commander"
  ],
  "edhrecFilter": "card draw, card advantage"
}
```

**Parallel Fetch** (via `Promise.allSettled`):
1. Scryfall: run AI-composed queries
2. EDHREC: filter cached commander data by AI's conceptual description
3. Commander Spellbook: get "add 1 card" combo completions

**Merge + Deduplicate** — unified pool with metadata from all sources.

**LLM Call #2 — Selection + Justification**

Input: deck state + user prompt + merged card pool

Output:
```json
{
  "type": "recommendations",
  "cards": [
    {
      "name": "Aggressive Mining",
      "tag": "gift",
      "pitch": "Locks its controller out of playing lands — perfect to donate. In 45% of Zedruu decks with +72% synergy."
    }
  ]
}
```

The `tag` should be contextual to the deck's strategy and consistent with existing tags in the deck where possible. The AI should look at what tags already exist and reuse them when appropriate rather than creating near-duplicates.

### 6.3 Cuts (Single LLM Call)

Cuts don't need the two-call pattern. No Scryfall queries, no pool merging — the AI just analyzes the existing deck.

Input: deck state, strategy notes, keptCards list, EDHREC data

Output:
```json
{
  "type": "cuts",
  "cards": [
    {
      "name": "Some Underperformer",
      "reason": "Costs 6 mana, doesn't synergize with your strategy. Only 3% of Zedruu decks run it."
    }
  ]
}
```

### 6.4 Validation

Every card name in the LLM's output is validated against the source pool. If the AI names a card that wasn't in the pool, it's silently filtered out.

---

## 7. State Schema

```javascript
const deckState = {
  commander: {
    name: "Zedruu the Greathearted",
    colorIdentity: ["W", "U", "R"],
    oracleText: "...",
    scryfallId: "...",
    imageUri: "..."
  },

  strategy: {
    notes: "Political chaos — donate bad permanents, pillowfort",  // optional
    powerLevel: "mid",
    budgetCap: null
  },

  edhrecData: { loaded: false, cardRecs: [], lastFetched: null },

  cards: [
    {
      name: "Smothering Tithe",
      tag: "ramp",                // freeform string, null if untagged
      scryfallData: { /* ... */ },
      aiPitch: "Ramp AND political tool.",
      edhrecSynergy: 0.15,
      sources: ["scryfall", "edhrec"]
    }
  ],

  skippedRecommendations: [],   // card names user skipped (never re-suggest)
  keptCards: [],           // card names user chose to keep (never re-suggest for cuts)

  // Considering panel — cards the user is on the fence about
  considering: [
    {
      name: "Paradox Haze",
      scryfallData: { /* ... */ },
      aiText: "Doubles your upkeep triggers — Zedruu draws you extra cards for each donated permanent.",
      source: "recommendations",    // "recommendations" or "cuts" — where this card came from
      inDeck: false,              // true if card is in deck (flagged cut), false if not yet added
      sources: ["scryfall", "edhrec"]
    }
  ],

  combos: { present: [], nearMiss: [], bracket: null },

  // Recommendations panel state
  recommendationsPrompt: "",         // current text in the Recommendations prompt input
  recommendationsResults: [],        // current results (ephemeral)
  recentPrompts: [],           // last 5 prompts for quick re-use

  // Cuts panel state
  cutsResults: [],             // current results (ephemeral)

  iterationCount: 0            // total LLM calls this session
};
```

State auto-saves to sessionStorage on every change. Refresh restores where you left off.

---

## 8. AI Prompts

### 8.1 System Prompt (shared across all calls)

```
You are VibeTutor, an expert MTG Commander/EDH deck building assistant.

RULES:
1. NEVER invent card names. ONLY pick from the candidate pool provided.
2. Account for deck state: cards present, skipped, kept.
3. Concise pitches: 1-2 sentences.
4. Reference EDHREC data when available.
5. Always mention combo completions from Spellbook data.
6. If a budget cap is set, avoid cards above that price.
7. When recommending cards, include a suggested tag. Reuse existing tags in the deck where appropriate. Tags should be contextual to the deck's strategy (e.g., "wheel", "gift", "defence" — not generic categories like "creature" or "instant").

Scryfall syntax (for query composition):
ci:wur | t:creature | o:"phrase" | cmc<=3 | f:commander
order:edhrec | order:random | OR, AND, -, ()
-t:creature (NOT) | r:rare | c:w (white cards)
```

### 8.2 Query Composition (LLM Call #1 — Recommendations only)

Input: commander data, deck state (cards + tags + stats summary), strategy notes, power level, skipped cards list, **user prompt** (may be empty).

When user prompt is empty: analyze the deck holistically and decide what it needs most. Consider mana curve, card draw density, removal count, win conditions, synergy gaps.

When user prompt is provided: translate the user's natural language request into targeted Scryfall queries. Be creative — approach the concept from multiple angles.

Output: JSON with reasoning, 2-4 Scryfall query strings, EDHREC filter description.

### 8.3 Card Selection (LLM Call #2 — Recommendations only)

Input: deck state (including existing tags) + user prompt + merged card pool from all sources.

Output: JSON with 3-5 recommended cards, each with a tag and a pitch. Tags should be consistent with existing tags in the deck. If the user prompted "wheel effects", tag them "wheel". If no prompt, infer an appropriate tag from the card's role.

### 8.4 Cut Analysis (single LLM call)

Input: deck state, strategy notes, EDHREC data, keptCards list.

Output: JSON with 3-5 cards to cut, each with reasoning referencing synergy, curve, EDHREC inclusion rates.

### 8.5 Auto-Tag (single LLM call, triggered from Deck section)

Input: full card list, commander data, strategy notes.

Prompt: "Organize this deck into tags that reflect the deck's strategy. Tags should be short, descriptive, and specific to this deck — not generic card types. Examples: for a Zedruu deck you might use 'gift', 'defence', 'ramp', 'sharing', 'too good', 'wild'. For a Nekusar deck: 'wheel', 'draw punish', 'discard punish'. Assign exactly one tag to each card. Try to use 5-10 distinct tags. Return JSON."

Output:
```json
{
  "type": "auto-tag",
  "tags": [
    { "name": "Sol Ring", "tag": "ramp" },
    { "name": "Aggressive Mining", "tag": "gift" },
    { "name": "Rhystic Study", "tag": "too good" },
    { "name": "Propaganda", "tag": "defence" }
  ]
}
```

---

## 9. Export Formats

```javascript
const exportFormats = {
  plain: (deck) => deck.cards.map(c => `1 ${c.name}`).join('\n'),

  moxfield: (deck) => {
    const grouped = groupBy(deck.cards, 'tag');
    return Object.entries(grouped)
      .map(([tag, cards]) => {
        const header = tag || 'Untagged';
        return `// ${capitalize(header)}\n${cards.map(c => `1 ${c.name}`).join('\n')}`;
      })
      .join('\n\n');
  },

  arena: (deck) => deck.cards.map(c => {
    const set = c.scryfallData?.set?.toUpperCase() || '';
    const num = c.scryfallData?.collector_number || '';
    return `1 ${c.name} (${set}) ${num}`;
  }).join('\n')
};
```

---

## 10. Error Handling

**Never lose state.** SessionStorage auto-save on every change.

- OpenRouter failure → error message in panel, deck state preserved, retry button
- Scryfall failure → retry with backoff
- EDHREC failure → silently continue without it
- Commander Spellbook failure → silently continue without it
- AI suggests card not in pool → silently filter out
- AI returns malformed JSON → retry once, then show error
- Missing API key → prompt user to add OpenRouter key in Strategy settings
- Page refresh → state restored from sessionStorage

---

## 11. Claude Code Session Prompts

Each prompt is the opening message of a Code session in the Claude desktop app, pointed at the `vibetutor` GitHub repo.

### Session 1: Monorepo Scaffold + Worker

```
Set up the vibetutor monorepo.

/site — static frontend served by GitHub Pages
/worker — Cloudflare Worker middleware
/.github/workflows/ — GitHub Actions

For /site, create index.html + css/style.css + JS modules (app.js, api.js, engine.js, scryfall.js, spellbook.js, ui.js, sections.js, export.js, storage.js).

The app is a single scrollable page with collapsible sections. Mobile-first design. Same layout on all screen sizes.

Sections in order: Strategy, Deck, Considering, Recommendations, Cuts, Stats.

Each section has a header bar (tappable to expand/collapse) with an arrow indicator, section name, and optional badge (card counts, result counts). Collapsed sections show a brief summary line.

Default collapse state: Strategy collapsed (unless no commander — then expanded), Deck expanded, Considering collapsed, Recommendations collapsed, Cuts collapsed, Stats expanded.

First launch: Strategy section expanded with commander search input prominently centered.

Dark theme using CSS custom properties. No frameworks, no build tools.

For /worker, create wrangler.toml + src/index.js with routes:
- GET /edhrec/commanders/{slug} → proxy to json.edhrec.com, CORS headers, KV cache (24h TTL)
- POST /llm/chat → proxy to OpenRouter, pass user's API key from X-User-API-Key header (BYOK). Scaffolded for future server-side key.
- GET /health → status
- OPTIONS * → CORS preflight

For /.github/workflows, create deploy-worker.yml that triggers on push to main when /worker changes, using cloudflare/wrangler-action.

The Worker URL should be configurable in site/js/api.js as a constant at the top of the file.
```

### Session 2: Scryfall + Commander Spellbook Integration

```
Implement the card data integrations in /site/js.

scryfall.js:
- Card search: takes a raw Scryfall query string URL, returns parsed card objects (name, oracle_text, cmc, type_line, color_identity, image_uris, prices, set, collector_number)
- Named card lookup (exact match)
- Bulk lookup via POST /cards/collection (for importing decklists)
- Autocomplete via /cards/autocomplete (for commander search + manual add)
- Client-side rate limit queue: 100ms between requests
- In-session cache: Map keyed by query string
- Decklist parser: parse plain text into card names + quantities. Handle: "1 Card Name", "1x Card Name", "Card Name", Arena format with set codes, // comment headers, blank lines

spellbook.js:
- Find combos: POST to backend.commanderspellbook.com/find-my-combos with card name list. Return combos present + "add 1 card" combos (extract the missing card names).
- Bracket estimation: POST to /estimate-bracket
- Error handling: return empty results on failure, never throw

api.js:
- fetchEdhrec(commanderSlug): GET to Worker /edhrec/commanders/{slug}, parse response, extract card recs with synergy scores and inclusion rates. Return null on failure.
- fetchLLM(messages, model): POST to Worker /llm/chat. Send user's API key via X-User-API-Key header (from localStorage). Return parsed response or throw on failure.

Test with real API calls where possible. EDHREC will fail until Worker is deployed — that's fine, verify graceful degradation.
```

### Session 3: Strategy Panel + Commander Selection

```
Build the Strategy panel.

Commander search:
- Text input with Scryfall autocomplete (debounced 300ms)
- Query: is:commander {input}
- Results dropdown with small card images
- On selection: display full commander card image, store in state, fetch EDHREC data in background via api.js

Strategy section (appears after commander):
- Strategy notes textarea: "Describe your deck's strategy or vibe" with placeholder "e.g., Political chaos, donate bad permanents, pillowfort"
- This is optional — it gets included as context in all future LLM calls but isn't required
- Power level: Casual / Mid / High / cEDH (segmented control, must work on mobile)
- Budget cap: optional number input ($ per card)

No blueprint generation. No LLM calls on this panel. This is pure configuration that feeds into the Recommendations and Cuts panels when those are triggered.

Settings section at the bottom:
- Model selector dropdown (default: anthropic/claude-sonnet-4)
- OpenRouter API key input (required, stored in localStorage)
- "Suggestions used: X" counter

Mobile: all of this should scroll naturally in a single column. Commander search and card image at the top, strategy fields below, settings below that.
```

### Session 4: Deck Panel

```
Build the Deck section with visual card display and tagging system.

CARD DISPLAY:
- Default view: Visual Stacks (Moxfield-style)
  - Cards grouped by tag (default). Each tag group is a stack: "wheel (8)", "ramp (10)", "gift (6)"
  - Untagged cards appear in an "Untagged" stack at the bottom
  - Group headers: "wheel (8)" with tap to collapse/expand
  - Cards in each group stacked vertically showing the top edge (name bar + mana cost) of each card, with the last card in the stack fully revealed
  - Card images from Scryfall image_uris.normal, scaled to fit the section width
- Alternative view: Visual Grid
  - Cards shown as a grid of scaled-down card images (2 columns on mobile, 3-4 on desktop)
  - Toggle button to switch between Stacks and Grid
- Tapping any card in a stack expands it to show the full card image (overlay on mobile, inline expand on desktop)
- Grouping toggle: by tag (default), by type, by CMC, ungrouped

TAGGING:
- Cards from Recommendations arrive with a suggested tag (from the AI)
- Manually added / imported cards start with tag = null (show in "Untagged" group)
- Tap a card's tag label to edit: dropdown of all existing tags in the deck + a "new tag" text input at the bottom
- Tags are freeform lowercase strings — whatever makes sense for the deck
- "Auto-Tag" button in the section header (next to card count):
  - 1 LLM call: sends full deck + strategy notes + commander
  - AI returns a tag for every card, using tags that reflect the deck's strategy
  - All cards get re-tagged (including already-tagged ones)
  - User can review and manually adjust any tags after
  - Loading state while auto-tag runs, existing deck display stays visible

INTERACTIONS:
- × button on each card to remove from deck
- Long-press (mobile) or right-click (desktop) for options: Remove, Move to Considering, Change Tag

Manual card search:
- Search input at the top of the panel
- Scryfall autocomplete dropdown as you type
- Selecting a card adds it to the deck immediately

Import:
- "Import" button opens a modal/overlay with a textarea
- Paste a decklist, click "Import"
- Parse with the decklist parser, bulk lookup via Scryfall /cards/collection
- Show warnings for cards not found
- Rec all found cards to the deck
- Auto-detect commander from the list (legendary creature) or prompt user to select

Export:
- "Export" button shows format options: Moxfield / Plain / Arena
- Copies to clipboard, shows "Copied!" toast
- On mobile: export options as a bottom sheet

Card count indicator: "42/99" prominently displayed
Commander card shown at the top with image.

Commander card shown at the top of the panel with image.

State changes (add/remove cards) should:
1. Auto-save to sessionStorage
2. Trigger Stats panel recalculation
3. Trigger Commander Spellbook combo refresh (debounced, maybe 1s after last change)
```

### Session 5: Card Pool Injection Engine

```
Implement engine.js — the multi-source card pool injection engine.

This module exports two functions: suggestRecommendations(deckState, userPrompt) and suggestCuts(deckState).

suggestRecommendations(deckState, userPrompt):

userPrompt is a string from the Recommendations panel text input. It may be empty.

Step 1 — LLM Call #1 (Query Composition):
Send deck state to LLM. Include: commander data, strategy notes, deck card list summary (names + types + CMC), power level, skipped cards list, and the userPrompt.

System prompt includes Scryfall syntax reference so the AI can compose valid queries.

When userPrompt is empty: tell the AI to analyze the deck holistically and search for whatever it thinks is most needed.
When userPrompt has text: tell the AI to translate the user's request into targeted Scryfall queries.

Ask it to output JSON with 2-4 Scryfall query strings and an EDHREC filter description.

Step 2 — Parallel Fetch (Promise.allSettled):
- Run each Scryfall query via scryfall.js
- Filter cached EDHREC data by AI's conceptual description (client-side keyword match on card names, types, oracle text)
- Hit Commander Spellbook find-my-combos, extract "add 1 card" suggestions as candidate cards, look up each on Scryfall to get full data

Step 3 — Merge + Deduplicate:
Combine all results. Dedup by card name. Attach metadata from each source (edhrecSynergy, edhrecInclusion, combosUnlocked, sources[]). Filter out cards already in deck or in skippedRecommendations list.

Step 4 — LLM Call #2 (Selection):
Send deck state + userPrompt + merged pool. AI picks 3-5 cards with pitches that reference the user's prompt. Validate every card name against the pool. Filter out any that don't match.

Return the validated recommendations.

suggestCuts(deckState):

Single LLM call. Send full deck to LLM with EDHREC data and keptCards list. Ask it to identify 3-5 underperforming cards with reasoning. No Scryfall queries needed, no pool merging — the AI analyzes existing cards directly.

Return the cut suggestions.

Error handling:
- If LLM returns bad JSON, retry once
- If all Scryfall queries return 0 results, return an error message suggesting the user try a different prompt
- If EDHREC/Spellbook fail, continue without them
- Always return SOMETHING as long as the LLM is reachable
```

### Session 6: Recommendations, Cuts, and Considering Panels

```
Build the Recommendations, Cuts, and Considering panels, wiring them up to engine.js.

RECOMMENDATIONS PANEL:
- Text input at the top: placeholder "What are you looking for? (leave blank for smart suggestions)"
  - Below the input, show rotating placeholder examples in muted text: "Try: removal, wheel effects, budget ramp under $2, the saltiest cards available"
- "Suggest" button next to the input (or below it on mobile)
- Recent prompts: small clickable pills below the input showing the last 5 prompts for quick reuse
- Tapping Suggest calls engine.suggestRecommendations(deckState, promptText)
- Loading state: skeleton card shapes with shimmer animation
- Results: 3-5 cards shown as FULL CARD IMAGES (not stacked — each fully visible, scrollable vertical list)
  - Below each card image:
    - Suggested tag badge (e.g., "wheel", "gift") — tappable to change before adding
    - AI pitch text (1-2 sentences)
    - Source badges: small colored pills (S = Scryfall, E = EDHREC, C = Spellbook)
    - EDHREC synergy % if available
    - Combo alert banner if it completes a combo
    - Three buttons: ✓ Add (green) / 🤔 Consider (yellow/amber) / ✗ Skip (gray)
- Add: card moves to Deck section with the suggested tag attached
- Consider: card moves to Considering panel (not in deck yet, saved for review)
- Skip: card fades out, added to skippedRecommendations list
- After acting on all cards: "Suggest More" reruns same prompt
- Collapsible "Skipped cards" section at the bottom

CUTS PANEL:
- Empty state: centered "Suggest Cuts" button
- Tapping calls engine.suggestCuts(deckState)
- Loading state: skeleton card shapes with shimmer
- Results: 3-5 cards as FULL CARD IMAGES with:
  - AI reasoning for the cut below each image
  - EDHREC inclusion % if available
  - Three buttons: ✓ Cut (red) / 🤔 Consider (amber) / ✗ Keep (gray)
- Cut: removes from Deck panel
- Consider: card stays in deck but moves to Considering panel flagged for review
- Keep: card dismissed, added to keptCards list
- "Suggest More Cuts" after acting on batch

CONSIDERING PANEL:
- Visual card display: same stacks/grid toggle as the Deck panel
- Cards arrive here from Recommendations (🤔) and Cuts (🤔)
- Each card shows the AI pitch or cut reasoning that was attached
- For each card, action buttons:
  - If from Recommendations (not in deck): ✓ Add to Deck / ✗ Dismiss
  - If from Cuts (still in deck): ✓ Cut from Deck / ✗ Keep in Deck
- Manual add: search input to add any card to Considering for later review
- Empty state: "Cards you're thinking about will appear here"
- Badge on tab shows count

All three panels: full card images, large touch targets (44px min), mobile-friendly vertical scroll. Card images lazy-loaded.
```

### Session 7: Stats Panel

```
Build the Stats panel. This panel auto-updates whenever the deck changes — no LLM calls, no buttons needed.

All charts rendered with CSS/HTML only. No chart libraries.

MANA CURVE:
- Horizontal bar chart showing card count at each CMC (0, 1, 2, 3, 4, 5, 6, 7+)
- Colored bars (use the deck's color identity for bar colors, or a neutral color)
- Numbers on each bar

COLOR DISTRIBUTION:
- Pie chart using CSS conic-gradient
- Based on color pips in mana costs (count W, U, B, R, G pips across all cards)
- Legend with counts

KEY STATS:
- Average CMC (excluding lands)
- Total estimated price (sum of Scryfall prices)
- Card count: X/99
- Card type breakdown: Creatures, Instants, Sorceries, Enchantments, Artifacts, Lands, Other

COMBO TRACKER:
- Auto-refreshes from Commander Spellbook whenever the deck changes (debounced)
- "Combos in your deck" section: list each detected combo with card names
- "1 card away" section: list combos that need 1 more card, showing the missing card name — these are tappable and could auto-add the card

BRACKET ESTIMATION:
- From Commander Spellbook's /estimate-bracket endpoint
- Display as a badge: "Bracket: 3" or similar

On mobile: all stats sections stack vertically and scroll. Charts should be sized to fit phone width. Keep it clean and scannable.
```

### Session 8: Polish + Mobile UX

```
Polish pass across the entire app. Focus on mobile experience.

MOBILE TOUCH TARGETS:
- All buttons minimum 44x44px touch targets
- Card add/consider/skip/cut/keep buttons should be prominent and easy to tap
- Section headers should be easy to tap for expand/collapse
- Swipe gestures to collapse sections (optional nice-to-have)

CARD IMAGE EXPANSION:
- In visual stacks: tapping a card expands it to full view
- On mobile: full card image as centered overlay with dark backdrop, tap outside to dismiss
- On desktop: inline expand within the stack, or floating overlay
- Smooth fade-in (150ms)
- Pre-fetch card images for recommendation batches and combo tracker cards

LOADING STATES:
- Skeleton card placeholders with shimmer effect while AI is working
- Panel-specific loading indicators (don't block other panels)
- Loading text that updates: "Analyzing deck..." → "Searching 3 sources..." → "AI is choosing..."

TOAST NOTIFICATIONS:
- "Card added to Ramp (7/10)" on add
- "Copied to clipboard!" on export
- "Card removed" on cut/remove
- Stack from bottom, auto-dismiss after 3s
- On mobile: toasts should appear at the top or bottom without blocking content

ANIMATIONS:
- Card add: brief scale-down + fade
- Card skip/cut: slide out + fade
- Panel transitions: smooth crossfade
- Category progress bars: smooth fill animation
- Keep animations minimal on mobile for performance

ERROR STATES:
- Missing API key: prompt to add key in Strategy settings, don't allow LLM calls without it
- Network error: retry button in the affected panel
- Never show raw error messages — always human-readable

SESSION PERSISTENCE:
- Verify sessionStorage save/restore works correctly
- Test: add 20 cards, refresh page, verify all cards + state restored

ACCESSIBILITY:
- All interactive elements keyboard-navigable
- Card images have alt text
- Sufficient color contrast in dark theme
- Section headers have aria labels and aria-expanded attributes
```

### Session 9: Integration Testing

```
End-to-end testing across the full app.

Test 1 — Fresh Build with Prompts:
- Open app, select "Zedruu the Greathearted" as commander
- Verify EDHREC data loads in background (check browser console)
- Write strategy notes: "political chaos, donate bad permanents, pillowfort"
- Set power level to Mid to 0.6
- Switch to Recommendations panel
- Leave prompt empty, tap "Suggest" — verify AI identifies what the deck needs (smart default)
- Verify: loading state shows, results appear in ~5-10s
- Verify: all recommended card names are REAL cards (no hallucinations)
- Verify: source badges show correctly
- Verify: EDHREC synergy % shows where available
- Rec 2 cards, consider 1, skip 2
- Verify: recommended cards have suggested tag badges
- Verify: can change a card's tag before adding
- Verify: Deck section shows visual stacks grouped by tag (not text lists)
- Verify: Deck section updates, Stats section recalculates
- Verify: Considering section shows the considered card with AI pitch
- Verify: can add considered card to deck from Considering section
- Verify: skipped cards don't reappear in next batch
- Type "politically toxic things to donate" → Suggest — verify results match the prompt
- Verify: recommended cards tagged appropriately (e.g., "gift")
- Type "budget removal under $1" → Suggest — verify different results with "removal" tags
- Verify: recent prompts show as clickable pills
- Run several more iterations with various prompts

Test 2 — Import + Refine:
- Select a commander, switch to Deck section
- Import a real 99-card Zedruu decklist
- Verify: all cards loaded, shown in "Untagged" stack (no tags yet)
- Verify: Stats section populates
- Verify: Spellbook combo tracker shows detected combos
- Tap "Auto-Tag" button in Deck section header
- Verify: loading state, then all cards get tagged with deck-appropriate tags
- Verify: visual stacks regroup by tag (e.g., "gift (6)", "ramp (10)", "defence (5)")
- Verify: can manually change any card's tag by tapping it
- Switch to Cuts section, tap "Suggest Cuts"
- Verify: AI identifies reasonable underperformers with full card images
- Cut 1 card, consider 1, keep 1
- Verify: Considering panel shows the considered cut (still in deck, flagged)
- Switch to Recommendations to fill the gaps

Test 3 — Mobile:
- Open on a phone (or browser mobile emulation)
- Verify: all sections render in correct order, collapsible headers work
- Verify: visual stacks display card images properly on small screens
- Verify: tapping a card in a stack shows full card overlay
- Verify: add/consider/skip buttons are easy to tap on recommendation cards
- Verify: import/export works on mobile
- Verify: no horizontal scrolling, nothing overflows
- Verify: section badges show correct counts
- Verify: collapsed sections show summary text

Test 4 — Edge Cases:
- Refresh mid-build → state restored
- EDHREC unavailable → app works, no error shown
- Commander Spellbook unavailable → app works, no combos shown
- Missing API key → prompted to add key, LLM features disabled until key is set
- AI returns malformed JSON → automatic retry happens
- Very long card names display without breaking layout

Test 5 — Worker:
- Verify /health endpoint responds
- Verify EDHREC caching: first request slower, second instant
- Verify LLM proxy: requests with user API key go through, responses return
- Verify missing key: LLM proxy returns 401 when no key provided

Fix all issues found.
```

---

## 12. Open Design Questions

1. **Free tier.** v1 is BYOK. Future: add a server-side OpenRouter key to the Worker and offer a free tier with rate limiting. The Worker already supports this — just add the key and uncomment the fallback logic. Need to calibrate costs first.

2. **Spice dial.** Future feature: a slider from "competitive staples" to "off-meta deep cuts" that affects how the AI composes queries and weights EDHREC popularity vs creative Scryfall searches. Deferred to keep v1 simple.

3. **Combo check frequency.** Spellbook auto-refreshes on deck changes. Debounce at 2-3 seconds after last change should be fine since it's a free API.

4. **Prompt suggestions.** Should the app suggest prompts based on deck analysis? E.g., if the deck has no removal, show a subtle hint: "Your deck might need: removal, card draw." Not blocking, just nudging.

5. **Multi-commander support.** Partners, backgrounds, friends forever. V1: single commander only. V1.1: partner support.

6. **EDHREC inclusion % display.** Show it on every card, or only when notably high/low? "47% of decks run Sol Ring" is noise. "Only 3% run this" is signal.

7. **Monetization.** If/when a free tier is added and costs become a factor: Patreon for higher limits, one-time tip jar, or just keep it BYOK. No ads.