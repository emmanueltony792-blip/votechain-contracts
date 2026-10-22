/**
 * VoteChain — Proposals page
 *
 * Renders governance proposals with state badges, vote summaries,
 * countdown timers for active proposals, and paginated navigation.
 *
 * Data source: fetched from the backend GET /api/proposals endpoint,
 * which in turn reads from the Stellar RPC / indexer.
 * Proposals are refreshed automatically every 30 seconds when any
 * Active proposal is present in the current view.
 */

'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────

const PAGE_SIZE          = 10;   // proposals per page
const REFRESH_INTERVAL   = 30_000; // ms — auto-refresh when active proposals exist
const API_ENDPOINT       = '/api/proposals';

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Array<object>} Live proposal data fetched from the backend API. */
let proposals       = [];

let currentPage     = 1;
let activeFilter    = 'all';
let searchQuery     = '';
let countdownTimers = [];
let refreshTimer    = null;

// ── API fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch all proposals from the backend GET /api/proposals endpoint.
 * Handles loading state, error state, and pagination from on-chain count.
 *
 * @returns {Promise<void>}
 */
async function fetchProposals() {
  const list       = document.getElementById('proposal-list');
  const errorState = document.getElementById('error-state');
  const skeleton   = document.getElementById('skeleton-state');

  // Show skeleton loader while fetching
  if (skeleton) skeleton.hidden = false;
  if (list)     list.hidden     = true;
  if (errorState) errorState.hidden = true;

  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Accept either a plain array or { proposals: [...], total: N }
    proposals = Array.isArray(data) ? data : (data.proposals ?? []);

    // Reset to page 1 on fresh load so we don't land on a now-empty page
    currentPage = 1;
    if (skeleton) skeleton.hidden = true;
    if (list)     list.hidden     = false;

    render();
    scheduleAutoRefresh();
  } catch (err) {
    console.error('[VoteChain] fetchProposals error:', err);

    if (skeleton)   skeleton.hidden   = true;
    if (list)       list.hidden       = true;
    if (errorState) {
      errorState.hidden = false;
      const msg = errorState.querySelector('#error-message');
      if (msg) msg.textContent = `Could not load proposals: ${err.message}`;
    }
  }
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

/**
 * Schedule (or re-schedule) an automatic refresh every REFRESH_INTERVAL ms
 * if the current page contains any Active proposals.
 * Clears the timer when no Active proposals are visible.
 */
function scheduleAutoRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;

  const hasActive = proposals.some(p => p.state === 'Active');
  if (hasActive) {
    refreshTimer = setTimeout(() => {
      fetchProposals();
    }, REFRESH_INTERVAL);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a large number with locale-aware thousands separators.
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return n.toLocaleString();
}

/**
 * Truncate a Stellar address to first 6 + last 4 characters.
 * @param {string} addr
 * @returns {string}
 */
function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Return seconds remaining until a Unix timestamp.
 * @param {number} endTime  Unix timestamp (seconds)
 * @returns {number}
 */
function secondsUntil(endTime) {
  return Math.max(0, endTime - Math.floor(Date.now() / 1000));
}

/**
 * Format a duration in seconds as a human-readable string.
 * @param {number} secs
 * @returns {string}
 */
