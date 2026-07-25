/* =============================================================
   MERIDIAN — Settings page
   Script: pages/settings.js

   SCHEMA NOTES (read before wiring this up to your real project)
   ----------------------------------------------------------------
   This page persists more than the schema you shared explicitly
   defines. Two different situations, handled two different ways:

   1. General/appearance preferences (language, timezone,
      default_currency, date_format, reduce_motion, compact_list)
      are saved as plain columns on `user_profiles` via
      updateMyProfile() — the same pattern profile.js already uses
      for two_factor_method. Add these columns if they aren't
      there yet; everything else about the call is unchanged.

   2. Linked (external) accounts and API keys don't fit anywhere
      in the existing tables, so this file talks to two new ones
      directly via the shared `supabase` client:

        linked_accounts (id, user_id, bank_name, account_number,
                          currency, status, created_at)
        api_keys        (id, user_id, name, key_prefix,
                          created_at, last_used_at)

      IMPORTANT — API keys: generating and verifying a real secret
      belongs on the server (a Supabase Edge Function that creates
      the key, stores a hash, and returns the plaintext exactly
      once), not in client-side JS. What's here generates a
      demo-quality key locally so the UI is fully functional; swap
      generateApiKeySecret() for a call to your Edge Function
      before this goes anywhere near production.

   Statements, by contrast, are 100% real — built from your actual
   `transactions` table via the existing getTransactions().

   HEADER WIRING — matches profile.js's pattern exactly: the app
   header now loads from components/app-navbar.html via
   components.js's loadComponents(), which can resolve before OR
   after this module's own async init. waitForNavbar() below
   checks whether the navbar markup is already in the DOM and, if
   not, waits for the `component:loaded` event it dispatches once
   injection finishes, before touching anything header-related
   (name, avatar, notification badge, user menu, mobile nav,
   logout). Calling those before the partial lands would just
   silently no-op — every one of them has an early `if (!el)
   return`.
   ============================================================= */

import { getMyProfile, updateMyProfile, getMyAccounts, getTransactions, getUnreadNotificationCount } from '../supabase/database.js';
import { guardPage } from '../supabase/page-guard.js';
import { supabase } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF' };
const currencySymbol = (code) => CURRENCY_SYMBOLS[code] || code || '';
const formatAmount = (value) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let currentUser = null;
let currentProfile = null;
let myAccounts = [];

/* -----------------------------------------------------------
   Toast helper
   ----------------------------------------------------------- */
function toastRegion() {
  let region = $('.profile-toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'profile-toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

function showToast(message, type = 'success') {
  const region = toastRegion();
  const toast = document.createElement('div');
  toast.className = `profile-toast profile-toast--${type}`;
  const icon = type === 'success'
    ? '<path d="M2.5 7 5.5 10 11.5 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  toast.innerHTML = `<span class="ic"><svg viewBox="0 0 14 13" fill="none" aria-hidden="true">${icon}</svg></span><span>${message}</span>`;
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 250);
  }, 3600);
}

function setButtonLoading(button, isLoading) {
  if (!button) return;
  button.classList.toggle('is-loading', isLoading);
  button.disabled = isLoading;
}

/* -----------------------------------------------------------
   Initials / avatar rendering (same pattern as profile.js)
   ----------------------------------------------------------- */
function initials(firstName, lastName) {
  const a = (firstName || '').trim().charAt(0);
  const b = (lastName || '').trim().charAt(0);
  return (a + b).toUpperCase() || 'M';
}

function paintAvatar(url, firstName, lastName) {
  const label = initials(firstName, lastName);

  $$('.avatar-initial--sm, .avatar-initial--lg').forEach((el) => {
    if (url) {
      el.innerHTML = `<img class="avatar-photo" src="${url}" alt="">`;
    } else {
      el.textContent = label;
    }
  });
}

/* -----------------------------------------------------------
   Wait for the app-navbar component
   settings.html loads its header from components/app-navbar.html
   via components.js's loadComponents(), which runs as its own
   module and dispatches `component:loaded` on `document` once
   injection finishes. That can resolve before OR after this
   module's own async init — calling initUserMenu()/initLogout()/
   initMobileNav() before the partial lands means they each query
   for elements that aren't in the DOM yet, silently no-op, and
   never get wired up on that page load. This checks whether the
   navbar markup is already in the DOM first, and only falls back
   to listening for the event if it isn't there yet, so it's
   correct either way.
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
   Header identity + notification badge
   Same approach as dashboard.js / profile.js against the shared
   navbar component (components/app-navbar.html).
   ----------------------------------------------------------- */
