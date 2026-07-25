/* =============================================================
   MERIDIAN — Transactions page
   Script: pages/transactions.js
   Loaded as a module by transactions.html only. Handles:
     1. Auth guard + shared header wiring (greeting avatar,
        notification badge, user menu, mobile nav toggle, log out
        — deferred until the app-navbar component, loaded
        separately by components.js, has actually landed in the
        DOM; see waitForNavbar() below)
     2. Loading the user's accounts and building the account /
        currency filter options from real data
     3. Fetching + merging transactions across one or all accounts
     4. Client-side search, currency filter, day-grouping, and
        incremental "load more" pagination
     5. Month-to-date summary (money in / out / net / pending)
     6. Row selection → detail panel (sidebar on desktop, bottom
        sheet on mobile — see transactions.css)
     7. CSV export of the currently filtered result set
   ============================================================= */

import { requireAuth, signOutUser } from '../supabase/auth.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getTransactions,
} from '../supabase/database.js';
import { formatCurrency, $, $$, debounce, getInitials } from '../assets/js/utils.js';

/* -----------------------------------------------------------
   Constants & state
   ----------------------------------------------------------- */
const FETCH_LIMIT_STEP = 60;     // per-account rows fetched from the server per "page"
const VISIBLE_STEP = 20;         // rows revealed per "Load more" click, client-side

const state = {
  accounts: [],
  ownAccountIds: new Set(),
  fetchLimit: FETCH_LIMIT_STEP,
  visibleCount: VISIBLE_STEP,
  merged: [],
  filtered: [],
  selectedId: null,
  loading: false,
};

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);

  if (isSameDay(date, now)) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  if (date > weekAgo) return 'This week';
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function rowTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (isSameDay(date, now)) return timePart;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${timePart}`;
}

function fullTimestamp(isoString) {
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function statusPillClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'completed') return 'status-pill--verified';
  if (s === 'failed') return 'status-pill--blocked';
  if (s === 'pending' || s === 'processing') return 'status-pill--pending';
  return 'status-pill--neutral';
}

function typeLabel(type) {
  return String(type || 'transaction').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const ICON_IN = '<path d="M10 17V3M4 9l6-6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_OUT = '<rect x="3" y="6" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>';

function directionFor(tx) {
  if (state.ownAccountIds.has(tx.sender_account)) return 'out';
  if (state.ownAccountIds.has(tx.receiver_account)) return 'in';
  return 'out';
}

function waitForNavbar() {
  return new Promise((resolve) => {
    if ($('.app-user-menu')) {
      resolve();
      return;
    }
    document.addEventListener('component:loaded', () => resolve(), { once: true });
  });
}

async function populateUserChrome() {
  const { data: profile } = await getMyProfile();
  const fullName = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : '';

  const nameEl = $('.app-user-name');
  const avatarEl = $('.avatar-initial--sm');
  if (nameEl && fullName) nameEl.textContent = fullName;
  if (avatarEl) avatarEl.textContent = getInitials(fullName || 'Meridian User');

  const { data: count } = await getUnreadNotificationCount();
  const badge = $('.app-icon-btn-badge');
  if (badge) {
    if (count) {
      badge.hidden = false;
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
    }
  }
}

function initUserMenu() {
  const menu = $('.app-user-menu');
  const trigger = $('.app-user-trigger', menu);
  if (!menu || !trigger) return;

  function open() {
    menu.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeydown);
  }
  function close() {
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', handleOutsideClick);
    document.removeEventListener('keydown', handleKeydown);
  }
  function handleOutsideClick(event) {
    if (!menu.contains(event.target)) close();
  }
  function handleKeydown(event) {
    if (event.key === 'Escape') { close(); trigger.focus(); }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
}

/* -----------------------------------------------------------
   Mobile nav toggle — wires up the hamburger (.app-nav-toggle) in
   the shared app-navbar partial. Existed in dashboard.js but was
   missing from every other page script sharing the same header
   component (accounts.js had the same gap) — the button renders
   fine since it's part of app-navbar.html, but without this
   nothing ever listens for its click.
   ----------------------------------------------------------- */
function initMobileNav() {
  const toggle = $('.app-nav-toggle');
  const nav = $('.app-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-mobile-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  nav.addEventListener('click', (event) => {
    if (event.target.tagName === 'A') {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('click', (event) => {
    if (!nav.classList.contains('is-mobile-open')) return;
    if (!nav.contains(event.target) && !toggle.contains(event.target)) {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

function initLogout() {
  const logoutLink = $('.app-user-dropdown a[href="../index.html"]');
  if (!logoutLink) return;
  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    await signOutUser();
    window.location.href = logoutLink.getAttribute('href');
  });
}

function showToast(message, variant = 'default') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast${variant === 'error' ? ' toast--error' : ''}`;
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4000);
}

