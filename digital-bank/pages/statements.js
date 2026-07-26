/* =============================================================
   MERIDIAN — Statements page
   Script: pages/statements.js
   Loaded as a module by statements.html only.

   SCOPING NOTES (read before extending this file):
     - Statements are scoped to ONE account at a time (the account
       selector in the filter panel), not merged across accounts.
       Opening/closing balance only makes clean sense per-account
       given the schema; a cross-account version would need to
       de-duplicate internal transfers the way dashboard.js's
       comment on renderPrimaryAccountSections() already discusses
       for a similar reason.
     - "Category" = transactions.transaction_type. "Merchant" =
       transactions.description. The schema has no dedicated
       category/merchant/location/IP/device/channel columns, so
       those brief items are either mapped onto the closest real
       column (as above) or omitted outright — nothing here
       fabricates data that isn't actually in the database.
     - "Download PDF" opens the browser print dialog scoped to a
       hidden print table (see statements.css's print section) —
       there's no server-side PDF renderer. The button is labelled
       "Print / Save as PDF" so that's honest instead of implied.
     - "Email statement" is a stub (same pattern as profile.js's
       danger-zone actions) — no email provider is wired up yet.
     - Interest earned / investment income are intentionally left
       out of the summary cards per the current scope.

   Sections:
     1. State & constants
     2. Header chrome (navbar wait, user menu, mobile nav, logout)
     3. Toasts
     4. Period + filter handling
     5. Balance calculation (opening/closing via net transaction effect)
     6. Data loading
     7. Summary cards
     8. Cash flow chart
     9. Transaction cards + detail panel
     10. Analytics (category / description breakdown)
     11. Statement generation (CSV / print) + history
     12. Init
   ============================================================= */

import { requireAuth, signOutUser } from '../supabase/auth.js';
import { supabase } from '../supabase/config.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getTransactions,
} from '../supabase/database.js';
import { toastSuccess, toastError, toastInfo } from '../assets/js/notifications.js';
import { $, $$, formatCurrency, formatNumber, debounce, maskAccountNumber } from '../assets/js/utils.js';

/* -----------------------------------------------------------
   1. State & constants
   ----------------------------------------------------------- */
const AFTER_PERIOD_FETCH_LIMIT = 500;   // transactions after period end, used to roll balance back
const WITHIN_PERIOD_FETCH_LIMIT = 500;  // transactions inside the statement period
const VISIBLE_STEP = 20;

const state = {
  user: null,
  accounts: [],
  account: null,          // the currently selected account row
  period: { start: null, end: null, key: 'last-month' },
  filters: { type: 'all', status: 'all', min: '', max: '', reference: '', search: '' },
  periodTransactions: [],  // within the statement period, ascending by created_at
  visibleCount: VISIBLE_STEP,
  openingBalance: 0,
  closingBalance: 0,
  balanceApproximate: false,
  selectedTxId: null,
};

const ICON_IN = '<path d="M10 17V3M4 9l6-6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_OUT = '<rect x="3" y="6" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function typeLabel(type) {
  return String(type || 'transaction').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusPillClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'completed') return 'status-pill--verified';
  if (s === 'failed') return 'status-pill--blocked';
  if (s === 'pending' || s === 'processing') return 'status-pill--pending';
  return 'status-pill--neutral';
}

/* -----------------------------------------------------------
   2. Header chrome
   ----------------------------------------------------------- */
function waitForNavbar() {
  return new Promise((resolve) => {
    if ($('.app-user-menu')) { resolve(); return; }
    document.addEventListener('component:loaded', () => resolve(), { once: true });
  });
}

async function populateHeaderIdentity() {
  const { data: profile } = await getMyProfile();
  const nameEl = $('.app-user-name');
  const avatarEl = $('.app-user-trigger .avatar-initial');
  if (nameEl) nameEl.textContent = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Your account' : 'Your account';
  if (avatarEl) avatarEl.textContent = (profile?.first_name?.[0] || 'M').toUpperCase();

  const badge = $('.app-icon-btn-badge');
  if (badge) {
    const { data: count } = await getUnreadNotificationCount();
    if (count) { badge.textContent = count > 9 ? '9+' : String(count); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  }
}

function initUserMenu() {
  const menu = $('.app-user-menu');
  const trigger = $('.app-user-trigger', menu);
  if (!menu || !trigger) return;
  const open = () => { menu.classList.add('is-open'); trigger.setAttribute('aria-expanded', 'true'); document.addEventListener('click', onOutside); document.addEventListener('keydown', onKey); };
  const close = () => { menu.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', onOutside); document.removeEventListener('keydown', onKey); };
  const onOutside = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); trigger.focus(); } };
  trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.contains('is-open') ? close() : open(); });
}

