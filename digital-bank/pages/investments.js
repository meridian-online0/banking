/* =============================================================
   MERIDIAN — Investments page
   Script: pages/investments.js
   Loaded as a module by investments.html only. Handles:
     1. Auth guard + shared app-header bits (identity, user menu,
        mobile nav toggle, logout — see the note above initUserMenu()
        for why the dropdown needs to anchor on .app-user-trigger)
     2. Investment wallet: balance, deposit (from a currency
        account) and withdraw (back to one), and a small activity
        feed of past deposits/withdrawals
     3. Loading holdings, watchlist, live market prices, and recent
        order history in parallel — all now scoped to the wallet,
        not a currency account (see 003_investment_wallet.sql)
     4. Portfolio hero: total value + all-time profit/loss, plus
        cash sitting in the wallet. No daily/weekly/monthly/yearly
        toggle — that needs a price HISTORY table this MVP doesn't
        have (market_prices_cache only stores the latest snapshot).
     5. Allocation donut — plain CSS conic-gradient, no charting
        library, built from each holding's live USD value share.
     6. Holdings, watchlist (with add-by-search), and market-movers
        list, all reading from getMarketPrices()'s cache.
     7. A single buy/sell modal (side toggle rather than two modals)
        wired to buyInvestment() / sellInvestment() — funded
        entirely from the wallet, so there's no funding-account
        picker here anymore.

   NOTE ON THE SHARED HEADER (components/app-navbar.html):
   The header is injected by components.js, which also auto-boots
   the notification center (assets/js/notifications.js) against
   the bell button, and now also the mobile nav toggle (previously
   missing from this page — see initMobileNav() below).
   ============================================================= */

import { requireAuth, signOutUser } from '../supabase/auth.js';
import {
  getMyProfile,
  getMyAccounts,
  getMyInvestments,
  getInvestmentOrders,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getMarketPrices,
  getInvestmentWallet,
  depositToInvestmentWallet,
  withdrawFromInvestmentWallet,
  getWalletTransactions,
  getExchangeRate,
  buyInvestment,
  sellInvestment,
} from '../supabase/database.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF' };
const currencySymbol = (code) => CURRENCY_SYMBOLS[code] || code || '';
const formatUsd = (value) => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatAmount = (value) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatQty = (value) => {
  const n = Number(value || 0);
  return n < 1 ? n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
};
const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DONUT_PALETTE = ['#b58a44', '#0a1628', '#1f8a5f', '#b3771d', '#5b6b7c', '#d8b876', '#8f6b32', '#16304e'];

/* -----------------------------------------------------------
   State
   ----------------------------------------------------------- */
let accounts = [];
let accountsById = {};
let wallet = { id: null, balance: 0 };
let walletTx = [];
let holdings = [];
let watchlist = [];
let marketPrices = [];
let marketBySymbol = {};
let orders = [];

/* -----------------------------------------------------------
   Toasts
   ----------------------------------------------------------- */