function formatDuration(secs) {
  if (secs <= 0) return 'Ended';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h remaining`;
  if (h > 0) return `${h}h ${m}m remaining`;
  if (m > 0) return `${m}m ${s}s remaining`;
  return `${s}s remaining`;
}

/**
 * Return true if fewer than 1 hour remains (used to apply "ending soon" style).
 * @param {number} secs
 * @returns {boolean}
 */
function isEndingSoon(secs) {
  return secs > 0 && secs < 3600;
}

/**
 * Map a proposal state string to a CSS class suffix.
 * @param {string} state
 * @returns {string}
 */
function badgeClass(state) {
  return `badge-${state.toLowerCase()}`;
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function filteredProposals() {
  return proposals.filter(p => {
    const matchesFilter = activeFilter === 'all' || p.state.toLowerCase() === activeFilter;
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q
      || p.title.toLowerCase().includes(q)
      || String(p.id).includes(q)
      || p.proposer.toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Build the HTML for a single proposal card.
 * @param {object} p  Proposal object
 * @returns {string}  HTML string
 */
function renderCard(p) {
  const total = p.votes_yes + p.votes_no + p.votes_abstain;
  const yesP  = total > 0 ? (p.votes_yes     / total * 100).toFixed(1) : 0;
  const noP   = total > 0 ? (p.votes_no      / total * 100).toFixed(1) : 0;
  const absP  = total > 0 ? (p.votes_abstain / total * 100).toFixed(1) : 0;

  const isActive   = p.state === 'Active';
  const secs       = isActive ? secondsUntil(p.end_time) : 0;
  const endingSoon = isActive && isEndingSoon(secs);

  const countdownHtml = isActive ? `
    <span class="countdown${endingSoon ? ' ending-soon' : ''}" data-end="${p.end_time}" aria-label="Time remaining: ${formatDuration(secs)}">
      <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.4"/>
        <path d="M7 4v3l2 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <span class="countdown-text">${formatDuration(secs)}</span>
    </span>` : '';

  const quorumMet = total >= p.quorum;
  const quorumPct = p.quorum > 0 ? Math.min(100, (total / p.quorum * 100)).toFixed(0) : 0;

  return `
    <li class="proposal-card" role="article" aria-label="Proposal ${p.id}: ${escapeHtml(p.title)}">
      <div class="card-header">
        <div class="card-title-row">
          <div class="proposal-id" aria-label="Proposal ID">#${p.id}</div>
          <h2 class="proposal-title">${escapeHtml(p.title)}</h2>
        </div>
        <span class="state-badge ${badgeClass(p.state)}" role="status" aria-label="Status: ${p.state}">
          ${p.state}
        </span>
      </div>

      <div class="vote-summary" aria-label="Vote summary">
        <div class="vote-bar-wrap" role="img" aria-label="Yes ${yesP}%, No ${noP}%, Abstain ${absP}%">
          <div class="vote-bar-yes"     style="width:${yesP}%"></div>
          <div class="vote-bar-no"      style="width:${noP}%"></div>
          <div class="vote-bar-abstain" style="width:${absP}%"></div>
        </div>
        <div class="vote-counts">
          <span class="vote-count-item">
            <span class="vote-dot dot-yes" aria-hidden="true"></span>
            Yes <strong>${fmt(p.votes_yes)}</strong>
          </span>
          <span class="vote-count-item">
            <span class="vote-dot dot-no" aria-hidden="true"></span>
            No <strong>${fmt(p.votes_no)}</strong>
          </span>
          <span class="vote-count-item">
            <span class="vote-dot dot-abstain" aria-hidden="true"></span>
            Abstain <strong>${fmt(p.votes_abstain)}</strong>
          </span>
        </div>
      </div>

      <div class="card-footer">
        <span class="proposer-info">
          <span class="proposer-label">Proposer</span>
          <span class="proposer-address" title="${escapeHtml(p.proposer)}">${truncateAddress(p.proposer)}</span>
        </span>
        <span class="quorum-info" aria-label="Quorum ${quorumPct}% of ${fmt(p.quorum)} required${quorumMet ? ', met' : ', not yet met'}">
          Quorum ${quorumPct}%${quorumMet ? ' ✓' : ''}
        </span>
        ${countdownHtml}
      </div>
    </li>`;
}

/**
 * Escape HTML special characters to prevent XSS.
 *
 * Issue #320: When DOMPurify is available (bundled build), use it for
 * defence-in-depth.  The manual escape remains as a fallback for the
 * non-bundled `proposals.js` script loaded from index.html.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  // DOMPurify available (bundled build) — strip all HTML tags.
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(str, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  }
  // Manual fallback for the non-bundled script.
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Countdown tick ─────────────────────────────────────────────────────────────

function tickCountdowns() {
  document.querySelectorAll('.countdown[data-end]').forEach(el => {
    const endTime = parseInt(el.dataset.end, 10);
    const secs    = secondsUntil(endTime);
    const text    = el.querySelector('.countdown-text');
    if (text) text.textContent = formatDuration(secs);
    el.setAttribute('aria-label', `Time remaining: ${formatDuration(secs)}`);
    if (isEndingSoon(secs)) {
      el.classList.add('ending-soon');
    } else {
      el.classList.remove('ending-soon');
    }
  });
}

// ── Render page ────────────────────────────────────────────────────────────────

function render() {
  // Clear existing countdown intervals
  countdownTimers.forEach(clearInterval);
  countdownTimers = [];

  const list       = document.getElementById('proposal-list');
  const emptyState = document.getElementById('empty-state');
  const prevBtn    = document.getElementById('prev-btn');
  const nextBtn    = document.getElementById('next-btn');
  const pageInfo   = document.getElementById('page-info');
  const liveRegion = document.getElementById('live-region');

  const filtered   = filteredProposals();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // Clamp current page
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = filtered.slice(start, start + PAGE_SIZE);

  if (page.length === 0) {
    list.innerHTML = '';
    emptyState.hidden = false;
    liveRegion.textContent = 'No proposals match your filter.';
  } else {
    emptyState.hidden = true;
    list.innerHTML = page.map(renderCard).join('');
    liveRegion.textContent = `Showing ${page.length} proposal${page.length !== 1 ? 's' : ''}.`;
  }

  // Pagination controls
  pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;

  // Start countdown ticker for active proposals
  if (page.some(p => p.state === 'Active')) {
    const timer = setInterval(tickCountdowns, 1000);
    countdownTimers.push(timer);
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    // Set correct initial aria-pressed state so screen readers know which
    // filter is active on page load (fixes issue #14).
    const isInitiallyActive = btn.dataset.filter === activeFilter;
    btn.classList.toggle('active', isInitiallyActive);
    btn.setAttribute('aria-pressed', String(isInitiallyActive));

    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      currentPage  = 1;

      // Update aria-pressed on all buttons
      document.querySelectorAll('.filter-btn').forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });

      render();
    });

    // Support keyboard activation via Enter / Space (issue #14).
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });
  });

  // Search input — debounced
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      currentPage = 1;
      render();
    }, 250);
  });

  // Pagination
  document.getElementById('prev-btn').addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    const total = Math.ceil(filteredProposals().length / PAGE_SIZE);
    if (currentPage < total) { currentPage++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  // Retry button in error state
  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => fetchProposals());
  }

  // ── Theme toggle ─────────────────────────────────────────────────────────────
  const themeToggle = document.getElementById('theme-toggle');

  function updateThemeToggleUI(isDark) {
    if (!themeToggle) return;
    themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    themeToggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.innerHTML = isDark
      ? `<svg class="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2"></path><path d="M12 20v2"></path>
          <path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path>
          <path d="M2 12h2"></path><path d="M20 12h2"></path>
          <path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>
        </svg>`
      : `<svg class="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
        </svg>`;
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      updateThemeToggleUI(isDark);
    });
    updateThemeToggleUI(document.documentElement.classList.contains('dark'));
  }

  // Initial data load — replaces the old synchronous render() call
  fetchProposals();
});