function populateFilterOptions() {
  const accountSelect = $('#tx-filter-account');
  const currencySelect = $('#tx-filter-currency');

  state.accounts.forEach((account) => {
    const opt = document.createElement('option');
    opt.value = account.id;
    opt.textContent = `${account.currency} account · ${maskTail(account)}`;
    accountSelect.appendChild(opt);
  });

  const currencies = [...new Set(state.accounts.map((a) => a.currency))].sort();
  currencies.forEach((code) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code;
    currencySelect.appendChild(opt);
  });
}

function maskTail(account) {
  const raw = account.account_number || account.iban || '';
  const digits = String(raw).replace(/\s+/g, '');
  return digits ? `···· ${digits.slice(-4)}` : account.currency;
}

function currentFilters() {
  return {
    accountId: $('#tx-filter-account').value,
    type: $('#tx-filter-type').value,
    status: $('#tx-filter-status').value,
    currency: $('#tx-filter-currency').value,
    from: $('#tx-filter-from').value,
    to: $('#tx-filter-to').value,
    search: $('#tx-search-input').value.trim().toLowerCase(),
  };
}

function accountIdsForFilter(filters) {
  if (filters.accountId === 'all') return state.accounts.map((a) => a.id);
  return [filters.accountId];
}

async function loadTransactions({ resetFetchLimit = true, resetVisible = true } = {}) {
  if (state.loading) return;
  state.loading = true;

  if (resetFetchLimit) state.fetchLimit = FETCH_LIMIT_STEP;
  if (resetVisible) state.visibleCount = VISIBLE_STEP;

  renderSkeleton();

  const filters = currentFilters();
  const accountIds = accountIdsForFilter(filters);

  if (!accountIds.length) {
    state.merged = [];
    applyClientFilters();
    state.loading = false;
    return;
  }

  const serverParams = {
    type: filters.type,
    status: filters.status,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
    limit: state.fetchLimit,
  };

  try {
    const results = await Promise.all(
      accountIds.map((id) => getTransactions(id, serverParams))
    );

    const anyError = results.find((r) => r.error);
    if (anyError && results.every((r) => r.error)) {
      renderError(anyError.error);
      state.loading = false;
      return;
    }

    const byId = new Map();
    results.forEach(({ data }) => {
      (data || []).forEach((tx) => {
        if (!byId.has(tx.id)) byId.set(tx.id, tx);
      });
    });

    state.merged = Array.from(byId.values()).sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    applyClientFilters();
  } catch (err) {
    renderError(err.message || 'Something went wrong loading transactions.');
  } finally {
    state.loading = false;
  }
}