function showToast(message, variant = 'success') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast${variant === 'error' ? ' toast--error' : ' toast--success'}`;
  toast.innerHTML = `
    <svg class="toast-ic" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      ${variant === 'error'
        ? '<path d="M10 6.5v4M10 13.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.4"/>'
        : '<path d="M4 10.5 8 14.5 16 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'}
    </svg>
    <span>${escapeHtml(message)}</span>
  `;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

/* -----------------------------------------------------------
   Header identity
   ----------------------------------------------------------- */
async function populateHeader() {
  const nameEl = $('.app-user-name');
  const avatarEl = $('.app-user-trigger .avatar-initial');
  const { data: profile } = await getMyProfile();
  const firstName = profile?.first_name || '';
  const lastName = profile?.last_name || '';
  if (nameEl) nameEl.textContent = `${firstName} ${lastName}`.trim() || 'Your account';
  if (avatarEl) avatarEl.textContent = (firstName[0] || 'M').toUpperCase();
}

/**
 * The injected navbar has TWO elements carrying the `.app-user-menu`
 * class: the notification bell wrapper and the actual account
 * dropdown. Anchoring on `.app-user-trigger` — which only exists
 * once, on the account button — and walking up to its own
 * `.app-user-menu` sidesteps that ambiguity regardless of how many
 * `.app-user-menu`-classed wrappers the header ends up with.
 * (dashboard.js previously grabbed `.app-user-menu` directly, which
 * matched the bell wrapper first and silently broke the account
 * dropdown/logout — fixed there to match this pattern.)
 */
function initUserMenu() {
  const trigger = $('.app-user-trigger');
  const menu = trigger?.closest('.app-user-menu');
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
    if (menu.classList.contains('is-open')) close();
    else open();
  });
}

function initLogout() {
  const link = $('#logout-link');
  if (!link) return;
  link.addEventListener('click', async (e) => {
    e.preventDefault();
    await signOutUser();
    window.location.href = link.getAttribute('href');
  });
}

/**
 * Mobile hamburger (.app-nav-toggle) that opens the app nav drawer.
 * dashboard.js has always wired this; investments.js never called
 * it, so the hamburger on this page did nothing. Same logic as
 * dashboard.js's initMobileNav(), kept in sync here.
 */
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

/* -----------------------------------------------------------
   Hide-balance toggle — blurs every element carrying the
   `.balance-value` class (portfolio total, P/L, wallet cash,
   wallet balance, holding values, recent trade/wallet amounts).
   Market prices, watchlist prices, and modal amounts stay visible
   since those aren't the user's own money. State is remembered
   per-browser via localStorage so a reload doesn't flash real
   numbers before the toggle re-applies.
   ----------------------------------------------------------- */
const BALANCE_HIDDEN_KEY = 'meridian:balances-hidden';

function applyBalanceVisibility(hidden) {
  document.body.classList.toggle('balances-hidden', hidden);
  const btn = $('#balance-toggle-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(hidden));
  btn.setAttribute('aria-label', hidden ? 'Show balances' : 'Hide balances');
  const eyeIcon = $('.icon-eye', btn);
  const eyeOffIcon = $('.icon-eye-off', btn);
  if (eyeIcon) eyeIcon.style.display = hidden ? 'none' : '';
  if (eyeOffIcon) eyeOffIcon.style.display = hidden ? '' : 'none';
}

function initBalanceToggle() {
  const btn = $('#balance-toggle-btn');
  if (!btn) return;

  let hidden = false;
  try { hidden = localStorage.getItem(BALANCE_HIDDEN_KEY) === '1'; } catch (err) { /* private browsing, etc. — default to visible */ }
  applyBalanceVisibility(hidden);

  btn.addEventListener('click', () => {
    hidden = !document.body.classList.contains('balances-hidden');
    applyBalanceVisibility(hidden);
    try { localStorage.setItem(BALANCE_HIDDEN_KEY, hidden ? '1' : '0'); } catch (err) { /* ignore */ }
  });
}

/* -----------------------------------------------------------
   Modal plumbing (shared)
   ----------------------------------------------------------- */
function openModal(modal) {
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeModal(modal) {
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
function initModalDismissal() {
  $$('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay); });
    $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', () => closeModal(overlay)));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $$('.modal-overlay.is-open').forEach((o) => closeModal(o));
  });
}

/* -----------------------------------------------------------
   Portfolio hero (holding values are already USD; invested_amount
   is stored in USD too, so no per-account currency conversion is
   needed anymore for the hero or P/L math).
   ----------------------------------------------------------- */
function currentUsd(holding) {
  const price = Number(marketBySymbol[holding.symbol]?.current_price || 0);
  return Number(holding.quantity || 0) * price;
}
function investedUsd(holding) {
  return Number(holding.invested_amount || 0);
}

function renderPortfolioHero() {
  const totalValue = holdings.reduce((sum, h) => sum + currentUsd(h), 0);
  const totalInvested = holdings.reduce((sum, h) => sum + investedUsd(h), 0);
  const pl = totalValue - totalInvested;
  const plPct = totalInvested > 0 ? (pl / totalInvested) * 100 : 0;

  $('#portfolio-total-value').textContent = formatUsd(totalValue).replace('$', '');

  const plEl = $('#portfolio-pl-badge');
  const isNeg = pl < 0;
  plEl.classList.toggle('is-negative', isNeg);
  plEl.innerHTML = `
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">${isNeg
      ? '<path d="M6 2v8M6 10 2.5 6.5M6 10l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M6 10V2M6 2 2.5 5.5M6 2l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>
    ${isNeg ? '-' : '+'}${formatUsd(Math.abs(pl))} (${isNeg ? '-' : '+'}${Math.abs(plPct).toFixed(2)}%) all time
  `;

  const cashEl = $('#portfolio-cash-value');
  if (cashEl) cashEl.textContent = formatUsd(wallet.balance);

  renderAllocationDonut(totalValue);
}

function renderAllocationDonut(totalValue) {
  const donut = $('#allocation-donut');
  const legend = $('#allocation-legend');
  if (!donut || !legend) return;

  if (!holdings.length || totalValue <= 0) {
    donut.style.backgroundImage = 'conic-gradient(var(--line-dark) 0deg 360deg)';
    $('#allocation-donut-total').textContent = '—';
    legend.innerHTML = `<p class="balance-note" style="margin:0;">No holdings yet — your allocation will appear here after your first buy.</p>`;
    return;
  }

  const sorted = [...holdings].map((h) => ({ ...h, value: currentUsd(h) })).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 5);
  const otherValue = sorted.slice(5).reduce((sum, h) => sum + h.value, 0);
  const slices = otherValue > 0 ? [...top, { symbol: 'Other', value: otherValue, isOther: true }] : top;

  let cursor = 0;
  const gradientParts = slices.map((slice, i) => {
    const pct = (slice.value / totalValue) * 100;
    const start = cursor;
    cursor += pct;
    return `${DONUT_PALETTE[i % DONUT_PALETTE.length]} ${start * 3.6}deg ${cursor * 3.6}deg`;
  });
  donut.style.backgroundImage = `conic-gradient(${gradientParts.join(', ')})`;
  $('#allocation-donut-total').textContent = String(holdings.length);

  legend.innerHTML = slices
    .map((slice, i) => `
      <div class="allocation-legend-row">
        <span class="allocation-legend-dot" style="background:${DONUT_PALETTE[i % DONUT_PALETTE.length]}"></span>
        <strong>${escapeHtml(slice.symbol)}</strong>
        <span>${((slice.value / totalValue) * 100).toFixed(1)}%</span>
      </div>
    `)
    .join('');
}

/* -----------------------------------------------------------
   Investment wallet card + activity
   ----------------------------------------------------------- */
function renderWalletCard() {
  const balanceEl = $('#wallet-balance');
  if (balanceEl) {
    balanceEl.classList.remove('skeleton');
    balanceEl.textContent = formatUsd(wallet.balance);
  }
}

function renderWalletActivity() {
  const list = $('#wallet-activity-list');
  if (!list) return;

  if (!walletTx.length) {
    list.classList.remove('skeleton');
    list.innerHTML = `<p style="font-size:0.88rem;color:var(--slate);">No deposits or withdrawals yet — fund your wallet to start investing.</p>`;
    return;
  }

  list.innerHTML = walletTx
    .map((tx) => {
      const isDeposit = tx.direction === 'deposit';
      return `
        <div class="wallet-activity-row">
          <span class="invest-activity-icon ${isDeposit ? 'is-buy' : 'is-sell'}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${isDeposit
              ? '<path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M8 4v8M4 8l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>
          </span>
          <div class="invest-activity-main">
            <strong class="balance-value">${isDeposit ? 'Deposited' : 'Withdrew'} ${formatUsd(tx.wallet_amount)}</strong>
            <span>${isDeposit ? 'From' : 'To'} ${escapeHtml(accountsById[tx.account_id]?.currency || '')} account</span>
          </div>
          <span class="invest-activity-time">${new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
      `;
    })
    .join('');
}

/* -----------------------------------------------------------
   Wallet (deposit / withdraw) modal
   ----------------------------------------------------------- */
let walletModalState = { direction: 'deposit', accountId: null };

function walletAccountOptions() {
  const strip = $('#wallet-account-strip');
  if (!strip) return;
  if (!accounts.length) {
    strip.innerHTML = `<p class="balance-note" style="margin:0;">Open a currency account first.</p>`;
    return;
  }
  if (!walletModalState.accountId) walletModalState.accountId = accounts[0].id;

  strip.innerHTML = accounts
    .map((a) => `
      <button type="button" class="account-strip-item" data-account-id="${a.id}" role="radio" aria-checked="${String(a.id) === String(walletModalState.accountId)}">
        <span class="account-strip-flag">${currencySymbol(a.currency)}</span>
        <div>
          <strong>${a.currency} account</strong>
          <span>${formatAmount(a.available_balance ?? a.balance)}</span>
        </div>
      </button>
    `)
    .join('');

  $$('.account-strip-item', strip).forEach((btn) => {
    btn.addEventListener('click', () => {
      walletModalState.accountId = btn.dataset.accountId;
      walletAccountOptions();
      recalcWalletSummary();
    });
  });
}

function setWalletDirection(direction) {
  walletModalState.direction = direction;
  $$('#wallet-direction-toggle .trade-side-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.direction === direction));

  const isDeposit = direction === 'deposit';
  $('#wallet-account-label').textContent = isDeposit ? 'From account' : 'To account';
  $('#wallet-amount-label').textContent = isDeposit ? 'Amount to deposit' : 'Amount to withdraw (USD)';
  $('#wallet-submit-btn').textContent = isDeposit ? 'Deposit' : 'Withdraw';
  $('#wallet-submit-btn').className = `btn btn-block ${isDeposit ? 'btn-primary' : 'btn-danger'}`;
  recalcWalletSummary();
}

async function recalcWalletSummary() {
  const note = $('#wallet-modal-note');
  const account = accountsById[walletModalState.accountId];
  const amount = Number($('#wallet-amount-input').value) || 0;

  if (!account || !amount) {
    note.textContent = walletModalState.direction === 'deposit'
      ? 'Enter an amount to see how much lands in your wallet.'
      : 'Enter an amount (in USD) to see how much lands in the account.';
    return;
  }

  if (walletModalState.direction === 'deposit') {
    const { data: rateData } = await getExchangeRate(account.currency, 'USD');
    const usd = amount * Number(rateData?.exchange_rate ?? 1);
    note.textContent = `≈ ${formatUsd(usd)} will be added to your investment wallet.`;
  } else {
    const { data: rateData } = await getExchangeRate('USD', account.currency);
    const converted = amount * Number(rateData?.exchange_rate ?? 1);
    note.textContent = `≈ ${currencySymbol(account.currency)}${formatAmount(converted)} will land in your ${account.currency} account.`;
  }
}

function openWalletModal(direction) {
  const modal = $('#wallet-modal');
  if (!modal) return;
  walletModalState = { direction, accountId: accounts[0]?.id };
  walletAccountOptions();
  setWalletDirection(direction);
  $('#wallet-amount-input').value = '';
  $('#wallet-error').style.display = 'none';
  recalcWalletSummary();
  openModal(modal);
}

function initWalletModal() {
  const modal = $('#wallet-modal');
  if (!modal) return;

  $$('#wallet-direction-toggle .trade-side-btn').forEach((btn) => btn.addEventListener('click', () => setWalletDirection(btn.dataset.direction)));
  $('#wallet-amount-input').addEventListener('input', recalcWalletSummary);
  $$('#open-deposit-modal, #open-deposit-modal-inline').forEach((btn) => btn.addEventListener('click', () => openWalletModal('deposit')));
  $('#open-withdraw-modal')?.addEventListener('click', () => openWalletModal('withdrawal'));

  $('#wallet-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = $('#wallet-error');
    errorEl.style.display = 'none';

    const amount = Number($('#wallet-amount-input').value);
    if (!amount || amount <= 0) {
      errorEl.textContent = 'Enter an amount greater than zero.';
      errorEl.style.display = 'block';
      return;
    }
    if (!walletModalState.accountId) {
      errorEl.textContent = 'Choose an account first.';
      errorEl.style.display = 'block';
      return;
    }

    const submitBtn = $('#wallet-submit-btn');
    const isDeposit = walletModalState.direction === 'deposit';
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = isDeposit ? 'Depositing…' : 'Withdrawing…';

    const action = isDeposit ? depositToInvestmentWallet : withdrawFromInvestmentWallet;
    const { error } = await action({ accountId: walletModalState.accountId, amount });

    submitBtn.disabled = false;
    submitBtn.textContent = original;

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    closeModal(modal);
    showToast(`${isDeposit ? 'Deposited' : 'Withdrew'} ${formatUsd(amount)}${isDeposit ? '' : ' from your wallet'}.`);
    await refreshWalletAndAccounts();
  });
}

async function refreshWalletAndAccounts() {
  const [{ data: accs }, { data: w }, { data: tx }] = await Promise.all([
    getMyAccounts(),
    getInvestmentWallet(),
    getWalletTransactions(undefined, { limit: 6 }),
  ]);
  accounts = accs || [];
  accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  wallet = w || { id: null, balance: 0 };
  walletTx = tx || [];
  renderWalletCard();
  renderWalletActivity();
  renderPortfolioHero();
  $('#trade-wallet-available') && ($('#trade-wallet-available').textContent = `Available: ${formatUsd(wallet.balance)} in your investment wallet`);
}

/* -----------------------------------------------------------
   Holdings
   ----------------------------------------------------------- */
function coinIconHtml(symbol, size = 38) {
  const meta = marketBySymbol[symbol];
  if (meta?.image_url) {
    return `<img src="${meta.image_url}" alt="" class="holding-coin-icon" style="width:${size}px;height:${size}px;">`;
  }
  return `<span class="holding-coin-icon holding-coin-icon--fallback" style="width:${size}px;height:${size}px;">${escapeHtml(symbol.slice(0, 3))}</span>`;
}

function renderHoldings() {
  const grid = $('#holdings-grid');
  if (!grid) return;

  if (!holdings.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">You don't own anything yet — deposit into your wallet, then use "Buy" above to start your first position.</div>`;
    return;
  }

  grid.innerHTML = holdings
    .map((h) => {
      const value = currentUsd(h);
      const invested = investedUsd(h);
      const pl = value - invested;
      const plPct = invested > 0 ? (pl / invested) * 100 : 0;
      const isNeg = pl < 0;
      const meta = marketBySymbol[h.symbol];
      return `
        <article class="holding-card" data-symbol="${h.symbol}">
          <div class="holding-card-head">
            ${coinIconHtml(h.symbol)}
            <div>
              <strong>${escapeHtml(meta?.name || h.name || h.symbol)}</strong>
              <span>${escapeHtml(h.symbol)}</span>
            </div>
          </div>
          <div class="holding-value balance-value">${formatUsd(value)}</div>
          <div class="holding-meta-row">
            <span class="holding-qty">${formatQty(h.quantity)} ${escapeHtml(h.symbol)}</span>
            <span class="holding-pl${isNeg ? ' is-negative' : ''}">${isNeg ? '-' : '+'}${plPct.toFixed(1)}%</span>
          </div>
        </article>
      `;
    })
    .join('');

  $$('.holding-card', grid).forEach((card) => {
    card.addEventListener('click', () => openTradeModal({ symbol: card.dataset.symbol, side: 'sell' }));
  });
}

