/* =============================================================
   MERIDIAN — Investments page
   Script: pages/investments.js
   Loaded as a module by investments.html only. Handles:
     1. Auth guard + shared app-header bits (same pattern as
        accounts.js / transfer.js)
     2. Loading accounts, holdings, watchlist, live market prices,
        and recent order history in parallel
     3. Portfolio hero: total value + all-time profit/loss. No
        daily/weekly/monthly/yearly toggle — that needs a price
        HISTORY table this MVP doesn't have (market_prices_cache
        only stores the latest snapshot). Faking those numbers
        would be worse than not showing them; real periods are a
        fast-follow once price history is tracked.
     4. Allocation donut — a plain CSS conic-gradient, no charting
        library, built from each holding's live USD value share.
     5. Holdings, watchlist (with add-by-search), and market-movers
        list, all reading from getMarketPrices()'s cache.
     6. A single buy/sell modal (side toggle rather than two
        separate modals) wired to buyInvestment() / sellInvestment().

   NOTE ON THE SHARED HEADER (components/app-navbar.html):
   The header is injected by components.js, which also auto-boots
   the notification center (assets/js/notifications.js) against
   the bell button — this page never touches the notification
   badge itself, to avoid a second source of truth fighting with
   notifications.js over the same DOM node. See populateHeader()
   and initUserMenu() below for the two things that had to change
   to work correctly against that shared markup.
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
let holdings = [];
let watchlist = [];
let marketPrices = [];
let marketBySymbol = {};
let orders = [];
let usdRateByCurrency = { USD: 1 }; // USD -> currency

/* -----------------------------------------------------------
   Toasts (same pattern as accounts.js / transfer.js)
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
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

/* -----------------------------------------------------------
   Header identity (name + avatar initial only)
   -----------------------------------------------------------
   The unread-notification badge is intentionally NOT touched
   here. components/app-navbar.html's [data-notification-badge]
   element is owned end-to-end by notifications.js, which
   components.js boots automatically once the navbar is injected
   (see the comment at the top of app-navbar.html). Setting it
   from here too would race with notifications.js and could
   flash a stale count after a mark-all-read.
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
 * class: the notification bell wrapper (`.app-user-menu.notification-bell-wrap[data-notification-bell]`)
 * and the actual account dropdown, in that DOM order. A plain
 * `$('.app-user-menu')` would grab the bell wrapper first and this
 * would silently never wire up the account dropdown (no
 * `.app-user-trigger` inside the bell wrapper, so it'd bail out).
 * Anchoring on `.app-user-trigger` — which only exists once, on the
 * account button — and walking up to its own `.app-user-menu`
 * sidesteps that ambiguity entirely regardless of how many
 * `.app-user-menu`-classed wrappers the header ends up with.
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
    if (event.key === 'Escape') {
      close();
      trigger.focus();
    }
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
   USD conversion helpers
   ----------------------------------------------------------- */
async function loadRatesForCurrencies(currencies) {
  const unique = Array.from(new Set(currencies));
  await Promise.all(
    unique.map(async (currency) => {
      if (usdRateByCurrency[currency] != null) return;
      const { data } = await getExchangeRate('USD', currency);
      usdRateByCurrency[currency] = Number(data?.exchange_rate ?? 1);
    })
  );
}

function investedUsd(holding) {
  const account = accountsById[holding.account_id];
  const rate = usdRateByCurrency[account?.currency || 'USD'] ?? 1;
  return Number(holding.invested_amount || 0) / rate;
}

function currentUsd(holding) {
  const price = Number(marketBySymbol[holding.symbol]?.current_price || 0);
  return Number(holding.quantity || 0) * price;
}

/* -----------------------------------------------------------
   Portfolio hero
   ----------------------------------------------------------- */
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

  const sorted = [...holdings]
    .map((h) => ({ ...h, value: currentUsd(h) }))
    .sort((a, b) => b.value - a.value);

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
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">You don't own anything yet — use "Buy" above to start your first position.</div>`;
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
        <article class="holding-card" data-symbol="${h.symbol}" data-account-id="${h.account_id}">
          <div class="holding-card-head">
            ${coinIconHtml(h.symbol)}
            <div>
              <strong>${escapeHtml(meta?.name || h.name || h.symbol)}</strong>
              <span>${escapeHtml(h.symbol)}</span>
            </div>
          </div>
          <div class="holding-value">${formatUsd(value)}</div>
          <div class="holding-meta-row">
            <span class="holding-qty">${formatQty(h.quantity)} ${escapeHtml(h.symbol)}</span>
            <span class="holding-pl${isNeg ? ' is-negative' : ''}">${isNeg ? '-' : '+'}${plPct.toFixed(1)}%</span>
          </div>
        </article>
      `;
    })
    .join('');

  $$('.holding-card', grid).forEach((card) => {
    card.addEventListener('click', () => openTradeModal({ symbol: card.dataset.symbol, accountId: card.dataset.accountId, side: 'sell' }));
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
   Recent activity
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
      const account = accountsById[o.account_id];
      const currency = account?.currency || 'USD';
      return `
        <div class="invest-activity-row">
          <span class="invest-activity-icon ${isBuy ? 'is-buy' : 'is-sell'}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${isBuy
              ? '<path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M8 4v8M4 8l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>
          </span>
          <div class="invest-activity-main">
            <strong>${isBuy ? 'Bought' : 'Sold'} ${formatQty(o.quantity)} ${escapeHtml(o.symbol)}</strong>
            <span>${escapeHtml(o.name || o.symbol)} · ${currencySymbol(currency)}${formatAmount(o.price_per_unit)} / ${escapeHtml(o.symbol)}</span>
          </div>
          <span class="invest-activity-amount">${currencySymbol(currency)}${formatAmount(o.amount)}</span>
          <span class="invest-activity-time">${new Date(o.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
      `;
    })
    .join('');
}

/* -----------------------------------------------------------
   Trade (buy/sell) modal
   ----------------------------------------------------------- */
let tradeState = { symbol: null, side: 'buy', accountId: null };

function tradeAccountOptions() {
  const strip = $('#trade-account-strip');
  if (!strip) return;
  if (!accounts.length) {
    strip.innerHTML = `<p class="balance-note" style="margin:0;">Open a currency account before trading.</p>`;
    return;
  }
  if (!tradeState.accountId) tradeState.accountId = accounts[0].id;

  strip.innerHTML = accounts
    .map((a) => `
      <button type="button" class="account-strip-item" data-account-id="${a.id}" role="radio" aria-checked="${String(a.id) === String(tradeState.accountId)}">
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
      tradeState.accountId = btn.dataset.accountId;
      tradeAccountOptions();
      recalcTradeSummary();
    });
  });
}

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

  const holding = holdings.find((h) => h.symbol === tradeState.symbol && String(h.account_id) === String(tradeState.accountId));
  $('#trade-modal-held').textContent = holding ? `You hold ${formatQty(holding.quantity)} ${tradeState.symbol}` : `You don't hold any ${tradeState.symbol || 'of this'} yet`;
}

