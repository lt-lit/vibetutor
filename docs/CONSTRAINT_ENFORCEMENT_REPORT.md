# Problem Report: Unreliable Constraint Enforcement in Recommendation Engine

## Problem Summary

When users specify precise constraints in recommendation queries (specific sets, name patterns, unusual filters), the engine frequently returns cards that violate those constraints. This isn't limited to sets — it affects any constraint that requires precise Scryfall syntax the LLM doesn't reliably generate.

## Examples of Failures

| User Query | Expected Behavior | Actual Behavior |
|---|---|---|
| "Only cards from Lorwyn Eclipsed" | Cards exclusively from Lorwyn Eclipsed | Returns Lorwyn cards (wrong set, similar name) |
| "Only cards whose names end in -ism" | Scryfall regex: `name:/ism$/` | LLM likely generates `name:ism` or keyword searches — misses the regex syntax |
| "Only the Khans of Tarkir block" | Cards from KTK + FRF + DTK | LLM might only query KTK, missing Fate Reforged and Dragons of Tarkir |
| "Only cards from Return to Ravnica" | Exactly RTR, not RNA/GRN/RAV | LLM may confuse Ravnica sets |

## Root Cause Analysis

The recommendation engine has a **two-LLM-call pipeline** (`engine.js`):

```
User Query
    ↓
LLM Call #1 (buildQueryPrompt, line 230)
  → Generates 2-4 Scryfall search queries + EDHREC filter
    ↓
Parallel Fetch (line 61)
  → Scryfall: executes LLM's queries as-is
  → EDHREC: keyword filter on cached card recs
  → Spellbook: near-miss combo lookup
    ↓
Merge & Deduplicate (mergeCardPool, line 429)
    ↓
LLM Call #2 (buildSelectionPrompt, line 272)
  → Picks up to 10 cards from the merged pool
  → Returns tag + pitch for each
    ↓
Output
```

**The engine trusts the LLM at every stage and never validates its work.** There are five specific failure points:

### Failure Point 1: LLM #1 generates wrong Scryfall syntax
The LLM is asked to write Scryfall queries but doesn't reliably know:
- Set codes (`s:lrw` vs `s:lre` for Lorwyn vs Lorwyn Eclipsed)
- Regex syntax (`name:/ism$/` for names ending in "-ism")
- Block membership (which sets belong to which blocks)
- Disambiguation of similarly-named sets/products

**This is the hardest problem.** Scryfall's query syntax is powerful (supports regex, set codes, blocks, artist, rarity, frame effects, etc.) but the LLM's knowledge of it is inconsistent.

### Failure Point 2: No post-fetch filtering
After Scryfall returns results, the engine does **zero validation** that the results match the user's constraint. Cards from wrong sets, wrong rarities, etc. pass straight through to the pool.

### Failure Point 3: EDHREC/Spellbook sources ignore constraints entirely
`filterEdhrecPool()` (line 382) does loose keyword matching on EDHREC data — it has no concept of set, rarity, or name patterns. `fetchSpellbookNearMiss()` (line 410) returns combo pieces regardless of any constraint. These cards enter the pool with `scryfallData: null`, so even if we wanted to filter them, we'd lack the metadata to do so.

### Failure Point 4: Pool summary lacks filtering metadata
The pool summary sent to LLM #2 includes type, CMC, price, synergy, and combo data — but **not** set name, rarity, or artist. Even if LLM #2 wanted to enforce "only Lorwyn Eclipsed cards," it can't see which set each card is from.

### Failure Point 5: No post-selection validation
After LLM #2 picks cards, the engine validates that the card names exist in the pool (line 88-103) but never checks whether the selections satisfy the user's original constraint.

