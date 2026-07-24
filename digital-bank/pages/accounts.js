/* =============================================================
   MERIDIAN — Accounts page
   Script: pages/accounts.js
   Loaded as a module by accounts.html only. Handles:
     1. Auth guard (redirect to login if no session) + reveal of
        content hidden by the auth-pending class (see auth-guard.js)
     2. Shared app-header bits: avatar initial, name, notification
        badge, user menu dropdown, log out — deferred until the
        app-navbar component (loaded separately by components.js)
        has actually landed in the DOM, see waitForNavbar() below
     3. Fetching the signed-in user's accounts and rendering them
        into the grid, with a skeleton state while loading and an
        empty state if they have none yet
     4. Personal / Business tab filtering
     5. "Add currency account" modal -> createAccount()
     6. "Account details" modal with copy-to-clipboard
     7. A small toast helper reused by both modals
   ============================================================= */

import { requireAuth, signOutUser } from '../supabase/auth.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  createAccount,
} from '../supabase/database.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'US Dollar' },
  { code: 'EUR', symbol: '€', label: 'Euro' },
  { code: 'GBP', symbol: '£', label: 'British Pound' },
  { code: 'SGD', symbol: 'S$', label: 'Singapore Dollar' },
  { code: 'JPY', symbol: '¥', label: 'Japanese Yen' },
  { code: 'NGN', symbol: '₦', label: 'Nigerian Naira' },
  { code: 'CAD', symbol: 'C$', label: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar' },
  { code: 'CHF', symbol: 'CHF', label: 'Swiss Franc' },
];

function currencyMeta(code) {
  return CURRENCIES.find((c) => c.code === code) || { code, symbol: code, label: code };
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let allAccounts = [];
let activeFilter = 'all';
let selectedNewCurrency = null;
let selectedNewType = 'personal';

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
   Wait for the app-navbar component
   accounts.html loads its header from components/app-navbar.html
   via components.js's loadComponents(), which runs as its own
   module and dispatches `component:loaded` on `document` once
   injection finishes. That can resolve before OR after this
   module's own async init (requireAuth() is a network round-trip,
   the component fetch is usually local/fast — but neither order
   is guaranteed). This checks whether the navbar markup is
   already in the DOM first, and only falls back to listening for
   the event if it isn't there yet, so it's correct either way.
   ----------------------------------------------------------- */
function waitForNavbar() {
  return new Promise((resolve) => {
    if ($('.app-user-menu')) {
      resolve();
      return;
    }
    document.addEventListener('component:loaded', () => resolve(), { once: true });
  });
}

/* -----------------------------------------------------------
   Header: greeting name, avatar initial, notification badge
   ----------------------------------------------------------- */
