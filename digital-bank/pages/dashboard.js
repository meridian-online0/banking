/* =============================================================
   MERIDIAN — Dashboard / overview page
   Script: pages/dashboard.js
   Loaded as a module by dashboard.html only. Handles:
     1. Auth guard (via supabase/page-guard.js) + reveal
     2. Personalized greeting + real last-login line, both from
        the signed-in user's profile / login_sessions row
     3. Notification badge count
     4. User menu dropdown + mobile nav toggle
     5. Log out
     6. Total balance + account strip, built from real accounts
     7. Recent transactions, spending breakdown, savings goals,
        and card preview — all scoped to the user's primary
        (first-opened) account. See the note above
        renderPrimaryAccountSections() for why.
     8. Live crypto ticker (band under the header)
     9. "Market pulse" panel — live crypto prices + finance
        headlines, with an honestly-labelled fallback if either
        feed is unreachable (never fakes "live" data)
    10. Automation showcase — animates a real stat (total saved
        across the user's goals) into the sidebar upsell card
   ============================================================= */

import { guardPage } from '../supabase/page-guard.js';
import { signOutUser } from '../supabase/auth.js';
import { supabase } from '../supabase/config.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getTotalBalance,
  getTransactions,
  getSavingsGoals,
  getCardsForAccount,
} from '../supabase/database.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF',
};

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '';
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function capitalizeWords(str) {
  return String(str || 'Transaction')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTxTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Clears any skeleton styling left over from the loading state —
 *  call this on a container right before writing real content into
 *  it, since .skeleton forces color:transparent. */
function unskeleton(el) {
  el?.classList.remove('skeleton');
}

function emptyStateNote(container, message) {
  if (!container) return;
  container.classList.remove('skeleton');
  container.innerHTML = `<p style="font-size:0.88rem;">${message}</p>`;
}

/** Small text/attribute escaper — the ticker and news panel both
 *  inject third-party strings (coin names, headline titles) into
 *  innerHTML, so anything that isn't already trusted local markup
 *  goes through this first. */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* -----------------------------------------------------------
   Toasts (same pattern as the other pages)
   ----------------------------------------------------------- */
function showToast(message, variant = 'error') {
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
    <span>${message}</span>
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
   Greeting + last login
   ----------------------------------------------------------- */
function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

async function populateGreeting() {
  const heading = $('#dashboard-greeting');
  if (!heading) return;

  const { data: profile } = await getMyProfile();
  const firstName = profile?.first_name;
  unskeleton(heading);
  heading.textContent = `${timeOfDayGreeting()}${firstName ? `, ${firstName}` : ''}.`;
}

/** Real "last login" line, built from login_sessions (written by
 *  auth.js on every sign-in) rather than a hardcoded string. Shows
 *  the session before the current one, since "today, just now" from
 *  this very session isn't useful context for the person reading it. */
async function populateLastLogin(userId) {
  const el = $('#dashboard-last-login');
  if (!el) return;

  const { data, error } = await supabase
    .from('login_sessions')
    .select('login_time, browser, device')
    .eq('user_id', userId)
    .order('login_time', { ascending: false })
    .range(1, 1); // skip the current session (row 0), take the one before it

  if (error || !data?.length) {
    el.textContent = '';
    return;
  }

  const last = data[0];
  const when = new Date(last.login_time).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const context = [last.browser, last.device].filter(Boolean).join(' on ');
  el.textContent = `Last login ${when}${context ? ` from ${context}` : ''}.`;
}

/* -----------------------------------------------------------
   Notification badge
   ----------------------------------------------------------- */
async function populateNotificationBadge() {
  const badge = $('.app-icon-btn-badge');
  if (!badge) return;

  const { data: count } = await getUnreadNotificationCount();
  if (!count) {
    badge.style.display = 'none';
    return;
  }
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.style.display = 'flex';
}

/* -----------------------------------------------------------
   Header: name, avatar
   ----------------------------------------------------------- */
async function populateHeaderIdentity() {
  const { data: profile } = await getMyProfile();
  const nameEl = $('.app-user-name');
  const avatarEl = $('.app-user-trigger .avatar-initial');
  const firstName = profile?.first_name || '';
  const lastName = profile?.last_name || '';

  if (nameEl) nameEl.textContent = `${firstName} ${lastName}`.trim() || 'Your account';
  if (avatarEl) avatarEl.textContent = (firstName[0] || 'M').toUpperCase();
}

/* -----------------------------------------------------------
   User menu dropdown
   ----------------------------------------------------------- */
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

/* -----------------------------------------------------------
   Mobile nav toggle
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

/* -----------------------------------------------------------
   Log out
   ----------------------------------------------------------- */
function initLogout() {
  const logoutLink = $('#logout-link');
  if (!logoutLink) return;

  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    await signOutUser();
    window.location.href = logoutLink.getAttribute('href');
  });
}