function setTradeSide(side) {
  tradeState.side = side;
  $$('.trade-side-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.side === side));
  $('#trade-submit-btn').textContent = side === 'buy' ? 'Buy' : 'Sell';
  $('#trade-submit-btn').className = `btn btn-block ${side === 'buy' ? 'btn-primary' : 'btn-danger'}`;
  recalcTradeSummary();
}

async function recalcTradeSummary() {
  const meta = marketBySymbol[tradeState.symbol];
  const account = accountsById[tradeState.accountId];
  const qty = Number($('#trade-qty-input').value) || 0;
  const price = Number(meta?.current_price || 0);

  if (!account || !price) {
    $('#trade-summary-subtotal').textContent = '—';
    $('#trade-summary-fee').textContent = '—';
    $('#trade-summary-total').textContent = '—';
    return;
  }

  const usdAmount = qty * price;
  const { data: rateData } = await getExchangeRate('USD', account.currency);
  const rate = Number(rateData?.exchange_rate ?? 1);
  const settleAmount = usdAmount * rate;
  const fee = Math.max(0.99, +(settleAmount * 0.0015).toFixed(2));
  const total = tradeState.side === 'buy' ? settleAmount + fee : settleAmount - fee;

  const sym = currencySymbol(account.currency);
  $('#trade-summary-subtotal').textContent = `${sym}${formatAmount(settleAmount)}`;
  $('#trade-summary-fee').textContent = `${sym}${formatAmount(fee)}`;
  $('#trade-summary-total').textContent = `${sym}${formatAmount(total)}`;
  $('#trade-summary-total-label').textContent = tradeState.side === 'buy' ? 'Total to pay' : 'You receive';
}

function openTradeModal({ symbol, accountId, side = 'buy' }) {
  const modal = $('#trade-modal');
  if (!modal) return;
  tradeState = { symbol: symbol || marketPrices[0]?.symbol, side, accountId: accountId || accounts[0]?.id };

  populateTradeAssetSelect();
  tradeAccountOptions();
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

  $$('.trade-side-btn').forEach((btn) => btn.addEventListener('click', () => setTradeSide(btn.dataset.side)));
  $('#trade-asset-select').addEventListener('change', (e) => {
    tradeState.symbol = e.target.value;
    updateTradeAssetHeader();
    recalcTradeSummary();
  });
  $('#trade-qty-input').addEventListener('input', recalcTradeSummary);

  $('#open-buy-modal')?.addEventListener('click', () => openTradeModal({ symbol: marketPrices[0]?.symbol, side: 'buy' }));
  $('#open-sell-modal')?.addEventListener('click', () => {
    if (!holdings.length) { showToast('You have nothing to sell yet.', 'error'); return; }
    openTradeModal({ symbol: holdings[0].symbol, accountId: holdings[0].account_id, side: 'sell' });
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
      accountId: tradeState.accountId,
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
  const [{ data: accs }, { data: hold }, { data: ords }] = await Promise.all([
    getMyAccounts(),
    getMyInvestments(),
    getInvestmentOrders(),
  ]);
  accounts = accs || [];
  accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  holdings = hold || [];
  orders = ords || [];
  await loadRatesForCurrencies(accounts.map((a) => a.currency));
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
  initModalDismissal();
  initWatchlistSearch();
  initTradeModal();

  const [
    { data: accs, error: accError },
    { data: hold, error: holdError },
    { data: watch, error: watchError },
    { data: prices, error: pricesError },
    { data: ords, error: ordersError },
  ] = await Promise.all([
    getMyAccounts(user.id),
    getMyInvestments(user.id),
    getWatchlist(user.id),
    getMarketPrices(),
    getInvestmentOrders(user.id),
  ]);

  if (accError || holdError || watchError || ordersError) {
    showToast("Couldn't load some of your investment data. Please refresh.", 'error');
  }
  if (pricesError) {
    showToast(pricesError, 'error');
  }

  accounts = accs || [];
  accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  holdings = hold || [];
  watchlist = watch || [];
  marketPrices = prices || [];
  marketBySymbol = Object.fromEntries(marketPrices.map((m) => [m.symbol, m]));
  orders = ords || [];

  await loadRatesForCurrencies(accounts.map((a) => a.currency));

  renderPortfolioHero();
  renderHoldings();
  renderWatchlist();
  renderMarketMovers();
  renderActivity();

  if (!accounts.length) {
    showToast('Open a currency account before you can invest.', 'error');
  }
})();