/* -----------------------------------------------------------
   Watchlist
   ----------------------------------------------------------- */
function renderWatchlist() {
  const grid = $('#watchlist-grid');
  if (!grid) return;

  if (!watchlist.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Search above to add assets you want to keep an eye on.</div>`;
    return;
  }

  grid.innerHTML = watchlist
    .map((w) => {
      const meta = marketBySymbol[w.symbol];
      const price = Number(meta?.current_price || 0);
      const change = Number(meta?.price_change_percentage_24h || 0);
      const isNeg = change < 0;
      return `
        <article class="watchlist-card" data-symbol="${w.symbol}">
          <button type="button" class="watchlist-card-remove" data-remove-watchlist="${w.id}" aria-label="Remove ${escapeHtml(w.symbol)} from watchlist">
            <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <div class="watchlist-card-head">
            ${coinIconHtml(w.symbol, 26)}
            <div>
              <strong>${escapeHtml(w.symbol)}</strong>
              <span>${escapeHtml(meta?.name || w.name || '')}</span>
            </div>
          </div>
          <div class="watchlist-card-price">${formatUsd(price)}</div>
          <span class="watchlist-card-change${isNeg ? ' is-negative' : ''}">
            <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">${isNeg
              ? '<path d="M6 2v8M6 10 2.5 6.5M6 10l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M6 10V2M6 2 2.5 5.5M6 2l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>
            ${Math.abs(change).toFixed(2)}%
          </span>
        </article>
      `;
    })
    .join('');

  $$('.watchlist-card', grid).forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-watchlist]')) return;
      openTradeModal({ symbol: card.dataset.symbol, side: 'buy' });
    });
  });

  $$('[data-remove-watchlist]', grid).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const { error } = await removeFromWatchlist(btn.dataset.removeWatchlist);
      if (error) { showToast(error, 'error'); btn.disabled = false; return; }
      watchlist = watchlist.filter((w) => String(w.id) !== btn.dataset.removeWatchlist);
      renderWatchlist();
      showToast('Removed from watchlist.');
    });
  });
}

function initWatchlistSearch() {
  const input = $('#watchlist-search-input');
  const list = $('#watchlist-suggestions-list');
  if (!input || !list) return;

  function renderSuggestions(query) {
    const q = query.trim().toLowerCase();
    const watchedSymbols = new Set(watchlist.map((w) => w.symbol));
    const matches = marketPrices
      .filter((m) => !watchedSymbols.has(m.symbol) && (!q || m.symbol.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q)))
      .slice(0, 8);

    if (!matches.length) {
      list.innerHTML = `<p class="balance-note" style="margin:0;padding:0.9rem;">No matching assets.</p>`;
      list.classList.add('is-open');
      return;
    }

    list.innerHTML = matches
      .map((m) => `
        <button type="button" class="watchlist-suggestion-item" data-add-symbol="${m.symbol}">
          ${coinIconHtml(m.symbol, 24)}
          <span><strong>${escapeHtml(m.symbol)}</strong> — ${escapeHtml(m.name || '')}</span>
        </button>
      `)
      .join('');
    list.classList.add('is-open');

    $$('[data-add-symbol]', list).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const symbol = btn.dataset.addSymbol;
        const meta = marketBySymbol[symbol];
        btn.disabled = true;
        const { data, error } = await addToWatchlist({ symbol, name: meta?.name, assetType: 'crypto' });
        if (error) { showToast(error, 'error'); btn.disabled = false; return; }
        watchlist.unshift(data);
        renderWatchlist();
        input.value = '';
        list.classList.remove('is-open');
        showToast(`${symbol} added to watchlist.`);
      });
    });
  }

  input.addEventListener('focus', () => renderSuggestions(input.value));
  input.addEventListener('input', () => renderSuggestions(input.value));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.watchlist-suggestions')) list.classList.remove('is-open');
  });
}

/* -----------------------------------------------------------
   Market movers
   ----------------------------------------------------------- */
function renderMarketMovers() {
  const list = $('#market-movers-list');
  if (!list) return;

  if (!marketPrices.length) {
    list.innerHTML = `<div class="empty-state">Live prices aren't available right now — try refreshing shortly.</div>`;
    return;
  }

  const movers = [...marketPrices]
    .sort((a, b) => Number(b.price_change_percentage_24h || 0) - Number(a.price_change_percentage_24h || 0))
    .slice(0, 6);

  list.innerHTML = movers
    .map((m) => {
      const change = Number(m.price_change_percentage_24h || 0);
      const isNeg = change < 0;
      return `
        <div class="market-mover-row" data-symbol="${m.symbol}">
          ${m.image_url ? `<img src="${m.image_url}" alt="" class="market-mover-icon">` : `<span class="holding-coin-icon holding-coin-icon--fallback market-mover-icon">${escapeHtml(m.symbol.slice(0, 3))}</span>`}
          <div class="market-mover-name">
            <strong>${escapeHtml(m.symbol)}</strong>
            <span>${escapeHtml(m.name || '')}</span>
          </div>
          <span class="market-mover-price mono">${formatUsd(m.current_price)}</span>
          <span class="market-mover-change${isNeg ? ' is-negative' : ''}">
            <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">${isNeg
              ? '<path d="M6 2v8M6 10 2.5 6.5M6 10l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M6 10V2M6 2 2.5 5.5M6 2l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>
            ${Math.abs(change).toFixed(2)}%
          </span>
        </div>
      `;
    })
    .join('');

  $$('.market-mover-row', list).forEach((row) => {
    row.addEventListener('click', () => openTradeModal({ symbol: row.dataset.symbol, side: 'buy' }));
  });
}