function populateHeader(profile) {
  const nameEl = $('.app-user-name');
  if (nameEl) nameEl.textContent = profile?.first_name ? `${profile.first_name} ${profile.last_name || ''}`.trim() : 'Your account';
  paintAvatar(profile?.profile_photo, profile?.first_name, profile?.last_name);
}

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
   Header: user menu, logout, mobile nav
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
  function handleOutsideClick(event) { if (!menu.contains(event.target)) close(); }
  function handleKeydown(event) { if (event.key === 'Escape') { close(); trigger.focus(); } }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
}

/* -----------------------------------------------------------
   Log out — targets the navbar component's #logout-link
   ----------------------------------------------------------- */
function initLogout() {
  const logoutLink = $('#logout-link');
  if (!logoutLink) return;

  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    const { signOutUser } = await import('../supabase/auth.js');
    await signOutUser();
    window.location.href = logoutLink.getAttribute('href');
  });
}

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
   Section navigation (tabs) — same pattern as profile.js
   ----------------------------------------------------------- */
function initSectionNav() {
  const links = $$('.profile-nav-link');
  const panels = $$('.profile-panel');
  if (!links.length || !panels.length) return;

  function activate(tabName, { focusPanel = false, updateHash = true } = {}) {
    const targetLink = links.find((l) => l.dataset.tab === tabName) || links[0];
    const targetPanel = panels.find((p) => p.dataset.panel === targetLink.dataset.tab);
    if (!targetPanel) return;

    links.forEach((l) => l.classList.toggle('is-active', l === targetLink));
    panels.forEach((p) => p.classList.toggle('is-active', p === targetPanel));

    if (updateHash) history.replaceState(null, '', `#${targetLink.dataset.tab}`);
    if (focusPanel) {
      targetPanel.setAttribute('tabindex', '-1');
      targetPanel.focus({ preventScroll: true });
    }
  }

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      activate(link.dataset.tab, { focusPanel: true });
    });
  });

  activate(window.location.hash.replace('#', '') || 'general', { updateHash: false });
}

/* -----------------------------------------------------------
   General settings form
   ----------------------------------------------------------- */
function populateGeneralForm(profile) {
  const form = $('#general-settings-form');
  if (!form) return;
  const setValue = (name, value, fallback) => {
    const field = form.elements[name];
    if (field) field.value = value ?? fallback ?? field.value;
  };
  setValue('language', profile?.language, 'en');
  setValue('timezone', profile?.timezone, 'Africa/Lagos');
  setValue('default_currency', profile?.default_currency, 'USD');
  setValue('date_format', profile?.date_format, 'MDY');
}

function initGeneralForm() {
  const form = $('#general-settings-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const submitBtn = $('button[type="submit"]', form);
    setButtonLoading(submitBtn, true);

    const { data, error } = await updateMyProfile(values, currentUser.id);

    setButtonLoading(submitBtn, false);

    if (error) {
      showToast(error, 'error');
      return;
    }
    currentProfile = { ...currentProfile, ...data };
    showToast('Preferences saved.');
  });
}

/* -----------------------------------------------------------
   Appearance switches
   ----------------------------------------------------------- */
function initAppearanceSwitches(profile) {
  const reduceMotion = $('#pref-reduce-motion');
  const compactList = $('#pref-compact-list');

  if (reduceMotion) {
    reduceMotion.checked = Boolean(profile?.reduce_motion);
    document.documentElement.classList.toggle('force-reduce-motion', reduceMotion.checked);
    reduceMotion.addEventListener('change', async () => {
      document.documentElement.classList.toggle('force-reduce-motion', reduceMotion.checked);
      const { error } = await updateMyProfile({ reduce_motion: reduceMotion.checked }, currentUser.id);
      if (error) { showToast(error, 'error'); return; }
      showToast('Appearance updated.');
    });
  }

  if (compactList) {
    compactList.checked = Boolean(profile?.compact_list);
    compactList.addEventListener('change', async () => {
      const { error } = await updateMyProfile({ compact_list: compactList.checked }, currentUser.id);
      if (error) { showToast(error, 'error'); return; }
      showToast('Appearance updated.');
    });
  }
}

/* -----------------------------------------------------------
   Sign out everywhere
   ----------------------------------------------------------- */
function initSignOutEverywhere() {
  const btn = $('#sign-out-everywhere-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const confirmed = window.confirm('Sign out of every device, including this one?');
    if (!confirmed) return;

    setButtonLoading(btn, true);

    // Close every open session row we've been tracking...
    await supabase
      .from('login_sessions')
      .update({ logout_time: new Date().toISOString() })
      .eq('user_id', currentUser.id)
      .is('logout_time', null);

    // ...then actually revoke every refresh token for this user.
    const { error } = await supabase.auth.signOut({ scope: 'global' });

    setButtonLoading(btn, false);

    if (error) {
      showToast(error.message, 'error');
      return;
    }
    window.location.href = '../index.html';
  });
}