/* -----------------------------------------------------------
   Total balance + account strip
   Uses every account the user has, since the balance card is
   meant to represent their whole portfolio, not just one
   currency.
   ----------------------------------------------------------- */
async function renderBalanceAndAccounts(accounts) {
  const balanceEl = $('.dashboard-balance-card .balance-amount');
  const stripEl = $('.account-strip');
  const addItem = stripEl ? stripEl.querySelector('.account-strip-item--add') : null;

  Array.from(stripEl?.querySelectorAll('.account-strip-item:not(.account-strip-item--add)') || []).forEach((el) => el.remove());

  if (!accounts.length) {
    if (balanceEl) {
      unskeleton(balanceEl);
      balanceEl.innerHTML = '0<small>.00 USD</small>';
    }
    return;
  }

  if (balanceEl) {
    const { data: totalData } = await getTotalBalance(undefined, 'USD');
    unskeleton(balanceEl);
    const [intPart, decPart = '00'] = Number(totalData?.total || 0).toFixed(2).split('.');
    balanceEl.innerHTML = `${Number(intPart).toLocaleString('en-US')}<small>.${decPart} USD</small>`;
  }

  if (stripEl) {
    const fragment = document.createDocumentFragment();
    accounts.forEach((account) => {
      const item = document.createElement('a');
      item.href = 'accounts.html';
      item.className = 'account-strip-item';
      item.innerHTML = `
        <span class="account-strip-flag">${currencySymbol(account.currency)}</span>
        <div>
          <strong>${account.currency} account</strong>
          <span>${formatAmount(account.balance)}</span>
        </div>
      `;
      fragment.appendChild(item);
    });

    if (addItem) stripEl.insertBefore(fragment, addItem);
    else stripEl.appendChild(fragment);
  }
}

/* -----------------------------------------------------------
   Recent transactions, spending breakdown, savings goals, and
   card preview — all scoped to a single "primary" account
   (the first one the user opened, per getMyAccounts()'s
   created_at ascending order).

   Why: transactions, savings_goals, and cards all key off a
   single account_id in the schema, not the user directly. A
   fully accurate dashboard would merge these across every
   account the user holds, but that means N extra queries (one
   per account per section) and de-duplicating transfers between
   a user's own accounts. For a dashboard summary, showing the
   primary account's activity — with "View all" links already in
   the markup pointing to accounts.html / transactions.html for
   the full picture — is the simpler, honest tradeoff. Revisit
   this if the product needs a true cross-account activity feed.
   ----------------------------------------------------------- */
async function renderRecentTransactions(accountId) {
  const listEl = $('.tx-list');
  if (!listEl) return;

  const { data: transactions } = await getTransactions(accountId, { limit: 3 });

  if (!transactions.length) {
    emptyStateNote(listEl, "No transactions yet — they'll show up here once money moves.");
    return;
  }

  listEl.innerHTML = '';
  transactions.forEach((tx) => {
    const isIncoming = tx.receiver_account === accountId;
    const row = document.createElement('li');
    row.className = 'tx-row';
    row.innerHTML = `
      <span class="tx-icon ${isIncoming ? 'tx-icon--in' : 'tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          ${isIncoming
            ? '<path d="M10 17V3M4 9l6-6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
            : '<rect x="3" y="6" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>'}
        </svg>
      </span>
      <div class="tx-row-main">
        <strong>${tx.description || tx.transaction_reference || 'Transaction'}</strong>
        <span>${capitalizeWords(tx.transaction_type)}</span>
      </div>
      <span class="amt ${isIncoming ? 'pos' : ''}">${isIncoming ? '+' : '-'}${currencySymbol(tx.currency)}${formatAmount(tx.amount)}</span>
      <time>${formatTxTime(tx.created_at)}</time>
    `;
    listEl.appendChild(row);
  });
}