/* -----------------------------------------------------------
   Recent trade activity (always USD now — no account currency lookup)
   ----------------------------------------------------------- */
function renderActivity() {
  const list = $('#invest-activity-list');
  if (!list) return;

  if (!orders.length) {
    list.innerHTML = `<div class="empty-state">No trades yet — your buy and sell history will show up here.</div>`;
    return;
  }

  list.innerHTML = orders
    .map((o) => {
      const isBuy = o.side === 'buy';
      return `
        <div class="invest-activity-row">
          <span class="invest-activity-icon ${isBuy ? 'is-buy' : 'is-sell'}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${isBuy
              ? '<path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M8 4v8M4 8l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>
          </span>
          <div class="invest-activity-main">
            <strong>${isBuy ? 'Bought' : 'Sold'} ${formatQty(o.quantity)} ${escapeHtml(o.symbol)}</strong>
            <span>${escapeHtml(o.name || o.symbol)} · ${formatUsd(o.price_per_unit)} / ${escapeHtml(o.symbol)}</span>
          </div>
          <span class="invest-activity-amount balance-value">${formatUsd(o.amount)}</span>
          <span class="invest-activity-time">${new Date(o.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
      `;
    })
    .join('');
}

/* -----------------------------------------------------------
   Trade (buy/sell) modal — funded entirely from the wallet
   ----------------------------------------------------------- */