function applyClientFilters() {
  const filters = currentFilters();

  let list = state.merged;

  if (filters.currency !== 'all') {
    list = list.filter((tx) => tx.currency === filters.currency);
  }

  if (filters.search) {
    list = list.filter((tx) => {
      const haystack = [
        tx.description,
        tx.transaction_reference,
        tx.transaction_type,
        String(tx.amount),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(filters.search);
    });
  }

  state.filtered = list;

  if (!state.selectedId && list.length) {
    state.selectedId = list[0].id;
  }

  renderList();
  renderDetail();
}

function renderSkeleton() {
  const body = $('#tx-list-body');
  body.innerHTML = `
    <div class="tx-day-group" data-skeleton>
      <div class="tx-day-heading skeleton" style="width:90px;height:14px;"></div>
      <ul class="tx-list">
        ${Array.from({ length: 4 }).map(() => `
          <li class="tx-row tx-row--skeleton">
            <span class="tx-icon skeleton"></span>
            <div class="tx-row-main">
              <strong class="skeleton" style="width:60%;height:14px;display:block;margin-bottom:6px;"></strong>
              <span class="skeleton" style="width:40%;height:11px;display:block;"></span>
            </div>
            <span class="skeleton" style="width:64px;height:20px;border-radius:999px;"></span>
            <span class="skeleton" style="width:80px;height:20px;border-radius:999px;"></span>
            <span class="skeleton" style="width:70px;height:14px;"></span>
            <span class="skeleton" style="width:50px;height:12px;"></span>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
  $('#tx-list-count').textContent = '';
  $('#tx-load-more-btn').hidden = true;
}

function renderError(message) {
  const body = $('#tx-list-body');
  body.innerHTML = `
    <div class="tx-error-state">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="1.4"/><path d="M12 7.5v6M12 16.5h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <strong>Couldn't load transactions</strong>
      <p>${escapeHtml(message)}</p>
      <button type="button" class="btn btn-ghost btn-sm" id="tx-retry-btn" style="margin-top:1rem;">Try again</button>
    </div>
  `;
  $('#tx-load-more-btn').hidden = true;
  $('#tx-list-count').textContent = '';
  const retryBtn = $('#tx-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', () => loadTransactions());
}

function renderList() {
  const body = $('#tx-list-body');
  const countEl = $('#tx-list-count');
  const loadMoreBtn = $('#tx-load-more-btn');

  if (!state.filtered.length) {
    body.innerHTML = `
      <div class="tx-empty-state">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 9.5h17" stroke="currentColor" stroke-width="1.4"/></svg>
        <strong>No transactions found</strong>
        <p>Try widening your filters or search terms.</p>
      </div>
    `;
    countEl.textContent = '';
    loadMoreBtn.hidden = true;
    return;
  }

  const visible = state.filtered.slice(0, state.visibleCount);

  const groups = [];
  const groupIndex = new Map();
  visible.forEach((tx) => {
    const label = dayLabel(tx.created_at);
    if (!groupIndex.has(label)) {
      groupIndex.set(label, groups.length);
      groups.push({ label, items: [] });
    }
    groups[groupIndex.get(label)].items.push(tx);
  });

  body.innerHTML = groups.map((group) => `
    <div class="tx-day-group">
      <h2 class="tx-day-heading">${escapeHtml(group.label)}</h2>
      <ul class="tx-list">
        ${group.items.map((tx) => rowMarkup(tx)).join('')}
      </ul>
    </div>
  `).join('');

  $$('.tx-row[data-tx-id]', body).forEach((row) => {
    row.addEventListener('click', () => selectTransaction(row.getAttribute('data-tx-id')));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTransaction(row.getAttribute('data-tx-id'));
      }
    });
  });

  const showingCount = Math.min(state.visibleCount, state.filtered.length);
  countEl.textContent = `Showing ${showingCount} of ${state.filtered.length} transaction${state.filtered.length === 1 ? '' : 's'}`;

  const moreOnServerPossible = state.filtered.length >= state.fetchLimit * accountIdsForFilter(currentFilters()).length;
  loadMoreBtn.hidden = !(state.visibleCount < state.filtered.length || moreOnServerPossible);
}

function rowMarkup(tx) {
  const direction = directionFor(tx);
  const isIn = direction === 'in';
  const amountText = `${isIn ? '+' : '−'}${formatCurrency(Math.abs(Number(tx.amount) || 0), tx.currency)}`;

  return `
    <li class="tx-row${tx.id === state.selectedId ? ' is-selected' : ''}" data-tx-id="${tx.id}" tabindex="0" role="button" aria-pressed="${tx.id === state.selectedId}">
      <span class="tx-icon ${isIn ? 'tx-icon--in' : 'tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${isIn ? ICON_IN : ICON_OUT}</svg>
      </span>
      <div class="tx-row-main">
        <strong>${escapeHtml(tx.description || tx.transaction_reference || 'Transaction')}</strong>
        <span>${escapeHtml(typeLabel(tx.transaction_type))} · Ref ${escapeHtml(tx.transaction_reference || '—')}</span>
      </div>
      <span class="tag">${escapeHtml(typeLabel(tx.transaction_type))}</span>
      <span class="status-pill ${statusPillClass(tx.status)}">${escapeHtml(tx.status || 'Unknown')}</span>
      <span class="amt${isIn ? ' pos' : ''}">${amountText}</span>
      <time>${rowTime(tx.created_at)}</time>
    </li>
  `;
}

function selectTransaction(id) {
  state.selectedId = id;
  $$('.tx-row[data-tx-id]').forEach((row) => {
    const active = row.getAttribute('data-tx-id') === id;
    row.classList.toggle('is-selected', active);
    row.setAttribute('aria-pressed', String(active));
  });
  renderDetail();
  openDetailPanelOnMobile();
}