async function populateHeader() {
  const nameEl = $('.app-user-name');
  const avatarEl = $('.app-user-trigger .avatar-initial');

  const { data: profile } = await getMyProfile();
  const firstName = profile?.first_name || '';
  const lastName = profile?.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'Your account';

  if (nameEl) nameEl.textContent = fullName;
  if (avatarEl) avatarEl.textContent = (firstName[0] || 'M').toUpperCase();

  const badge = $('.app-icon-btn-badge');
  if (badge) {
    const { data: count } = await getUnreadNotificationCount();
    if (count) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
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
    if (event.key === 'Escape') {
      close();
      trigger.focus();
    }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
}

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
   Rendering the accounts grid
   ----------------------------------------------------------- */
function accountDetailRows(account) {
  const rows = [];
  if (account.iban) {
    rows.push(['IBAN', account.iban]);
    if (account.swift_code) rows.push(['SWIFT / BIC', account.swift_code]);
  } else if (account.sort_code) {
    rows.push(['Account number', String(account.account_number || '')]);
    rows.push(['Sort code', account.sort_code]);
  } else {
    rows.push(['Account number', String(account.account_number || '')]);
    if (account.swift_code) rows.push(['SWIFT / BIC', account.swift_code]);
  }
  return rows;
}

function accountCardHtml(account) {
  const meta = currencyMeta(account.currency);
  const type = account.account_type || 'personal';
  const subtitle = type === 'business'
    ? (account.business_name || 'Business')
    : account.is_primary
      ? 'Personal · Primary'
      : 'Personal';

  const rows = accountDetailRows(account)
    .map(([label, value]) => `
      <div>
        <dt>${label}</dt>
        <dd class="mono">${value}
          <button type="button" class="copy-btn" data-copy="${value.replace(/[^\w]/g, '')}" aria-label="Copy ${label}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 10.5v-7A1 1 0 0 1 3.5 2.5h7" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
        </dd>
      </div>
    `)
    .join('');

  return `
    <article class="account-detail-card" data-account-id="${account.id}" data-account-type="${type}">
      <div class="account-detail-card-head">
        <span class="account-strip-flag">${meta.symbol}</span>
        <div>
          <strong>${account.currency} account</strong>
          <span>${subtitle}</span>
        </div>
        <span class="status-pill status-pill--verified">Active</span>
      </div>

      <div class="account-detail-balance">
        <span class="tx-summary-label">Available balance</span>
        <span class="balance-amount mono">${meta.symbol}${formatAmount(account.available_balance ?? account.balance)}</span>
      </div>

      <dl class="tx-detail-list">${rows}</dl>

      <div class="account-detail-actions">
        <a href="transfer.html?from=${account.id}" class="btn btn-ghost btn-sm">Send</a>
        <button type="button" class="btn btn-ghost btn-sm" data-view-details="${account.id}">Account details</button>
        <a href="transactions.html?account=${account.id}" class="btn btn-ghost btn-sm">Statement</a>
      </div>
    </article>
  `;
}

function applyFilter() {
  $$('.account-detail-card[data-account-type]').forEach((card) => {
    const matches = activeFilter === 'all' || card.dataset.accountType === activeFilter;
    card.style.display = matches ? '' : 'none';
  });
}

function renderAccounts() {
  const grid = $('#accounts-grid');
  const addTile = $('#add-account-tile');
  if (!grid || !addTile) return;

  $$('.account-detail-card:not(.account-detail-card--add)', grid).forEach((el) => el.remove());

  if (!allAccounts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.gridColumn = '1 / -1';
    empty.textContent = "You don't have any accounts yet — open your first one to get started.";
    grid.insertBefore(empty, addTile);
    return;
  }

  const fragment = document.createDocumentFragment();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = allAccounts.map(accountCardHtml).join('');
  Array.from(wrapper.children).forEach((el) => fragment.appendChild(el));
  grid.insertBefore(fragment, addTile);

  applyFilter();
}

function initTabFilter() {
  const buttons = $$('.tab-toggle-btn[data-account-filter]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      activeFilter = btn.dataset.accountFilter;
      applyFilter();
    });
  });
}

/* -----------------------------------------------------------
   Copy-to-clipboard (event delegation, works on injected cards)
   ----------------------------------------------------------- */
function initCopyDelegation() {
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      showToast('Copied to clipboard.');
    } catch {
      showToast("Couldn't copy — copy it manually instead.", 'error');
    }
  });
}

/* -----------------------------------------------------------
   Modal plumbing (shared by both modals)
   ----------------------------------------------------------- */
function openModal(modal) {
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const firstField = modal.querySelector('input, button, select, textarea');
  firstField?.focus();
}

function closeModal(modal) {
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initModalDismissal() {
  $$('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal(overlay);
    });
    $$('[data-close-modal]', overlay).forEach((btn) => {
      btn.addEventListener('click', () => closeModal(overlay));
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    $$('.modal-overlay.is-open').forEach((overlay) => closeModal(overlay));
  });
}

/* -----------------------------------------------------------
   Account details modal
   ----------------------------------------------------------- */
function initAccountDetailsModal() {
  const modal = $('#account-details-modal');
  if (!modal) return;

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-view-details]');
    if (!trigger) return;
    const account = allAccounts.find((a) => String(a.id) === trigger.dataset.viewDetails);
    if (!account) return;

    const meta = currencyMeta(account.currency);
    $('#account-details-title', modal).textContent = `${account.currency} account details`;
    $('#account-details-list', modal).innerHTML = [
      ['Currency', `${meta.label} (${account.currency})`],
      ['Available balance', `${meta.symbol}${formatAmount(account.available_balance ?? account.balance)}`],
      ...accountDetailRows(account),
    ]
      .map(([label, value]) => `
        <div>
          <dt>${label}</dt>
          <dd class="mono">${value}
            <button type="button" class="copy-btn" data-copy="${String(value).replace(/[^\w.]/g, '')}" aria-label="Copy ${label}">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 10.5v-7A1 1 0 0 1 3.5 2.5h7" stroke="currentColor" stroke-width="1.3"/></svg>
            </button>
          </dd>
        </div>
      `)
      .join('');

    openModal(modal);
  });
}