let tradeState = { symbol: null, side: 'buy' };

function populateTradeAssetSelect() {
  const select = $('#trade-asset-select');
  if (!select) return;
  select.innerHTML = marketPrices
    .map((m) => `<option value="${m.symbol}" ${m.symbol === tradeState.symbol ? 'selected' : ''}>${m.symbol} — ${escapeHtml(m.name || '')}</option>`)
    .join('');
}

function updateTradeAssetHeader() {
  const meta = marketBySymbol[tradeState.symbol];
  $('#trade-modal-asset-icon').innerHTML = coinIconHtml(tradeState.symbol, 40);
  $('#trade-modal-asset-name').textContent = meta?.name || tradeState.symbol || '—';
  $('#trade-modal-asset-price').textContent = meta ? `${formatUsd(meta.current_price)} per ${tradeState.symbol}` : '—';

  const holding = holdings.find((h) => h.symbol === tradeState.symbol);
  $('#trade-modal-held').textContent = holding ? `You hold ${formatQty(holding.quantity)} ${tradeState.symbol}` : `You don't hold any ${tradeState.symbol || 'of this'} yet`;
  $('#trade-wallet-available').textContent = `Available: ${formatUsd(wallet.balance)} in your investment wallet`;
}

function setTradeSide(side) {
  tradeState.side = side;
  $$('.trade-side-btn[data-side]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.side === side));
  $('#trade-submit-btn').textContent = side === 'buy' ? 'Buy' : 'Sell';
  $('#trade-submit-btn').className = `btn btn-block ${side === 'buy' ? 'btn-primary' : 'btn-danger'}`;
  recalcTradeSummary();
}

function recalcTradeSummary() {
  const meta = marketBySymbol[tradeState.symbol];
  const qty = Number($('#trade-qty-input').value) || 0;
  const price = Number(meta?.current_price || 0);

  if (!price || !qty) {
    $('#trade-summary-subtotal').textContent = '—';
    $('#trade-summary-fee').textContent = '—';
    $('#trade-summary-total').textContent = '—';
    return;
  }

  const usdAmount = qty * price;
  const fee = Math.max(0.99, +(usdAmount * 0.0015).toFixed(2));
  const total = tradeState.side === 'buy' ? usdAmount + fee : usdAmount - fee;

  $('#trade-summary-subtotal').textContent = formatUsd(usdAmount);
  $('#trade-summary-fee').textContent = formatUsd(fee);
  $('#trade-summary-total').textContent = formatUsd(total);
  $('#trade-summary-total-label').textContent = tradeState.side === 'buy' ? 'Total from wallet' : 'Added to wallet';
}

function openTradeModal({ symbol, side = 'buy' }) {
  const modal = $('#trade-modal');
  if (!modal) return;
  tradeState = { symbol: symbol || marketPrices[0]?.symbol, side };

  populateTradeAssetSelect();
  updateTradeAssetHeader();
  setTradeSide(side);
  $('#trade-qty-input').value = '';
  $('#trade-error').style.display = 'none';
  recalcTradeSummary();
  openModal(modal);
}

function initTradeModal() {
  const modal = $('#trade-modal');
  if (!modal) return;

  $$('.trade-side-btn[data-side]').forEach((btn) => btn.addEventListener('click', () => setTradeSide(btn.dataset.side)));
  $('#trade-asset-select').addEventListener('change', (e) => {
    tradeState.symbol = e.target.value;
    updateTradeAssetHeader();
    recalcTradeSummary();
  });
  $('#trade-qty-input').addEventListener('input', recalcTradeSummary);

  $('#open-buy-modal')?.addEventListener('click', () => openTradeModal({ symbol: marketPrices[0]?.symbol, side: 'buy' }));
  $('#open-sell-modal')?.addEventListener('click', () => {
    if (!holdings.length) { showToast('You have nothing to sell yet.', 'error'); return; }
    openTradeModal({ symbol: holdings[0].symbol, side: 'sell' });
  });

  $('#trade-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = $('#trade-error');
    errorEl.style.display = 'none';

    const meta = marketBySymbol[tradeState.symbol];
    const qty = Number($('#trade-qty-input').value);
    if (!qty || qty <= 0) {
      errorEl.textContent = 'Enter a quantity greater than zero.';
      errorEl.style.display = 'block';
      return;
    }

    const submitBtn = $('#trade-submit-btn');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = tradeState.side === 'buy' ? 'Buying…' : 'Selling…';

    const action = tradeState.side === 'buy' ? buyInvestment : sellInvestment;
    const { error } = await action({
      symbol: tradeState.symbol,
      name: meta?.name,
      assetType: 'crypto',
      quantity: qty,
      pricePerUnit: meta?.current_price,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    closeModal(modal);
    showToast(`${tradeState.side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${tradeState.symbol}.`);
    await refreshAfterTrade();
  });
}

async function refreshAfterTrade() {
  const [{ data: w }, { data: hold }, { data: ords }] = await Promise.all([
    getInvestmentWallet(),
    getMyInvestments(),
    getInvestmentOrders(),
  ]);
  wallet = w || { id: null, balance: 0 };
  holdings = hold || [];
  orders = ords || [];
  renderWalletCard();
  renderPortfolioHero();
  renderHoldings();
  renderActivity();
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await requireAuth();
  if (!user) return; // requireAuth() already redirected to login.html

  populateHeader();
  initUserMenu();
  initLogout();
  initMobileNav();
  initModalDismissal();
  initWatchlistSearch();
  initTradeModal();
  initWalletModal();
  initBalanceToggle();

  const [
    { data: accs, error: accError },
    { data: w, error: walletError },
    { data: tx },
    { data: hold, error: holdError },
    { data: watch, error: watchError },
    { data: prices, error: pricesError },
    { data: ords, error: ordersError },
  ] = await Promise.all([
    getMyAccounts(user.id),
    getInvestmentWallet(user.id),
    getWalletTransactions(user.id, { limit: 6 }),
    getMyInvestments(user.id),
    getWatchlist(user.id),
    getMarketPrices(),
    getInvestmentOrders(user.id),
  ]);

  if (accError || holdError || watchError || ordersError || walletError) {
    showToast("Couldn't load some of your investment data. Please refresh.", 'error');
  }
  if (pricesError) {
    showToast(pricesError, 'error');
  }

  accounts = accs || [];
  accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  wallet = w || { id: null, balance: 0 };
  walletTx = tx || [];
  holdings = hold || [];
  watchlist = watch || [];
  marketPrices = prices || [];
  marketBySymbol = Object.fromEntries(marketPrices.map((m) => [m.symbol, m]));
  orders = ords || [];

  renderWalletCard();
  renderWalletActivity();
  renderPortfolioHero();
  renderHoldings();
  renderWatchlist();
  renderMarketMovers();
  renderActivity();

  if (!accounts.length) {
    showToast('Open a currency account before you can fund your investment wallet.', 'error');
  }
})();