### The Multiple Printings Complication
Many Magic cards have been printed in multiple sets, often with different artists and rarities. Scryfall search results return **one printing per card** (typically the most recent or the one matching the query's set filter). This means:
- If LLM #1's queries don't include the right set code, a card might come back under its Lorwyn printing when the user wanted Lorwyn Eclipsed
- The metadata on each card reflects only the printing that was returned, not all printings that exist
- Filtering by set/artist/rarity at the pool level (Failure Point 2) would incorrectly exclude cards that DO have a valid printing in the requested set, just not the one Scryfall happened to return

## What Works Today

The current prompt language (PRIMARY DIRECTIVE, hard constraint instructions) helps with **soft constraints** that the LLM can evaluate conceptually:
- "budget ramp under $2" — LLM can read prices in the pool
- "wheel effects" — LLM understands the concept
- "removal spells" — LLM can evaluate card text
- "CMC 3 or less" — LLM can read CMC in the pool

It fails with **hard/precise constraints** that require exact Scryfall syntax or metadata the LLM can't see.

## Possible Solution Directions (Not Yet Decided)

### Direction A: Enrich pool metadata + stronger LLM #2 filtering
- Add set name, rarity, artist to `parseCard()` in `scryfall.js`
- Include these fields in the pool summary for LLM #2
- Relies on LLM #1 generating decent (if imperfect) queries, then LLM #2 filtering with full metadata
- **Limitation**: If LLM #1 generates completely wrong queries, the pool won't contain the right cards for LLM #2 to select from. Also doesn't solve the multiple-printings problem — pool metadata reflects only the returned printing.

### Direction B: Post-fetch re-query with Scryfall validation
- After LLM #1 generates queries and Scryfall returns results, check if any results were returned
- If a query returns 0 results, attempt to fix the query (e.g., look up correct set codes via Scryfall `/sets` API)
- Re-run corrected queries
- **Tradeoff**: Adds latency and complexity, but catches the most common failure mode (wrong set codes)

### Direction C: Give the LLM a Scryfall syntax reference
- Include a condensed Scryfall syntax guide in the query composition prompt (set code format, regex syntax, block queries, etc.)
- Increases prompt size but gives the LLM the tools to generate correct queries
- **Tradeoff**: Adds token cost, may not fit well in context, still no guarantee of correctness

### Direction D: Hybrid — deterministic pre-processing for known constraint types + metadata enrichment
- Before LLM #1, detect constraint patterns (set names, blocks, regex-like requests) and resolve them deterministically
- Inject resolved Scryfall syntax fragments into the prompt ("use `s:lre` for this set")
- Enrich pool metadata for LLM #2 as backup filtering
- **Tradeoff**: The false-positive / edge-case problem we discussed, but scoped to specific constraint types rather than all queries. Could be opt-in (only activate when high-confidence match found).

### Direction E: Post-selection re-query for constraint validation
- After LLM #2 selects cards, re-fetch each selected card from Scryfall WITH the user's constraint as a filter
- If a card doesn't exist in the constrained search, drop it from results
- Example: user says "only Lorwyn Eclipsed" → for each selected card, query `!"Card Name" s:lre` → if 0 results, the card doesn't have a Lorwyn Eclipsed printing, so exclude it
- **Tradeoff**: Adds N Scryfall API calls (one per selected card, max 10), but provides deterministic constraint enforcement as a final gate. Still requires knowing the right set code, but only needs to resolve it once rather than per-query.

## Key Files

- `docs/js/engine.js` — recommendation pipeline, all 3 prompt builders, pool merging
  - `suggestRecommendations()`: line 48
  - `buildQueryPrompt()`: line 230
  - `buildSelectionPrompt()`: line 272
  - `fetchScryfallPool()`: line 359
  - `mergeCardPool()`: line 429
  - `filterEdhrecPool()`: line 382
- `docs/js/scryfall.js` — Scryfall API wrapper
  - `searchCards()`: line 56
  - `parseCard()`: line 164 (currently missing set_name, rarity, artist)
- `docs/js/api.js` — LLM routing (line 1)

## Scryfall Capabilities (for reference)

Scryfall's search syntax supports precise filtering that the LLM struggles to generate:
- `s:lre` — exact set code filter (requires knowing the code)
- `name:/ism$/` — regex on card names
- `b:ktk` — block filter (includes all sets in a block)
- `a:"Seb McKinnon"` — artist filter
- `r:mythic` — rarity filter
- `year:2024` — release year filter

The Scryfall `/sets` API (`GET /sets`) returns every set with code, name, set_type, block info, and release date. Could be used for deterministic set resolution.