/* -----------------------------------------------------------
   Statements — account select + preview + CSV download
   ----------------------------------------------------------- */
function populateStatementAccountSelect(accounts) {
  const select = $('#statement-account');
  if (!select) return;
  const options = accounts.map((a) => `<option value="${a.id}">${a.currency} account${a.available_balance !== undefined ? ` — ${formatAmount(a.available_balance)}` : ''}</option>`).join('');
  select.innerHTML = `<option value="all">All currencies</option>${options}`;
}

async function fetchStatementTransactions({ accountId, from, to, limit = 500 }) {
  const targetAccounts = accountId === 'all' ? myAccounts.map((a) => a.id) : [accountId];
  const merged = new Map();

  for (const id of targetAccounts) {
    const { data, error } = await getTransactions(id, { from, to, limit });
    if (error) return { data: [], error };
    data.forEach((tx) => merged.set(tx.id || tx.transaction_reference, tx));
  }

  return { data: Array.from(merged.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)), error: null };
}

function toCsv(rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Date', 'Description', 'Type', 'Amount', 'Currency', 'Status', 'Reference'];
  const lines = [header.map(escape).join(',')];
  rows.forEach((tx) => {
    lines.push([
      new Date(tx.created_at).toLocaleString('en-US'),
      tx.description || '',
      tx.transaction_type || '',
      tx.amount,
      tx.currency,
      tx.status,
      tx.transaction_reference,
    ].map(escape).join(','));
  });
  return lines.join('\n');
}

function downloadCsv(rows, filenamePrefix) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderStatementPreview(transactions) {
  const container = $('#statement-preview');
  const countEl = $('.statement-preview-count', container);
  const list = $('.statement-preview-list', container);
  if (!container) return;

  container.hidden = false;
  countEl.textContent = `${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`;

  if (!transactions.length) {
    list.innerHTML = '<li class="statement-preview-empty">No transactions in this range.</li>';
    return;
  }

  list.innerHTML = transactions.slice(0, 20).map((tx) => `
    <li>
      <span class="desc">${tx.description || tx.transaction_reference || 'Transaction'}</span>
      <span class="meta">${new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
      <span class="amt mono">${currencySymbol(tx.currency)}${formatAmount(tx.amount)}</span>
    </li>
  `).join('');
}

function getStatementFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const errorEl = $('#statement-form-error');
  errorEl.textContent = '';

  if (!values.statement_from || !values.statement_to) {
    errorEl.textContent = 'Choose both a start and end date.';
    return null;
  }
  if (new Date(values.statement_from) > new Date(values.statement_to)) {
    errorEl.textContent = 'The start date must be before the end date.';
    return null;
  }
  return values;
}

function initStatementForm() {
  const form = $('#statement-form');
  if (!form) return;

  $('#statement-preview-btn').addEventListener('click', async () => {
    const values = getStatementFormValues(form);
    if (!values) return;

    const btn = $('#statement-preview-btn');
    setButtonLoading(btn, true);
    const { data, error } = await fetchStatementTransactions({
      accountId: values.statement_account,
      from: new Date(values.statement_from).toISOString(),
      to: new Date(`${values.statement_to}T23:59:59`).toISOString(),
    });
    setButtonLoading(btn, false);

    if (error) { showToast(error, 'error'); return; }
    renderStatementPreview(data);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = getStatementFormValues(form);
    if (!values) return;

    const btn = $('#statement-generate-btn');
    setButtonLoading(btn, true);
    const { data, error } = await fetchStatementTransactions({
      accountId: values.statement_account,
      from: new Date(values.statement_from).toISOString(),
      to: new Date(`${values.statement_to}T23:59:59`).toISOString(),
    });
    setButtonLoading(btn, false);

    if (error) { showToast(error, 'error'); return; }
    if (!data.length) { showToast('No transactions in that range to export.', 'error'); return; }

    downloadCsv(data, `meridian-statement-${values.statement_account}`);
    showToast('Statement downloaded.');
  });
}

/* -----------------------------------------------------------
   Monthly statement table (last 3 months, real counts)
   ----------------------------------------------------------- */