async function renderSpendingBreakdown(accountId) {
  const listEl = $('.spend-breakdown');
  if (!listEl) return;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: transactions } = await getTransactions(accountId, { from: monthStart.toISOString(), limit: 100 });

  const totals = {};
  transactions.forEach((tx) => {
    if (tx.sender_account !== accountId) return; // only outgoing counts as spend
    const key = tx.transaction_type || 'other';
    totals[key] = (totals[key] || 0) + Number(tx.amount) + Number(tx.fee || 0);
  });

  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    emptyStateNote(listEl, 'No spending recorded yet this month.');
    return;
  }

  const max = entries[0][1];
  listEl.innerHTML = '';
  entries.forEach(([type, amount]) => {
    const row = document.createElement('li');
    row.className = 'spend-row';
    const pct = max > 0 ? Math.max(6, Math.round((amount / max) * 100)) : 0;
    row.innerHTML = `
      <span class="spend-row-label">${capitalizeWords(type)}</span>
      <span class="spend-bar-track"><span class="spend-bar-fill" style="width:${pct}%"></span></span>
      <span class="mono">${formatAmount(amount)}</span>
    `;
    listEl.appendChild(row);
  });
}

async function renderSavingsGoals(accountId) {
  const goalItems = Array.from(document.querySelectorAll('.goal-item'));
  const container = goalItems.length ? goalItems[0].parentElement : null;
  goalItems.forEach((el) => el.remove());
  if (!container) return;

  const { data: goals } = await getSavingsGoals(accountId);

  if (!goals.length) {
    const p = document.createElement('p');
    p.style.fontSize = '0.88rem';
    p.textContent = 'No savings goals yet — start one to track progress here.';
    container.appendChild(p);
    return;
  }

  goals.forEach((goal) => {
    const target = Number(goal.target_amount) || 0;
    const current = Number(goal.current_amount) || 0;
    const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

    const item = document.createElement('div');
    item.className = 'goal-item';
    item.innerHTML = `
      <div class="goal-item-head">
        <strong>${goal.goal_name}</strong>
        <span class="mono">${formatAmount(current)} / ${formatAmount(target)}</span>
      </div>
      <span class="goal-bar-track"><span class="goal-bar-fill" style="width:${pct}%"></span></span>
    `;
    container.appendChild(item);
  });
}

async function renderCardPreview(accountId) {
  const previewEl = $('.mini-card-preview');
  if (!previewEl) return;

  const { data: cards } = await getCardsForAccount(accountId);

  if (!cards.length) {
    // Targets .mini-card-preview itself, not its parent .profile-card
    // — that parent also holds the "Your cards / Manage" heading,
    // which an empty state shouldn't wipe out along with it.
    emptyStateNote(previewEl, "You haven't added a card yet.");
    return;
  }

  const card = cards[0];
  const last4 = (card.card_number || '').slice(-4) || '····';
  const statusClass = card.card_status === 'Active'
    ? 'status-pill--verified'
    : card.card_status === 'Blocked'
      ? 'status-pill--blocked'
      : 'status-pill--pending';

  previewEl.innerHTML = `
    <div class="mini-card mini-card--dark">
      <span>MERIDIAN</span>
      <span class="mono">···· ${last4}</span>
    </div>
    <div>
      <strong>${capitalizeWords(card.card_type)} card</strong>
      <span class="status-pill ${statusClass}">${card.card_status || 'Pending'}</span>
    </div>
  `;
}

