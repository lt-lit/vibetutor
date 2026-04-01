/**
 * sections.js — Collapsible section system
 * Handles expand/collapse, arrow indicators, badges, and summary lines.
 */

const ARROW_EXPANDED = '\u25BC';  // ▼
const ARROW_COLLAPSED = '\u25B6'; // ▶

/**
 * Initialize all collapsible sections.
 */
export function initSections() {
  const sections = document.querySelectorAll('.section');
  sections.forEach(section => {
    const header = section.querySelector('.section-header');
    header.addEventListener('click', () => toggleSection(section));
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSection(section);
      }
    });
  });
}

/**
 * Toggle a section's expanded/collapsed state.
 * @param {HTMLElement} section
 */
export function toggleSection(section) {
  const isCollapsed = section.classList.contains('collapsed');
  if (isCollapsed) {
    expandSection(section);
  } else {
    collapseSection(section);
  }
}

/**
 * Expand a section.
 * @param {HTMLElement|string} sectionOrId — element or section name (e.g. 'strategy')
 */
export function expandSection(sectionOrId) {
  const section = resolveSection(sectionOrId);
  if (!section) return;

  section.classList.remove('collapsed');
  const header = section.querySelector('.section-header');
  const content = section.querySelector('.section-content');
  const arrow = section.querySelector('.section-arrow');

  header.setAttribute('aria-expanded', 'true');
  content.hidden = false;
  arrow.textContent = ARROW_EXPANDED;
}

/**
 * Collapse a section.
 * @param {HTMLElement|string} sectionOrId
 */
export function collapseSection(sectionOrId) {
  const section = resolveSection(sectionOrId);
  if (!section) return;

  section.classList.add('collapsed');
  const header = section.querySelector('.section-header');
  const content = section.querySelector('.section-content');
  const arrow = section.querySelector('.section-arrow');

  header.setAttribute('aria-expanded', 'false');
  content.hidden = true;
  arrow.textContent = ARROW_COLLAPSED;
}

/**
 * Update a section's badge text.
 * @param {string} sectionName
 * @param {string} text
 */
export function updateBadge(sectionName, text) {
  const badge = document.getElementById(`${sectionName}-badge`);
  if (badge) badge.textContent = text;
}

/**
 * Update a section's collapsed summary text.
 * @param {string} sectionName
 * @param {string} text
 */
export function updateSummary(sectionName, text) {
  const summary = document.getElementById(`${sectionName}-summary`);
  if (summary) summary.textContent = text;
}

/**
 * Check if a section is currently expanded.
 * @param {string} sectionName
 * @returns {boolean}
 */
export function isSectionExpanded(sectionName) {
  const section = document.getElementById(`section-${sectionName}`);
  return section ? !section.classList.contains('collapsed') : false;
}

/**
 * Resolve a section reference to an element.
 * @param {HTMLElement|string} sectionOrId
 * @returns {HTMLElement|null}
 */
function resolveSection(sectionOrId) {
  if (typeof sectionOrId === 'string') {
    return document.getElementById(`section-${sectionOrId}`);
  }
  return sectionOrId;
}