async function renderMonthlyStatements() {
  const body = $('#monthly-statement-body');
  if (!body || !myAccounts.length) {
    if (body) body.innerHTML = '<tr><td colspan="4" class="statement-table-empty">Open an account to see statements here.</td></tr>';
    return;
  }

  const months = [];
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    months.push({ start, end, label: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) });
  }

  const rows = await Promise.all(months.map(async (month) => {
    const { data } = await fetchStatementTransactions({
      accountId: 'all',
      from: month.start.toISOString(),
      to: month.end.toISOString(),
      limit: 500,
    });
    return { ...month, count: data.length, data };
  }));

  body.innerHTML = rows.map((row, i) => `
    <tr>
      <td data-label="Period">${row.label}</td>
      <td data-label="Account">All currencies</td>
      <td data-label="Transactions">${row.count}</td>
      <td><button type="button" class="link-arrow-sm" data-month-index="${i}" ${row.count ? '' : 'disabled'}>Download</button></td>
    </tr>
  `).join('');

  $$('button[data-month-index]', body).forEach((btn, i) => {
    btn.addEventListener('click', () => {
      downloadCsv(rows[i].data, `meridian-statement-${rows[i].label.replace(' ', '-').toLowerCase()}`);
      showToast('Statement downloaded.');
    });
  });
}

/* -----------------------------------------------------------
   Linked (external) accounts — table: linked_accounts
   ----------------------------------------------------------- */
async function loadLinkedAccounts() {
  const list = $('#linked-account-list');
  if (!list) return;

  const { data, error } = await supabase
    .from('linked_accounts')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) {
    list.innerHTML = `<li class="linked-account-empty">Couldn't load linked accounts.</li>`;
    return;
  }

  if (!data.length) {
    list.innerHTML = '<li class="linked-account-empty">No external accounts linked yet.</li>';
    return;
  }

  list.innerHTML = data.map((account) => `
    <li class="linked-account-item" data-linked-id="${account.id}">
      <span class="linked-account-icon">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 21V9l8-5 8 5v12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </span>
      <div>
        <strong>${account.bank_name}</strong>
        <span>Account ending ${String(account.account_number).slice(-4)} · ${account.currency}</span>
      </div>
      <span class="status-pill ${account.status === 'verified' ? 'status-pill--verified' : 'status-pill--pending'}">${account.status === 'verified' ? 'Verified' : 'Pending verification'}</span>
      <button type="button" class="wizard-edit-link" data-remove-linked="${account.id}">Remove</button>
    </li>
  `).join('');

  $$('[data-remove-linked]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.removeLinked;
      btn.disabled = true;
      const { error } = await supabase.from('linked_accounts').delete().eq('id', id);
      if (error) {
        showToast(error.message, 'error');
        btn.disabled = false;
        return;
      }
      btn.closest('.linked-account-item').remove();
      if (!list.children.length) list.innerHTML = '<li class="linked-account-empty">No external accounts linked yet.</li>';
      showToast('External account removed.');
    });
  });
}

function initAddLinkedAccount() {
  const openBtn = $('#add-linked-account-btn');
  const overlay = $('#add-linked-modal');
  if (!openBtn || !overlay) return;

  const open = () => { overlay.hidden = false; requestAnimationFrame(() => overlay.classList.add('is-open')); };
  const close = () => { overlay.classList.remove('is-open'); setTimeout(() => { overlay.hidden = true; }, 220); };

  openBtn.addEventListener('click', open);
  $('.modal-close', overlay).addEventListener('click', close);
  $('.modal-cancel', overlay).addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const form = $('#add-linked-form', overlay);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const submitBtn = $('button[type="submit"]', form);
    setButtonLoading(submitBtn, true);

    const { error } = await supabase.from('linked_accounts').insert({
      user_id: currentUser.id,
      bank_name: values.bank_name,
      account_number: values.account_number,
      currency: values.currency,
      status: 'pending',
    });

    setButtonLoading(submitBtn, false);

    if (error) {
      showToast(error.message, 'error');
      return;
    }

    form.reset();
    close();
    showToast('External account added — verification usually takes 1–2 business days.');
    loadLinkedAccounts();
  });
}

/* -----------------------------------------------------------
   Connected apps — read-only list, table: connected_apps
   ----------------------------------------------------------- */