function initMobileNav() {
  const toggle = $('.app-nav-toggle');
  const nav = $('.app-nav');
  if (!toggle || !nav) return;
  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-mobile-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  nav.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') { nav.classList.remove('is-mobile-open'); toggle.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('click', (e) => {
    if (!nav.classList.contains('is-mobile-open')) return;
    if (!nav.contains(e.target) && !toggle.contains(e.target)) { nav.classList.remove('is-mobile-open'); toggle.setAttribute('aria-expanded', 'false'); }
  });
}

function initLogout() {
  const link = $('#logout-link');
  if (!link) return;
  link.addEventListener('click', async (e) => { e.preventDefault(); await signOutUser(); window.location.href = link.getAttribute('href'); });
}

/* -----------------------------------------------------------
   3. Toasts — reuses the shared .toast-stack; falls back to the
   canonical notifications.js helpers for consistency with the
   rest of the app.
   ----------------------------------------------------------- */
const showSuccess = (msg) => toastSuccess(msg);
const showError = (msg) => toastError(msg);
const showInfo = (msg) => toastInfo(msg);

/* -----------------------------------------------------------
   4. Period + filter handling
   ----------------------------------------------------------- */
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function endOfDay(date) { const d = new Date(date); d.setHours(23, 59, 59, 999); return d; }

function resolvePeriodRange(key) {
  const now = new Date();
  if (key === 'this-month') {
    return { start: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), end: endOfDay(now) };
  }
  if (key === 'last-month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: startOfDay(start), end: endOfDay(end) };
  }
  if (key === 'last-3') return { start: startOfDay(new Date(now.getFullYear(), now.getMonth() - 3, 1)), end: endOfDay(now) };
  if (key === 'last-6') return { start: startOfDay(new Date(now.getFullYear(), now.getMonth() - 6, 1)), end: endOfDay(now) };
  if (key === 'last-12') return { start: startOfDay(new Date(now.getFullYear(), now.getMonth() - 12, 1)), end: endOfDay(now) };
  // custom — read the date inputs directly
  const fromVal = $('#stmt-filter-from').value;
  const toVal = $('#stmt-filter-to').value;
  return {
    start: fromVal ? startOfDay(new Date(fromVal)) : startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    end: toVal ? endOfDay(new Date(toVal)) : endOfDay(now),
  };
}

function periodLabel() {
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  return `${state.period.start.toLocaleDateString('en-US', opts)} – ${state.period.end.toLocaleDateString('en-US', opts)}`;
}

function initPeriodTabs() {
  const tabs = $$('.tab-toggle-btn[data-period]', $('#stmt-period-tabs'));
  const customFields = $('.stmt-filter-custom-dates');

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.period.key = btn.dataset.period;
      customFields.classList.toggle('is-hidden', state.period.key !== 'custom');
      if (state.period.key !== 'custom') {
        state.period = { ...resolvePeriodRange(state.period.key), key: state.period.key };
        refreshAll();
      }
    });
  });

  $('#stmt-filter-from').addEventListener('change', () => { if (state.period.key === 'custom') { state.period = { ...resolvePeriodRange('custom'), key: 'custom' }; refreshAll(); } });
  $('#stmt-filter-to').addEventListener('change', () => { if (state.period.key === 'custom') { state.period = { ...resolvePeriodRange('custom'), key: 'custom' }; refreshAll(); } });
}

function initFilterToggle() {
  const btn = $('#stmt-filter-toggle');
  const grid = $('#stmt-filter-grid');
  let expanded = true;
  btn.addEventListener('click', () => {
    expanded = !expanded;
    grid.classList.toggle('is-hidden', !expanded);
    btn.textContent = expanded ? 'Fewer filters' : 'More filters';
  });
}

function populateAccountOptions() {
  const select = $('#stmt-filter-account');
  select.innerHTML = state.accounts
    .map((a) => `<option value="${a.id}">${a.currency} account · ${maskAccountNumber(a.account_number || a.iban || '')}</option>`)
    .join('');
}