async function renderPrimaryAccountSections(accounts) {
  if (!accounts.length) {
    emptyStateNote($('.tx-list'), 'Open your first account to start seeing transactions here.');
    emptyStateNote($('.spend-breakdown'), 'Open your first account to see spending by category.');
    const goalItems = Array.from(document.querySelectorAll('.goal-item'));
    if (goalItems.length) emptyStateNote(goalItems[0].parentElement, 'Open an account to start a savings goal.');
    emptyStateNote($('.mini-card-preview'), 'Open an account to add a card.');
    return;
  }

  const primaryAccountId = accounts[0].id;

  await Promise.all([
    renderRecentTransactions(primaryAccountId),
    renderSpendingBreakdown(primaryAccountId),
    renderSavingsGoals(primaryAccountId),
    renderCardPreview(primaryAccountId),
  ]);
}

/* =============================================================
   LIVE CRYPTO TICKER
   Populates the .ticker-band already in dashboard.html (the same
   component the marketing homepage uses) with real prices from
   CoinGecko's public, key-free endpoint. Refreshes on an interval
   so the band stays "live" while the dashboard is open.
   ============================================================= */
const TICKER_COINS = [
  { id: 'bitcoin', symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'solana', symbol: 'SOL' },
  { id: 'ripple', symbol: 'XRP' },
  { id: 'cardano', symbol: 'ADA' },
  { id: 'dogecoin', symbol: 'DOGE' },
];
const TICKER_REFRESH_MS = 90_000;

async function fetchCryptoPrices() {
  const ids = TICKER_COINS.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
}

function tickerItemMarkup(symbol, price, change) {
  const isUp = change >= 0;
  const priceStr = price >= 1
    ? price.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : price.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return `
    <div class="ticker-item">
      <span class="pair">${esc(symbol)}/USD</span>
      <span class="mono">$${priceStr}</span>
      <span class="delta ${isUp ? 'pos' : 'neg'}">${isUp ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%</span>
    </div>
  `;
}

async function initDashboardTicker() {
  const track = $('#dashboard-ticker-track');
  if (!track) return;

  async function refresh() {
    try {
      const prices = await fetchCryptoPrices();
      const itemsHtml = TICKER_COINS
        .filter((c) => prices[c.id])
        .map((c) => tickerItemMarkup(c.symbol, prices[c.id].usd, prices[c.id].usd_24h_change || 0))
        .join('');
      // Duplicated once so the CSS marquee (if it scrolls the track's
      // full width) loops seamlessly instead of snapping at the end.
      track.innerHTML = itemsHtml + itemsHtml;
    } catch (err) {
      track.innerHTML = '<div class="ticker-item"><span class="pair">Market data unavailable right now</span></div>';
    }
  }

  await refresh();
  setInterval(refresh, TICKER_REFRESH_MS);
}

/* =============================================================
   MARKET PULSE PANEL
   A new card injected into the main column: live crypto prices
   at a glance plus a small finance-headlines feed. If the news
   feed can't be reached, the panel honestly relabels itself
   "Insights" and shows evergreen tips instead of pretending
   stale content is live — never fakes a live feed.
   ============================================================= */
async function fetchFinanceHeadlines() {
  const rssUrl = encodeURIComponent('https://www.cnbc.com/id/10001147/device/rss/rss.html');
  const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}&count=4`);
  if (!res.ok) throw new Error(`rss2json ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok' || !data.items?.length) throw new Error('empty feed');
  return data.items.slice(0, 4).map((item) => ({
    title: item.title,
    link: item.link,
    source: 'CNBC Finance',
  }));
}

const FALLBACK_INSIGHTS = [
  { title: 'Automating a fixed transfer the day you get paid is the single easiest way to make saving stick.' },
  { title: 'Splitting savings into named goals (a trip, an emergency fund) tends to keep money there longer than one generic pot.' },
  { title: 'Reviewing recurring subscriptions once a quarter is a quick way to catch spend creep.' },
  { title: 'Keeping 1–2 months of expenses in an easy-access account covers most short-notice costs without touching savings goals.' },
];