function renderDetail() {
  const content = $('#tx-detail-content');
  const tx = state.filtered.find((t) => t.id === state.selectedId);

  if (!tx) {
    content.className = 'tx-detail-empty';
    content.innerHTML = '<p>Select a transaction to see the full details here.</p>';
    return;
  }

  const direction = directionFor(tx);
  const isIn = direction === 'in';
  const amountText = `${isIn ? '+' : '−'}${formatCurrency(Math.abs(Number(tx.amount) || 0), tx.currency)}`;
  const senderAccount = state.accounts.find((a) => a.id === tx.sender_account);
  const receiverAccount = state.accounts.find((a) => a.id === tx.receiver_account);

  content.className = '';
  content.innerHTML = `
    <div class="tx-detail-head">
      <span class="tx-icon ${isIn ? 'tx-icon--in' : 'tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${isIn ? ICON_IN : ICON_OUT}</svg>
      </span>
      <div>
        <strong>${escapeHtml(tx.description || tx.transaction_reference || 'Transaction')}</strong>
        <span class="status-pill ${statusPillClass(tx.status)}">${escapeHtml(tx.status || 'Unknown')}</span>
      </div>
    </div>

    <div class="tx-detail-amount amt${isIn ? ' pos' : ''}">${amountText}</div>

    <dl class="tx-detail-list">
      <div><dt>Reference</dt><dd>${escapeHtml(tx.transaction_reference || '—')}
        <button type="button" class="copy-btn" data-copy="${escapeHtml(tx.transaction_reference || '')}" aria-label="Copy reference">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 10.5v-7A1 1 0 0 1 3.5 2.5h7" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </dd></div>
      <div><dt>Type</dt><dd>${escapeHtml(typeLabel(tx.transaction_type))}</dd></div>
      ${senderAccount ? `<div><dt>From</dt><dd>${escapeHtml(senderAccount.currency)} account ${escapeHtml(maskTail(senderAccount))}</dd></div>` : ''}
      ${receiverAccount ? `<div><dt>To account</dt><dd>${escapeHtml(receiverAccount.currency)} account ${escapeHtml(maskTail(receiverAccount))}</dd></div>` : ''}
      <div><dt>Fee</dt><dd>${formatCurrency(Number(tx.fee) || 0, tx.currency)}</dd></div>
      <div><dt>Date</dt><dd>${fullTimestamp(tx.created_at)}</dd></div>
      ${tx.description ? `<div><dt>Description</dt><dd>${escapeHtml(tx.description)}</dd></div>` : ''}
    </dl>

    <div class="tx-detail-actions">
      <button type="button" class="btn btn-ghost btn-block" id="tx-detail-report">Report a problem</button>
    </div>
  `;

  const copyBtn = $('.copy-btn', content);
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const ref = copyBtn.getAttribute('data-copy');
      if (!ref) return;
      try {
        await navigator.clipboard.writeText(ref);
        showToast('Reference copied to clipboard.');
      } catch (err) {
        showToast('Could not copy — please copy it manually.', 'error');
      }
    });
  }

  const reportBtn = $('#tx-detail-report', content);
  if (reportBtn) {
    reportBtn.addEventListener('click', () => showToast('Your report has been sent to support.'));
  }
}

function initDetailPanelMobileControls() {
  const panel = $('#tx-detail-panel');
  const scrim = $('#tx-detail-scrim');
  const closeBtn = $('#tx-detail-close');

  function close() {
    panel.classList.remove('is-open');
    scrim.classList.remove('is-open');
    scrim.hidden = true;
  }

  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) close();
  });

  panel._close = close;
}

function openDetailPanelOnMobile() {
  if (window.innerWidth > 1080) return;
  const panel = $('#tx-detail-panel');
  const scrim = $('#tx-detail-scrim');
  panel.classList.add('is-open');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
}