function initFilterInputs() {
  $('#stmt-filter-account').addEventListener('change', (e) => {
    state.account = state.accounts.find((a) => a.id === e.target.value) || state.accounts[0];
    refreshAll();
  });
  $('#stmt-filter-type').addEventListener('change', (e) => { state.filters.type = e.target.value; refreshAll(); });
  $('#stmt-filter-status').addEventListener('change', (e) => { state.filters.status = e.target.value; refreshAll(); });
  $('#stmt-filter-min').addEventListener('input', debounce(() => { state.filters.min = $('#stmt-filter-min').value; applyClientFilters(); }, 300));
  $('#stmt-filter-max').addEventListener('input', debounce(() => { state.filters.max = $('#stmt-filter-max').value; applyClientFilters(); }, 300));
  $('#stmt-filter-reference').addEventListener('input', debounce(() => { state.filters.reference = $('#stmt-filter-reference').value.trim().toLowerCase(); applyClientFilters(); }, 300));
  $('#stmt-search-input').addEventListener('input', debounce(() => { state.filters.search = $('#stmt-search-input').value.trim().toLowerCase(); applyClientFilters(); }, 300));

  $('#stmt-filter-reset').addEventListener('click', () => {
    state.filters = { type: 'all', status: 'all', min: '', max: '', reference: '', search: '' };
    $('#stmt-filter-type').value = 'all';
    $('#stmt-filter-status').value = 'all';
    $('#stmt-filter-min').value = '';
    $('#stmt-filter-max').value = '';
    $('#stmt-filter-reference').value = '';
    $('#stmt-search-input').value = '';
    refreshAll();
  });
}

/* -----------------------------------------------------------
   5. Balance calculation
   -----------------------------------------------------------
   currentBalance comes straight from the account row (accurate,
   real-time). closingBalance rolls that back by every transaction
   that happened AFTER the period end; openingBalance further rolls
   back by every transaction WITHIN the period. Both roll-backs use
   each transaction's net effect on this specific account.
   ----------------------------------------------------------- */
function netEffect(tx, accountId) {
  let net = 0;
  if (tx.sender_account === accountId) net -= (Number(tx.amount) + Number(tx.fee || 0));
  if (tx.receiver_account === accountId) net += Number(tx.amount);
  return net;
}

async function fetchAllPages(accountId, params, limit) {
  const { data, count } = await getTransactions(accountId, { ...params, limit });
  return { data: data || [], truncated: (count || 0) > (data || []).length };
}

async function computeBalances() {
  const account = state.account;
  if (!account) return;

  const currentBalance = Number(account.available_balance ?? account.balance ?? 0);
  const periodEndIso = state.period.end.toISOString();

  const { data: afterPeriodTx, truncated: afterTruncated } = await fetchAllPages(
    account.id,
    { from: periodEndIso },
    AFTER_PERIOD_FETCH_LIMIT
  );
  const afterNet = afterPeriodTx.reduce((sum, tx) => sum + netEffect(tx, account.id), 0);
  const closingBalance = currentBalance - afterNet;

  const periodNet = state.periodTransactions.reduce((sum, tx) => sum + netEffect(tx, account.id), 0);
  const openingBalance = closingBalance - periodNet;

  state.closingBalance = closingBalance;
  state.openingBalance = openingBalance;
  state.balanceApproximate = afterTruncated;
}

/* -----------------------------------------------------------
   6. Data loading
   ----------------------------------------------------------- */