function renderMarketNewsCard(container, items, isLive) {
  const heading = isLive ? 'Market pulse' : 'Insights';
  const sub = isLive ? 'Live headlines' : 'Shown while live headlines are unavailable';

  container.innerHTML = `
    <div class="profile-card-head">
      <h3>
        ${isLive ? '<span class="live-dot" aria-hidden="true"></span>' : ''}
        ${heading}
      </h3>
      <span class="tx-summary-label">${sub}</span>
    </div>
    <ul class="market-news-list">
      ${items.map((item) => `
        <li class="news-item">
          ${item.link
            ? `<a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
            : `<span>${esc(item.title)}</span>`}
          ${item.source ? `<span class="news-item-source">${esc(item.source)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

async function initMarketNewsPanel() {
  const mainCol = $('.dashboard-main-col');
  const balanceCard = $('.dashboard-balance-card');
  if (!mainCol || !balanceCard) return;

  const section = document.createElement('section');
  section.className = 'profile-card market-news-card';
  section.innerHTML = `
    <div class="profile-card-head">
      <h3><span class="live-dot" aria-hidden="true"></span> Market pulse</h3>
      <span class="tx-summary-label">Loading…</span>
    </div>
    <ul class="market-news-list">
      <li class="news-item skeleton" style="height:1.1rem;"></li>
      <li class="news-item skeleton" style="height:1.1rem;"></li>
      <li class="news-item skeleton" style="height:1.1rem;"></li>
    </ul>
  `;
  balanceCard.insertAdjacentElement('afterend', section);

  try {
    const headlines = await fetchFinanceHeadlines();
    renderMarketNewsCard(section, headlines, true);
  } catch (err) {
    renderMarketNewsCard(section, FALLBACK_INSIGHTS, false);
  }
}

/* =============================================================
   AUTOMATION SHOWCASE
   Enhances the existing "Automate your money" upsell card with a
   real, animated stat pulled from the user's own savings goals —
   total currently automated and how many goals it's spread
   across — instead of a generic static pitch.
   ============================================================= */
function animateCount(el, target, { prefix = '', duration = 1100 } = {}) {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const value = from + (target - from) * eased;
    el.textContent = `${prefix}${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function enhanceAutomationShowcase(accountId) {
  const upsell = $('.dashboard-upsell');
  if (!upsell) return;

  const statRow = document.createElement('div');
  statRow.className = 'automation-stat-row';
  const actions = $('.automation-card-actions', upsell);
  if (actions) upsell.insertBefore(statRow, actions);
  else upsell.appendChild(statRow);

  if (!accountId) {
    statRow.innerHTML = `<p class="automation-stat-empty">Open an account to start automating your savings.</p>`;
    return;
  }

  const { data: goals } = await getSavingsGoals(accountId);

  if (!goals?.length) {
    statRow.innerHTML = `<p class="automation-stat-empty">You're not automating any savings yet — start your first goal below.</p>`;
    return;
  }

  const total = goals.reduce((sum, g) => sum + (Number(g.current_amount) || 0), 0);

  statRow.innerHTML = `
    <span class="automation-stat-value mono" id="automation-stat-value">0</span>
    <span class="automation-stat-label">saved automatically across ${goals.length} goal${goals.length === 1 ? '' : 's'}</span>
  `;
  animateCount($('#automation-stat-value', statRow), total, { prefix: '$' });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await guardPage();
  if (!user) return; // guardPage() already redirected to login.html

  populateGreeting();
  populateLastLogin(user.id);
  populateHeaderIdentity();
  populateNotificationBadge();
  initUserMenu();
  initMobileNav();
  initLogout();
  initDashboardTicker();
  initMarketNewsPanel();

  const { data: accounts, error } = await getMyAccounts(user.id);
  if (error) showToast("Couldn't load your accounts. Please refresh.");

  await renderBalanceAndAccounts(accounts || []);
  await renderPrimaryAccountSections(accounts || []);
  await enhanceAutomationShowcase(accounts?.[0]?.id);
})();