async function loadSummary() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  try {
    const results = await Promise.all(
      state.accounts.map((account) =>
        getTransactions(account.id, { from: monthStart.toISOString(), limit: 500 }).then((res) => ({
          accountId: account.id,
          currency: account.currency,
          data: res.data || [],
        }))
      )
    );

    let moneyIn = 0;
    let moneyOut = 0;
    let pendingCount = 0;
    const seenIds = new Set();

    results.forEach(({ accountId, data }) => {
      data.forEach((tx) => {
        if (tx.sender_account === accountId) {
          moneyOut += Number(tx.amount) + Number(tx.fee || 0);
        }
        if (tx.receiver_account === accountId) {
          moneyIn += Number(tx.amount);
        }
        if (!seenIds.has(tx.id)) {
          seenIds.add(tx.id);
          const s = (tx.status || '').toLowerCase();
          if (s === 'pending' || s === 'processing') pendingCount += 1;
        }
      });
    });

    const displayCurrency = state.accounts[0]?.currency || 'USD';
    $('#tx-summary-in').textContent = `+${formatCurrency(moneyIn, displayCurrency)}`;
    $('#tx-summary-in').classList.remove('skeleton');
    $('#tx-summary-out').textContent = `−${formatCurrency(moneyOut, displayCurrency)}`;
    $('#tx-summary-out').classList.remove('skeleton');

    const net = moneyIn - moneyOut;
    const netEl = $('#tx-summary-net');
    netEl.textContent = `${net >= 0 ? '+' : '−'}${formatCurrency(Math.abs(net), displayCurrency)}`;
    netEl.classList.toggle('pos', net >= 0);
    netEl.classList.remove('skeleton');

    const pendingEl = $('#tx-summary-pending');
    pendingEl.textContent = `${pendingCount} transaction${pendingCount === 1 ? '' : 's'}`;
    pendingEl.classList.remove('skeleton');
  } catch (err) {
    ['#tx-summary-in', '#tx-summary-out', '#tx-summary-net', '#tx-summary-pending'].forEach((sel) => {
      const el = $(sel);
      el.textContent = '—';
      el.classList.remove('skeleton');
    });
  }
}

function exportCsv() {
  if (!state.filtered.length) {
    showToast('No transactions to export for the current filters.', 'error');
    return;
  }

  const headers = ['Date', 'Description', 'Reference', 'Type', 'Status', 'Direction', 'Amount', 'Fee', 'Currency'];
  const rows = state.filtered.map((tx) => {
    const direction = directionFor(tx);
    return [
      new Date(tx.created_at).toISOString(),
      tx.description || '',
      tx.transaction_reference || '',
      tx.transaction_type || '',
      tx.status || '',
      direction === 'in' ? 'In' : 'Out',
      tx.amount,
      tx.fee || 0,
      tx.currency,
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function initFilters() {
  const serverFilterIds = ['#tx-filter-account', '#tx-filter-type', '#tx-filter-status', '#tx-filter-from', '#tx-filter-to'];
  serverFilterIds.forEach((id) => {
    $(id).addEventListener('change', () => {
      state.selectedId = null;
      loadTransactions();
    });
  });

  $('#tx-filter-currency').addEventListener('change', () => {
    applyClientFilters();
  });

  const debouncedSearch = debounce(() => applyClientFilters(), 250);
  $('#tx-search-input').addEventListener('input', debouncedSearch);

  $('#tx-filter-reset').addEventListener('click', () => {
    $('#tx-filter-account').value = 'all';
    $('#tx-filter-type').value = 'all';
    $('#tx-filter-status').value = 'all';
    $('#tx-filter-currency').value = 'all';
    $('#tx-filter-from').value = '';
    $('#tx-filter-to').value = '';
    $('#tx-search-input').value = '';
    state.selectedId = null;
    loadTransactions();
  });

  $('#tx-load-more-btn').addEventListener('click', () => {
    if (state.visibleCount < state.filtered.length) {
      state.visibleCount += VISIBLE_STEP;
      renderList();
      return;
    }
    state.fetchLimit += FETCH_LIMIT_STEP;
    state.visibleCount += VISIBLE_STEP;
    loadTransactions({ resetFetchLimit: false, resetVisible: false });
  });

  $('#tx-export-btn').addEventListener('click', exportCsv);
}

(async function init() {
  const user = await requireAuth();
  if (!user) return;

  document.body.classList.remove('auth-pending');

  initDetailPanelMobileControls();

  waitForNavbar().then(() => {
    populateUserChrome();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  const { data: accounts, error } = await getMyAccounts();
  if (error) {
    renderError(error);
    return;
  }

  state.accounts = accounts || [];
  state.ownAccountIds = new Set(state.accounts.map((a) => a.id));

  if (!state.accounts.length) {
    renderList();
    $('#tx-summary-grid').querySelectorAll('.skeleton').forEach((el) => {
      el.textContent = '—';
      el.classList.remove('skeleton');
    });
    return;
  }

  populateFilterOptions();
  initFilters();

  await Promise.all([loadTransactions(), loadSummary()]);
})();