async function loadConnectedApps() {
  const list = $('#connected-apps-list');
  if (!list) return;

  const { data, error } = await supabase
    .from('connected_apps')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error || !data?.length) {
    list.innerHTML = '<li class="linked-account-empty">No third-party apps are connected to your account.</li>';
    return;
  }

  list.innerHTML = data.map((app) => `
    <li class="linked-account-item" data-app-id="${app.id}">
      <span class="linked-account-icon">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.4"/></svg>
      </span>
      <div>
        <strong>${app.name}</strong>
        <span>${app.access_scope || 'Read-only access'} · Connected ${new Date(app.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      </div>
      <button type="button" class="wizard-edit-link" data-revoke-app="${app.id}">Revoke</button>
    </li>
  `).join('');

  $$('[data-revoke-app]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.revokeApp;
      btn.disabled = true;
      const { error } = await supabase.from('connected_apps').delete().eq('id', id);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
      btn.closest('.linked-account-item').remove();
      if (!list.children.length) list.innerHTML = '<li class="linked-account-empty">No third-party apps are connected to your account.</li>';
      showToast('Access revoked.');
    });
  });
}

/* -----------------------------------------------------------
   API keys — table: api_keys
   ----------------------------------------------------------- */
function generateApiKeySecret() {
  // Demo-quality client-side key. In production, replace this whole
  // function with a call to a Supabase Edge Function that generates
  // the key, stores a hash of it, and returns the plaintext once.
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `mrdn_live_${token}`;
}

async function loadApiKeys() {
  const body = $('#api-key-table-body');
  if (!body) return;

  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error || !data?.length) {
    body.innerHTML = '<tr><td colspan="4" class="statement-table-empty">No API keys yet.</td></tr>';
    return;
  }

  body.innerHTML = data.map((key) => `
    <tr data-key-id="${key.id}">
      <td data-label="Name">${key.name}</td>
      <td data-label="Created">${new Date(key.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
      <td data-label="Last used">${key.last_used_at ? new Date(key.last_used_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Never'}</td>
      <td><button type="button" class="wizard-edit-link" data-revoke-key="${key.id}">Revoke</button></td>
    </tr>
  `).join('');

  $$('[data-revoke-key]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.revokeKey;
      btn.disabled = true;
      const { error } = await supabase.from('api_keys').delete().eq('id', id);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
      btn.closest('tr').remove();
      if (!body.children.length) body.innerHTML = '<tr><td colspan="4" class="statement-table-empty">No API keys yet.</td></tr>';
      showToast('API key revoked.');
    });
  });
}

function initApiKeyModal() {
  const openBtn = $('#generate-api-key-btn');
  const overlay = $('#api-key-modal');
  if (!openBtn || !overlay) return;

  const nameStep = $('#api-key-name-step', overlay);
  const revealStep = $('#api-key-reveal-step', overlay);

  const open = () => {
    nameStep.hidden = false;
    revealStep.hidden = true;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
  };
  const close = () => {
    overlay.classList.remove('is-open');
    setTimeout(() => { overlay.hidden = true; }, 220);
  };

  openBtn.addEventListener('click', open);
  $('.modal-close', overlay).addEventListener('click', close);
  $('.modal-cancel', overlay).addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const form = $('#api-key-form', overlay);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = form.elements.key_name.value.trim();
    if (!name) return;

    const submitBtn = $('button[type="submit"]', form);
    setButtonLoading(submitBtn, true);

    const secret = generateApiKeySecret();
    const { error } = await supabase.from('api_keys').insert({
      user_id: currentUser.id,
      name,
      key_prefix: secret.slice(0, 14),
    });

    setButtonLoading(submitBtn, false);

    if (error) {
      showToast(error.message, 'error');
      return;
    }

    $('#api-key-value', overlay).textContent = secret;
    nameStep.hidden = true;
    revealStep.hidden = false;
    form.reset();
    loadApiKeys();
  });

  $('#api-key-copy-btn', overlay).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#api-key-value', overlay).textContent);
      showToast('Key copied — store it somewhere safe.');
    } catch {
      showToast("Couldn't copy — select and copy manually.", 'error');
    }
  });

  $('#api-key-done-btn', overlay).addEventListener('click', close);
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await guardPage();
  if (!user) return;
  currentUser = user;

  // Header-dependent init waits for the app-navbar component to
  // actually be in the DOM — see waitForNavbar() above.
  waitForNavbar().then(() => {
    populateNotificationBadge();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  initSectionNav();
  initGeneralForm();
  initSignOutEverywhere();
  initStatementForm();
  initAddLinkedAccount();
  initApiKeyModal();

  const [{ data: profile }, { data: accounts }] = await Promise.all([
    getMyProfile(user.id),
    getMyAccounts(user.id),
  ]);

  currentProfile = profile;
  myAccounts = accounts || [];

  waitForNavbar().then(() => populateHeader(profile));
  populateGeneralForm(profile);
  initAppearanceSwitches(profile);
  populateStatementAccountSelect(myAccounts);

  renderMonthlyStatements();
  loadLinkedAccounts();
  loadConnectedApps();
  loadApiKeys();
})();