async function loadPeriodTransactions() {
  const account = state.account;
  if (!account) { state.periodTransactions = []; return; }

  const { data, error } = await getTransactions(account.id, {
    type: state.filters.type,
    status: state.filters.status,
    from: state.period.start.toISOString(),
    to: state.period.end.toISOString(),
    limit: WITHIN_PERIOD_FETCH_LIMIT,
  });

  if (error) {
    showError("Couldn't load transactions for this statement.");
    state.periodTransactions = [];
    return;
  }

  // ascending for running-balance math; UI reverses where it needs newest-first
  state.periodTransactions = [...data].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function refreshAll() {
  if (!state.account) return;

  renderHeaderAccount();
  setSummarySkeletons();

  await loadPeriodTransactions();
  await computeBalances();

  applyClientFilters();
  renderSummaryCards();
  renderChart();
  renderAnalytics();
}

/* -----------------------------------------------------------
   Client-side filters (amount range, reference, search) — these
   don't need a re-fetch, just a re-render of what's already loaded.
   ----------------------------------------------------------- */
function filteredTransactions() {
  let list = state.periodTransactions;
  const { min, max, reference, search } = state.filters;

  if (min) list = list.filter((tx) => Number(tx.amount) >= Number(min));
  if (max) list = list.filter((tx) => Number(tx.amount) <= Number(max));
  if (reference) list = list.filter((tx) => (tx.transaction_reference || '').toLowerCase().includes(reference));
  if (search) {
    list = list.filter((tx) => {
      const haystack = [tx.description, tx.transaction_reference, tx.transaction_type, String(tx.amount)].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    });
  }
  return list;
}

function applyClientFilters() {
  state.visibleCount = VISIBLE_STEP;
  renderTransactionCards();
}

/* -----------------------------------------------------------
   7. Summary cards
   ----------------------------------------------------------- */
function setSummarySkeletons() {
  ['stmt-opening-balance', 'stmt-closing-balance', 'stmt-total-credits', 'stmt-total-debits', 'stmt-net-flow', 'stmt-tx-count-card', 'stmt-largest-deposit', 'stmt-largest-withdrawal', 'stmt-avg-transaction', 'stmt-fees-paid']
    .forEach((id) => { const el = $(`#${id}`); if (el) { el.classList.add('skeleton'); el.textContent = 'Loading…'; } });
}

function renderSummaryCards() {
  const account = state.account;
  const currency = account?.currency || 'USD';
  const list = filteredTransactions();

  let credits = 0, debits = 0, fees = 0;
  let largestDeposit = 0, largestWithdrawal = 0;

  list.forEach((tx) => {
    if (tx.receiver_account === account.id) {
      credits += Number(tx.amount);
      largestDeposit = Math.max(largestDeposit, Number(tx.amount));
    }
    if (tx.sender_account === account.id) {
      const outflow = Number(tx.amount) + Number(tx.fee || 0);
      debits += outflow;
      fees += Number(tx.fee || 0);
      largestWithdrawal = Math.max(largestWithdrawal, outflow);
    }
  });

  const netFlow = credits - debits;
  const avgTx = list.length ? (credits + debits) / list.length : 0;

  const setCard = (id, text, cls) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.classList.remove('skeleton');
    if (cls) el.classList.add(cls);
    el.textContent = text;
  };

  setCard('stmt-opening-balance', formatCurrency(state.openingBalance, currency));
  setCard('stmt-closing-balance', formatCurrency(state.closingBalance, currency));
  setCard('stmt-total-credits', `+${formatCurrency(credits, currency)}`);
  setCard('stmt-total-debits', `−${formatCurrency(debits, currency)}`);
  setCard('stmt-net-flow', `${netFlow >= 0 ? '+' : '−'}${formatCurrency(Math.abs(netFlow), currency)}`, netFlow >= 0 ? 'pos' : 'neg');
  setCard('stmt-tx-count-card', String(list.length));
  setCard('stmt-largest-deposit', formatCurrency(largestDeposit, currency));
  setCard('stmt-largest-withdrawal', formatCurrency(largestWithdrawal, currency));
  setCard('stmt-avg-transaction', formatCurrency(avgTx, currency));
  setCard('stmt-fees-paid', formatCurrency(fees, currency));

  $$('.stmt-summary-card').forEach((card, i) => setTimeout(() => card.classList.add('is-visible'), i * 40));

  if (state.balanceApproximate) {
    showInfo('Opening/closing balance is approximate — this account has a lot of history outside the statement period.');
  }
}

function renderHeaderAccount() {
  const account = state.account;
  if (!account) return;

  $('#stmt-account-name').textContent = `${account.currency} account`;
  $('#stmt-account-number').textContent = maskAccountNumber(account.account_number || account.iban || '');
  $('#stmt-account-type').textContent = (account.account_type || 'personal').replace(/\b\w/g, (c) => c.toUpperCase());
  $('#stmt-period-label').textContent = periodLabel();

  const balanceEl = $('#stmt-current-balance');
  balanceEl.classList.remove('skeleton');
  balanceEl.textContent = formatCurrency(account.available_balance ?? account.balance, account.currency);
}

/* -----------------------------------------------------------
   8. Cash flow chart — self-built bars, bucketed by day/week/
   month depending on how wide the period is, so a 12-month
   statement doesn't render 365 razor-thin bars.
   ----------------------------------------------------------- */