/* -----------------------------------------------------------
   Add-account modal
   ----------------------------------------------------------- */
function renderCurrencyOptions() {
  const grid = $('#currency-option-grid');
  if (!grid) return;

  const heldByType = (type) => new Set(allAccounts.filter((a) => (a.account_type || 'personal') === type).map((a) => a.currency));
  const held = heldByType(selectedNewType);

  grid.innerHTML = CURRENCIES.map((c) => `
    <button type="button" class="currency-option${c.code === selectedNewCurrency ? ' is-selected' : ''}"
            data-currency-option="${c.code}" ${held.has(c.code) ? 'disabled' : ''}>
      <span>${c.symbol}</span>
      <span>${c.code}</span>
    </button>
  `).join('');

  if (selectedNewCurrency && held.has(selectedNewCurrency)) {
    selectedNewCurrency = null;
    $('#add-account-currency').value = '';
  }
}

function resetAddAccountForm() {
  selectedNewCurrency = null;
  selectedNewType = 'personal';
  $('#add-account-form')?.reset();
  $('#add-account-currency').value = '';
  $('#business-name-field').style.display = 'none';
  $('#add-account-error').style.display = 'none';
  $$('.tab-toggle-btn[data-account-type-option]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.accountTypeOption === 'personal');
  });
  renderCurrencyOptions();
}

function initAddAccountModal() {
  const modal = $('#add-account-modal');
  const openBtn = $('#open-add-account');
  const addTileBtn = $('#add-account-tile');
  const form = $('#add-account-form');
  const errorEl = $('#add-account-error');
  const submitBtn = $('#add-account-submit');
  if (!modal || !form) return;

  [openBtn, addTileBtn].forEach((btn) => {
    btn?.addEventListener('click', () => {
      resetAddAccountForm();
      openModal(modal);
    });
  });

  $('#currency-option-grid').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-currency-option]');
    if (!btn || btn.disabled) return;
    selectedNewCurrency = btn.dataset.currencyOption;
    $('#add-account-currency').value = selectedNewCurrency;
    $$('.currency-option', modal).forEach((el) => el.classList.toggle('is-selected', el === btn));
  });

  $$('.tab-toggle-btn[data-account-type-option]', modal).forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-toggle-btn[data-account-type-option]', modal).forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      selectedNewType = btn.dataset.accountTypeOption;
      $('#business-name-field').style.display = selectedNewType === 'business' ? 'flex' : 'none';
      renderCurrencyOptions();
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.style.display = 'none';

    if (!selectedNewCurrency) {
      errorEl.textContent = 'Choose a currency to continue.';
      errorEl.style.display = 'block';
      return;
    }

    const businessName = $('#add-account-business-name').value;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Opening…';

    const { data, error } = await createAccount({
      currency: selectedNewCurrency,
      accountType: selectedNewType,
      businessName,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Open account';

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    allAccounts.push(data);
    renderAccounts();
    closeModal(modal);
    showToast(`${selectedNewCurrency} account opened.`);
  });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await requireAuth();
  if (!user) return; // requireAuth() already redirected to login.html

  // Reveal content now that a real session is confirmed — see
  // assets/js/auth-guard.js for the fast pre-check that hid it.
  document.body.classList.remove('auth-pending');

  // Header-dependent init waits for the app-navbar component to
  // actually be in the DOM — see waitForNavbar() above.
  waitForNavbar().then(() => {
    populateHeader();
    initUserMenu();
    initLogout();
  });

  initTabFilter();
  initCopyDelegation();
  initModalDismissal();
  initAccountDetailsModal();
  initAddAccountModal();

  const { data: accounts, error } = await getMyAccounts(user.id);
  if (error) {
    showToast("Couldn't load your accounts. Please refresh.", 'error');
  }
  allAccounts = accounts || [];
  renderAccounts();
})();