function chooseBucketing(start, end) {
  const days = (end - start) / (1000 * 60 * 60 * 24);
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

function bucketKey(date, granularity) {
  if (granularity === 'day') return date.toISOString().slice(0, 10);
  if (granularity === 'week') {
    const d = new Date(date);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function bucketLabel(key, granularity) {
  const d = new Date(key);
  if (granularity === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderChart() {
  const chartEl = $('#stmt-chart');
  const account = state.account;
  const list = filteredTransactions();

  if (!list.length) {
    chartEl.innerHTML = `<div class="stmt-chart-empty">No transactions in this range to chart.</div>`;
    return;
  }

  const granularity = chooseBucketing(state.period.start, state.period.end);
  const buckets = new Map();

  list.forEach((tx) => {
    const key = bucketKey(new Date(tx.created_at), granularity);
    if (!buckets.has(key)) buckets.set(key, { credit: 0, debit: 0 });
    const b = buckets.get(key);
    if (tx.receiver_account === account.id) b.credit += Number(tx.amount);
    if (tx.sender_account === account.id) b.debit += Number(tx.amount) + Number(tx.fee || 0);
  });

  const sortedKeys = Array.from(buckets.keys()).sort();
  const maxValue = Math.max(1, ...sortedKeys.map((k) => Math.max(buckets.get(k).credit, buckets.get(k).debit)));

  chartEl.innerHTML = sortedKeys.map((key) => {
    const { credit, debit } = buckets.get(key);
    const creditPct = Math.max(2, Math.round((credit / maxValue) * 100));
    const debitPct = Math.max(2, Math.round((debit / maxValue) * 100));
    return `
      <div class="stmt-chart-bucket">
        <div class="stmt-chart-bars">
          <div class="stmt-chart-bar stmt-chart-bar--credit" style="height:${credit > 0 ? creditPct : 0}%" title="Credits: ${formatCurrency(credit, account.currency)}"></div>
          <div class="stmt-chart-bar stmt-chart-bar--debit" style="height:${debit > 0 ? debitPct : 0}%" title="Debits: ${formatCurrency(debit, account.currency)}"></div>
        </div>
        <span class="stmt-chart-bucket-label">${escapeHtml(bucketLabel(key, granularity))}</span>
      </div>
    `;
  }).join('');
}

/* -----------------------------------------------------------
   9. Transaction cards + detail panel
   ----------------------------------------------------------- */
function runningBalanceFor(tx) {
  // periodTransactions is ascending; sum net effect up to and
  // including this tx, added to the opening balance.
  const idx = state.periodTransactions.findIndex((t) => t.id === tx.id);
  if (idx === -1) return null;
  let bal = state.openingBalance;
  for (let i = 0; i <= idx; i++) bal += netEffect(state.periodTransactions[i], state.account.id);
  return bal;
}

function txCardMarkup(tx) {
  const account = state.account;
  const isIn = tx.receiver_account === account.id;
  const amountText = `${isIn ? '+' : '−'}${formatCurrency(Math.abs(Number(tx.amount) || 0), tx.currency)}`;
  const running = runningBalanceFor(tx);

  return `
    <article class="stmt-tx-card" data-tx-id="${tx.id}" tabindex="0" role="button">
      <span class="stmt-tx-icon ${isIn ? 'stmt-tx-icon--in' : 'stmt-tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${isIn ? ICON_IN : ICON_OUT}</svg>
      </span>
      <div class="stmt-tx-main">
        <div class="stmt-tx-main-top">
          <strong>${escapeHtml(tx.description || tx.transaction_reference || 'Transaction')}</strong>
          <span class="status-pill ${statusPillClass(tx.status)}">${escapeHtml(tx.status || 'Unknown')}</span>
        </div>
        <div class="stmt-tx-main-sub">
          <span class="tag">${escapeHtml(typeLabel(tx.transaction_type))}</span>
          <span class="dot-sep">Ref ${escapeHtml(tx.transaction_reference || '—')}</span>
          <span class="dot-sep">${new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        </div>
      </div>
      <div class="stmt-tx-side">
        <span class="stmt-tx-amount ${isIn ? 'pos' : ''}">${amountText}</span>
        ${running !== null ? `<span class="stmt-tx-running-balance">Bal ${formatCurrency(running, tx.currency)}</span>` : ''}
      </div>
    </article>
  `;
}

function renderTransactionCards() {
  const grid = $('#stmt-tx-grid');
  const countLabel = $('#stmt-tx-count-label');
  const loadMoreBtn = $('#stmt-load-more-btn');
  const list = filteredTransactions();

  if (!list.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <span class="empty-state-icon">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 8.5h13" stroke="currentColor" stroke-width="1.4"/></svg>
        </span>
        <h3>No transactions found</h3>
        <p>Try widening the date range or clearing some filters.</p>
      </div>
    `;
    countLabel.textContent = '';
    loadMoreBtn.hidden = true;
    return;
  }

  const newestFirst = [...list].reverse();
  const visible = newestFirst.slice(0, state.visibleCount);
  grid.innerHTML = visible.map(txCardMarkup).join('');

  countLabel.textContent = `Showing ${visible.length} of ${list.length}`;
  loadMoreBtn.hidden = state.visibleCount >= list.length;

  $$('.stmt-tx-card[data-tx-id]', grid).forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.txId));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(card.dataset.txId); } });
  });
}

function initLoadMore() {
  $('#stmt-load-more-btn').addEventListener('click', () => {
    state.visibleCount += VISIBLE_STEP;
    renderTransactionCards();
  });
}

function openDetail(txId) {
  const tx = state.periodTransactions.find((t) => t.id === txId);
  if (!tx) return;
  state.selectedTxId = txId;

  const account = state.account;
  const isIn = tx.receiver_account === account.id;
  const amountText = `${isIn ? '+' : '−'}${formatCurrency(Math.abs(Number(tx.amount) || 0), tx.currency)}`;
  const senderAccount = state.accounts.find((a) => a.id === tx.sender_account);
  const receiverAccount = state.accounts.find((a) => a.id === tx.receiver_account);
  const running = runningBalanceFor(tx);

  $('#stmt-detail-status-tag').textContent = tx.status || 'Unknown';
  $('#stmt-detail-title').textContent = tx.description || tx.transaction_reference || 'Transaction';
  const amountEl = $('#stmt-detail-amount');
  amountEl.textContent = amountText;
  amountEl.classList.toggle('pos', isIn);

  $('#stmt-detail-main-list').innerHTML = [
    ['Reference', tx.transaction_reference || '—'],
    ['Type', typeLabel(tx.transaction_type)],
    ['Status', tx.status || 'Unknown'],
    ['Date', new Date(tx.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })],
    ['Fee', formatCurrency(Number(tx.fee) || 0, tx.currency)],
    running !== null ? ['Running balance', formatCurrency(running, tx.currency)] : null,
    tx.description ? ['Description', tx.description] : null,
  ].filter(Boolean).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  const accountRows = [];
  if (senderAccount) accountRows.push(['From', `${senderAccount.currency} account ${maskAccountNumber(senderAccount.account_number || senderAccount.iban || '')}`]);
  if (receiverAccount) accountRows.push(['To', `${receiverAccount.currency} account ${maskAccountNumber(receiverAccount.account_number || receiverAccount.iban || '')}`]);
  if (!senderAccount && tx.sender_account) accountRows.push(['From', 'External account']);
  if (!receiverAccount && tx.receiver_account) accountRows.push(['To', 'External account']);
  $('#stmt-detail-accounts-list').innerHTML = accountRows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  $('#stmt-detail-overlay').classList.add('is-open');
  $('#stmt-detail-overlay').setAttribute('aria-hidden', 'false');
}

function closeDetail() {
  $('#stmt-detail-overlay').classList.remove('is-open');
  $('#stmt-detail-overlay').setAttribute('aria-hidden', 'true');
  state.selectedTxId = null;
}

function initDetailPanel() {
  $('#stmt-detail-close').addEventListener('click', closeDetail);
  $('#stmt-detail-overlay').addEventListener('click', (e) => { if (e.target.id === 'stmt-detail-overlay') closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  $('#stmt-detail-copy').addEventListener('click', async () => {
    const tx = state.periodTransactions.find((t) => t.id === state.selectedTxId);
    if (!tx?.transaction_reference) return;
    try {
      await navigator.clipboard.writeText(tx.transaction_reference);
      showSuccess('Reference copied to clipboard.');
    } catch {
      showError("Couldn't copy — copy it manually instead.");
    }
  });

  $('#stmt-detail-dispute').addEventListener('click', () => {
    showInfo('Your report has been sent to support.');
  });
}

/* -----------------------------------------------------------
   10. Analytics — spending by transaction_type, and most
   frequent descriptions (merchant proxy). Both computed from
   outgoing (debit) transactions in the current period.
   ----------------------------------------------------------- */
function renderBarRows(container, entries, currency) {
  if (!entries.length) {
    container.innerHTML = `<p style="font-size:0.85rem;color:var(--slate);">Nothing to show for this period yet.</p>`;
    return;
  }
  const max = entries[0][1];
  container.innerHTML = entries.map(([label, value]) => `
    <div class="stmt-analytics-row">
      <span class="stmt-analytics-row-label">${escapeHtml(label)}</span>
      <span class="stmt-analytics-row-bar-track"><span class="stmt-analytics-row-bar-fill" style="width:${Math.max(4, Math.round((value / max) * 100))}%"></span></span>
      <span class="stmt-analytics-row-value">${formatCurrency(value, currency)}</span>
    </div>
  `).join('');
}

function renderAnalytics() {
  const account = state.account;
  const outgoing = filteredTransactions().filter((tx) => tx.sender_account === account.id);

  const byType = {};
  outgoing.forEach((tx) => {
    const key = typeLabel(tx.transaction_type);
    byType[key] = (byType[key] || 0) + Number(tx.amount) + Number(tx.fee || 0);
  });
  renderBarRows($('#stmt-category-breakdown'), Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8), account.currency);

  const byDescription = {};
  outgoing.forEach((tx) => {
    const key = (tx.description || tx.transaction_reference || 'Unlabeled').trim();
    byDescription[key] = (byDescription[key] || 0) + Number(tx.amount) + Number(tx.fee || 0);
  });
  renderBarRows($('#stmt-top-merchants'), Object.entries(byDescription).sort((a, b) => b[1] - a[1]).slice(0, 8), account.currency);
}

/* -----------------------------------------------------------
   11. Statement generation (CSV / print) + history
   ----------------------------------------------------------- */
function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildStatementRows() {
  const account = state.account;
  return state.periodTransactions.map((tx) => {
    const isIn = tx.receiver_account === account.id;
    return {
      date: new Date(tx.created_at).toISOString(),
      description: tx.description || '',
      reference: tx.transaction_reference || '',
      type: typeLabel(tx.transaction_type),
      status: tx.status || '',
      direction: isIn ? 'In' : 'Out',
      amount: (isIn ? 1 : -1) * Number(tx.amount),
      fee: Number(tx.fee) || 0,
      currency: tx.currency,
      balance: runningBalanceFor(tx),
    };
  });
}

function downloadCsv() {
  const rows = buildStatementRows();
  if (!rows.length) { showError('No transactions to export for this range.'); return null; }

  const headers = ['Date', 'Description', 'Reference', 'Type', 'Status', 'Direction', 'Amount', 'Fee', 'Currency', 'Running balance'];
  const csv = [headers, ...rows.map((r) => [r.date, r.description, r.reference, r.type, r.status, r.direction, r.amount, r.fee, r.currency, r.balance])]
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-statement-${state.account.currency}-${state.period.start.toISOString().slice(0, 10)}-to-${state.period.end.toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  return blob.size;
}

function populatePrintTable() {
  const rows = buildStatementRows();
  $('#stmt-print-table-body').innerHTML = rows.map((r) => `
    <tr>
      <td>${new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
      <td>${escapeHtml(r.description)}</td>
      <td>${escapeHtml(r.reference)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${r.amount >= 0 ? '+' : ''}${formatNumber(r.amount)} ${r.currency}</td>
      <td>${r.balance !== null ? formatNumber(r.balance) : '—'}</td>
    </tr>
  `).join('');
}

function triggerPrint() {
  if (!state.periodTransactions.length) { showError('No transactions to print for this range.'); return; }
  populatePrintTable();
  window.print();
}

async function logStatementGeneration({ format, fileSizeBytes }) {
  const { error } = await supabase.from('statement_generations').insert({
    user_id: state.user.id,
    account_id: state.account.id,
    period_start: state.period.start.toISOString().slice(0, 10),
    period_end: state.period.end.toISOString().slice(0, 10),
    format,
    currency: state.account.currency,
    transaction_count: state.periodTransactions.length,
    file_size_bytes: fileSizeBytes || null,
  });
  if (error) {
    console.error('Statements: failed to log generation', error);
    return false;
  }
  return true;
}

function updateGeneratePreview() {
  const el = $('#stmt-generate-preview');
  if (!state.account) return;
  el.innerHTML = `Will generate a statement for the <strong>${escapeHtml(state.account.currency)} account</strong>, <strong>${escapeHtml(periodLabel())}</strong> (${state.periodTransactions.length} transactions).`;
}

async function handleGenerateClick() {
  const format = $('#stmt-generate-format').value;
  const btn = $('#stmt-generate-btn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Generating…';

  try {
    let fileSizeBytes = null;
    if (format === 'csv') {
      fileSizeBytes = downloadCsv();
      if (fileSizeBytes === null) { btn.disabled = false; btn.textContent = originalText; return; }
    } else {
      triggerPrint();
    }

    const logged = await logStatementGeneration({ format, fileSizeBytes });
    if (logged) {
      $('#stmt-last-generated').textContent = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      showSuccess('Statement generated.');
      loadHistory();
    } else {
      showError("Statement was created, but couldn't be saved to your history.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* -----------------------------------------------------------
   Statement history list
   ----------------------------------------------------------- */
function historyIconSvg(format) {
  return format === 'pdf'
    ? '<path d="M4.5 6V2.5h7V6M4.5 11.5h7V14h-7v-2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M3 6h10a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 13 12h-1M4 12H3a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 3 6Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
    : '<path d="M8 2v9M4.5 7.5 8 11l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function loadHistory() {
  const { data, error } = await supabase
    .from('statement_generations')
    .select('*')
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  const listEl = $('#stmt-history-list');
  if (error || !data?.length) {
    listEl.innerHTML = `
      <div class="empty-state" id="stmt-history-empty">
        <span class="empty-state-icon">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4" y="2.5" width="12" height="15" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </span>
        <h3>No statements yet</h3>
        <p>Generate your first statement above — it'll show up here for quick re-download.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = data.map((row) => `
    <div class="stmt-history-row" data-history-id="${row.id}">
      <span class="stmt-history-icon"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${historyIconSvg(row.format)}</svg></span>
      <div class="stmt-history-main">
        <strong>${escapeHtml(row.currency || '')} statement · ${escapeHtml(row.format.toUpperCase())}</strong>
        <span>${new Date(row.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${new Date(row.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ${row.transaction_count} transactions</span>
      </div>
      <span class="stmt-history-meta">${formatFileSize(row.file_size_bytes)}</span>
      <span class="stmt-history-meta">${new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
      <div class="stmt-history-actions">
        <button type="button" class="stmt-history-delete" data-delete-history="${row.id}" aria-label="Delete this history entry">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5V13a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  $$('[data-delete-history]', listEl).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteHistory;
      const { error: delError } = await supabase.from('statement_generations').delete().eq('id', id);
      if (delError) { showError("Couldn't delete that entry."); return; }
      showSuccess('Removed from history.');
      loadHistory();
    });
  });
}

function initGeneratePanel() {
  $('#stmt-generate-btn').addEventListener('click', handleGenerateClick);
  $('#stmt-print-btn').addEventListener('click', triggerPrint);
  $('#stmt-csv-btn').addEventListener('click', () => {
    const size = downloadCsv();
    if (size !== null) logStatementGeneration({ format: 'csv', fileSizeBytes: size }).then((ok) => { if (ok) loadHistory(); });
  });
  $('#stmt-email-btn').addEventListener('click', async () => {
    const btn = $('#stmt-email-btn');
    btn.disabled = true;
    await new Promise((r) => setTimeout(r, 500));
    btn.disabled = false;
    showInfo("Email delivery isn't set up yet — we'll notify you here once it's available.");
  });
}

/* -----------------------------------------------------------
   12. Init
   ----------------------------------------------------------- */
async function init() {
  const user = await requireAuth();
  if (!user) return;
  state.user = user;

  waitForNavbar().then(() => {
    populateHeaderIdentity();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  initPeriodTabs();
  initFilterToggle();
  initFilterInputs();
  initLoadMore();
  initDetailPanel();
  initGeneratePanel();

  const { data: accounts, error } = await getMyAccounts(user.id);
  if (error || !accounts?.length) {
    showError(error || 'Open an account before viewing statements.');
    return;
  }
  state.accounts = accounts;
  state.account = accounts[0];
  state.period = { ...resolvePeriodRange('last-month'), key: 'last-month' };

  populateAccountOptions();
  $('#stmt-filter-account').value = state.account.id;

  await refreshAll();
  updateGeneratePreview();
  loadHistory();

  // keep the generate-panel preview text in sync with later changes
  const observer = new MutationObserver(updateGeneratePreview);
  observer.observe($('#stmt-tx-count-label'), { childList: true });
}

init();
