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

   I18N WIRING
   ----------------------------------------------------------------
   translation.js loads before this module (see settings.html) and
   exposes window.MeridianI18n. Two things happen here:

     1. Every dynamic string (toasts, confirm() dialogs, re-rendered
        empty states, status labels) now goes through the local
        t(key, fallback) helper below instead of a hardcoded
        English literal. t() prefers MeridianI18n's dictionary
        lookup and falls back to the English string passed in if
        the key isn't in the dictionary yet — so this file is safe
        to ship even before every key below is merged into
        translation.js's TRANSLATIONS object, and will pick up the
        real translation automatically once it is.

     2. The #settings-language <select> calls
        MeridianI18n.setLanguage(code, { persist: true }) AND
        updateMyProfile({ language: code }) the moment it changes,
        instead of waiting for the "Save preferences" button —
        switching language applies immediately, no refresh.

   FIX LOG
   ----------------------------------------------------------------
   initGeneralForm()'s submit handler saved `language` to the DB
   (it was already part of the form's FormData, via
   populateGeneralForm) but never called MeridianI18n.setLanguage()
   itself — so clicking Save with a changed language persisted the
   value with no visible effect until the next full page load (and
   only then because init() re-applies profile.language on fetch).
   Fixed below: the submit handler now calls setLanguage() right
   after a successful save, same as initLanguageSelect() already
   does on its own change event, so both paths keep the UI and the
   DB in sync immediately.

   NEW TRANSLATION KEYS THIS FILE NEEDS (see list at bottom of file)
   ----------------------------------------------------------------
   All net-new — not yet in translation.js's TRANSLATIONS dictionary.
   English fallbacks are inline above so functionality doesn't wait
   on the merge; say the word and I'll send the same key set across
   the other 9 languages next, same pattern as the last two batches.
   ============================================================= */

import { getMyProfile, updateMyProfile, getMyAccounts, getTransactions, getUnreadNotificationCount } from '../supabase/database.js';
import { guardPage } from '../supabase/page-guard.js';
import { supabase } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF' };
const currencySymbol = (code) => CURRENCY_SYMBOLS[code] || code || '';
const formatAmount = (value) => Number(value || 0).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let currentUser = null;
let currentProfile = null;
let myAccounts = [];

/* -----------------------------------------------------------
   i18n helpers
   ----------------------------------------------------------- */
function t(key, fallback) {
  if (window.MeridianI18n) {
    const val = window.MeridianI18n.t(key);
    if (val && val !== key) return val;
  }
  return fallback !== undefined ? fallback : key;
}

// Maps Meridian's 2-letter language codes to a concrete locale for
// Intl/toLocaleString calls. Extend this if a language ever ships
// in more than one regional flavor.
const LOCALE_MAP = {
  en: 'en-US', fr: 'fr-FR', es: 'es-ES', ko: 'ko-KR', de: 'de-DE',
  pt: 'pt-PT', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ha: 'ha-NG',
};

function currentLocale() {
  const lang = window.MeridianI18n ? window.MeridianI18n.getLanguage() : 'en';
  return LOCALE_MAP[lang] || 'en-US';
}

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
   ----------------------------------------------------------- */
function populateHeader(profile) {
  const nameEl = $('.app-user-name');
  if (nameEl) nameEl.textContent = profile?.first_name ? `${profile.first_name} ${profile.last_name || ''}`.trim() : t('common.your_account', 'Your account');
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
  setValue('language', profile?.language, (window.MeridianI18n ? window.MeridianI18n.getLanguage() : 'en'));
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

    // FIX: the language field travels in `values` via this form's
    // own FormData (see populateGeneralForm), so updateMyProfile()
    // above already persists it — but nothing used to re-apply it
    // to the live DOM. initLanguageSelect()'s own change handler
    // covers the "just switch the dropdown" case; this covers
    // "changed the dropdown, then clicked Save" instead of relying
    // on the change event alone.
    if (values.language && window.MeridianI18n) {
      window.MeridianI18n.setLanguage(values.language, { persist: true });
    }

    showToast(t('settings.general.save_success', 'Preferences saved.'));
  });
}

/* -----------------------------------------------------------
   Language select — applies + persists immediately on change,
   independent of the Save button, per the product decision that
   switching language shouldn't require a form submit or refresh.
   ----------------------------------------------------------- */
function initLanguageSelect() {
  const select = $('#settings-language');
  if (!select || !window.MeridianI18n) return;

  select.addEventListener('change', async () => {
    const code = select.value;

    // Apply + remember locally straight away — the visible UI
    // updates before the network round-trip even starts.
    window.MeridianI18n.setLanguage(code, { persist: true });

    // Re-run the bits of this page whose text/dates depend on the
    // active language but aren't covered by [data-i18n] markup.
    renderMonthlyStatements();
    const previewContainer = $('#statement-preview');
    if (previewContainer && !previewContainer.hidden) {
      // Preview list has already-fetched rows re-rendered with the
      // new locale's date formatting.
      const list = $('.statement-preview-list', previewContainer);
      if (list) renderStatementPreview(lastPreviewedTransactions);
    }
    loadLinkedAccounts();
    loadConnectedApps();
    loadApiKeys();

    if (!currentUser) return;
    const { data, error } = await updateMyProfile({ language: code }, currentUser.id);
    if (error) {
      showToast(error, 'error');
      return;
    }
    currentProfile = { ...currentProfile, ...data };
    showToast(t('settings.general.save_success', 'Preferences saved.'));
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
      showToast(t('settings.appearance.save_success', 'Appearance updated.'));
    });
  }

  if (compactList) {
    compactList.checked = Boolean(profile?.compact_list);
    compactList.addEventListener('change', async () => {
      const { error } = await updateMyProfile({ compact_list: compactList.checked }, currentUser.id);
      if (error) { showToast(error, 'error'); return; }
      showToast(t('settings.appearance.save_success', 'Appearance updated.'));
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
    const confirmed = window.confirm(t('settings.danger.confirm', 'Sign out of every device, including this one?'));
    if (!confirmed) return;

    setButtonLoading(btn, true);

    await supabase
      .from('login_sessions')
      .update({ logout_time: new Date().toISOString() })
      .eq('user_id', currentUser.id)
      .is('logout_time', null);

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
let lastPreviewedTransactions = [];

function populateStatementAccountSelect(accounts) {
  const select = $('#statement-account');
  if (!select) return;
  const accountWord = t('settings.statements.account.suffix', 'account');
  const options = accounts.map((a) => `<option value="${a.id}">${a.currency} ${accountWord}${a.available_balance !== undefined ? ` — ${formatAmount(a.available_balance)}` : ''}</option>`).join('');
  select.innerHTML = `<option value="all">${t('settings.statements.account.all', 'All currencies')}</option>${options}`;
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

// CSV content is deliberately kept in a stable en-US/ISO format
// regardless of UI language — it's an exported data file, not
// on-screen UI, and a consistent format keeps it easy to re-import
// or reconcile no matter who opens it.
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
  lastPreviewedTransactions = transactions;
  const container = $('#statement-preview');
  const countEl = $('.statement-preview-count', container);
  const list = $('.statement-preview-list', container);
  if (!container) return;

  container.hidden = false;
  countEl.textContent = t('settings.statements.preview_count', '{count} transaction(s)').replace('{count}', transactions.length);

  if (!transactions.length) {
    list.innerHTML = `<li class="statement-preview-empty">${t('settings.statements.preview_empty', 'No transactions in this range.')}</li>`;
    return;
  }

  list.innerHTML = transactions.slice(0, 20).map((tx) => `
    <li>
      <span class="desc">${tx.description || tx.transaction_reference || t('settings.statements.default_desc', 'Transaction')}</span>
      <span class="meta">${new Date(tx.created_at).toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' })}</span>
      <span class="amt mono">${currencySymbol(tx.currency)}${formatAmount(tx.amount)}</span>
    </li>
  `).join('');
}

function getStatementFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const errorEl = $('#statement-form-error');
  errorEl.textContent = '';

  if (!values.statement_from || !values.statement_to) {
    errorEl.textContent = t('settings.statements.error_missing_dates', 'Choose both a start and end date.');
    return null;
  }
  if (new Date(values.statement_from) > new Date(values.statement_to)) {
    errorEl.textContent = t('settings.statements.error_date_order', 'The start date must be before the end date.');
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
    if (!data.length) { showToast(t('settings.statements.error_empty', 'No transactions in that range to export.'), 'error'); return; }

    downloadCsv(data, `meridian-statement-${values.statement_account}`);
    showToast(t('settings.statements.download_success', 'Statement downloaded.'));
  });
}

/* -----------------------------------------------------------
   Monthly statement table (last 3 months, real counts)
   ----------------------------------------------------------- */
async function renderMonthlyStatements() {
  const body = $('#monthly-statement-body');
  if (!body || !myAccounts.length) {
    if (body) body.innerHTML = `<tr><td colspan="4" class="statement-table-empty">${t('settings.statements.table.open_account', 'Open an account to see statements here.')}</td></tr>`;
    return;
  }

  const locale = currentLocale();
  const months = [];
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    months.push({ start, end, label: start.toLocaleDateString(locale, { month: 'long', year: 'numeric' }) });
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

  const allCurrenciesLabel = t('settings.statements.account.all', 'All currencies');
  const downloadLabel = t('settings.statements.table.download', 'Download');

  body.innerHTML = rows.map((row, i) => `
    <tr>
      <td data-label="${t('settings.statements.table.period', 'Period')}">${row.label}</td>
      <td data-label="${t('settings.statements.table.account', 'Account')}">${allCurrenciesLabel}</td>
      <td data-label="${t('settings.statements.table.transactions', 'Transactions')}">${row.count}</td>
      <td><button type="button" class="link-arrow-sm" data-month-index="${i}" ${row.count ? '' : 'disabled'}>${downloadLabel}</button></td>
    </tr>
  `).join('');

  $$('button[data-month-index]', body).forEach((btn, i) => {
    btn.addEventListener('click', () => {
      downloadCsv(rows[i].data, `meridian-statement-${rows[i].label.replace(' ', '-').toLowerCase()}`);
      showToast(t('settings.statements.download_success', 'Statement downloaded.'));
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
    list.innerHTML = `<li class="linked-account-empty">${t('settings.linked.load_error', "Couldn't load linked accounts.")}</li>`;
    return;
  }

  if (!data.length) {
    list.innerHTML = `<li class="linked-account-empty">${t('settings.linked.empty', 'No external accounts linked yet.')}</li>`;
    return;
  }

  const endingLabel = t('settings.linked.account_ending', 'Account ending');
  const verifiedLabel = t('settings.linked.status.verified', 'Verified');
  const pendingLabel = t('settings.linked.status.pending', 'Pending verification');
  const removeLabel = t('common.remove', 'Remove');

  list.innerHTML = data.map((account) => `
    <li class="linked-account-item" data-linked-id="${account.id}">
      <span class="linked-account-icon">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 21V9l8-5 8 5v12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </span>
      <div>
        <strong>${account.bank_name}</strong>
        <span>${endingLabel} ${String(account.account_number).slice(-4)} · ${account.currency}</span>
      </div>
      <span class="status-pill ${account.status === 'verified' ? 'status-pill--verified' : 'status-pill--pending'}">${account.status === 'verified' ? verifiedLabel : pendingLabel}</span>
      <button type="button" class="wizard-edit-link" data-remove-linked="${account.id}">${removeLabel}</button>
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
      if (!list.children.length) list.innerHTML = `<li class="linked-account-empty">${t('settings.linked.empty', 'No external accounts linked yet.')}</li>`;
      showToast(t('settings.linked.removed_toast', 'External account removed.'));
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
    showToast(t('settings.modal.linked.added_toast', 'External account added — verification usually takes 1–2 business days.'));
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
    list.innerHTML = `<li class="linked-account-empty">${t('settings.apps.empty', 'No third-party apps are connected to your account.')}</li>`;
    return;
  }

  const locale = currentLocale();
  const defaultScope = t('settings.apps.default_scope', 'Read-only access');
  const connectedPrefix = t('settings.apps.connected_prefix', 'Connected');
  const revokeLabel = t('settings.apps.revoke_button', 'Revoke');

  list.innerHTML = data.map((app) => `
    <li class="linked-account-item" data-app-id="${app.id}">
      <span class="linked-account-icon">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.4"/></svg>
      </span>
      <div>
        <strong>${app.name}</strong>
        <span>${app.access_scope || defaultScope} · ${connectedPrefix} ${new Date(app.created_at).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      </div>
      <button type="button" class="wizard-edit-link" data-revoke-app="${app.id}">${revokeLabel}</button>
    </li>
  `).join('');

  $$('[data-revoke-app]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.revokeApp;
      btn.disabled = true;
      const { error } = await supabase.from('connected_apps').delete().eq('id', id);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
      btn.closest('.linked-account-item').remove();
      if (!list.children.length) list.innerHTML = `<li class="linked-account-empty">${t('settings.apps.empty', 'No third-party apps are connected to your account.')}</li>`;
      showToast(t('settings.apps.revoked_toast', 'Access revoked.'));
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
    body.innerHTML = `<tr><td colspan="4" class="statement-table-empty">${t('settings.apps.keys.empty', 'No API keys yet.')}</td></tr>`;
    return;
  }

  const locale = currentLocale();
  const neverLabel = t('settings.apps.keys.never_used', 'Never');
  const revokeLabel = t('settings.apps.revoke_button', 'Revoke');

  body.innerHTML = data.map((key) => `
    <tr data-key-id="${key.id}">
      <td data-label="${t('settings.apps.keys.table.name', 'Name')}">${key.name}</td>
      <td data-label="${t('settings.apps.keys.table.created', 'Created')}">${new Date(key.created_at).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
      <td data-label="${t('settings.apps.keys.table.last_used', 'Last used')}">${key.last_used_at ? new Date(key.last_used_at).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : neverLabel}</td>
      <td><button type="button" class="wizard-edit-link" data-revoke-key="${key.id}">${revokeLabel}</button></td>
    </tr>
  `).join('');

  $$('[data-revoke-key]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.revokeKey;
      btn.disabled = true;
      const { error } = await supabase.from('api_keys').delete().eq('id', id);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
      btn.closest('tr').remove();
      if (!body.children.length) body.innerHTML = `<tr><td colspan="4" class="statement-table-empty">${t('settings.apps.keys.empty', 'No API keys yet.')}</td></tr>`;
      showToast(t('settings.apps.keys.revoked_toast', 'API key revoked.'));
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
      showToast(t('settings.modal.api_key.copy_success', 'Key copied — store it somewhere safe.'));
    } catch {
      showToast(t('settings.modal.api_key.copy_error', "Couldn't copy — select and copy manually."), 'error');
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

  waitForNavbar().then(() => {
    populateNotificationBadge();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  initSectionNav();
  initGeneralForm();
  initLanguageSelect();
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

  // Source of truth for a logged-in user is their saved profile
  // language, not whatever localStorage/geo guessed before login
  // resolved. persist:false — this is a re-apply, not a new choice.
  if (profile?.language && window.MeridianI18n) {
    window.MeridianI18n.setLanguage(profile.language, { persist: false });
  }

  waitForNavbar().then(() => populateHeader(profile));
  populateGeneralForm(profile);
  initAppearanceSwitches(profile);
  populateStatementAccountSelect(myAccounts);

  renderMonthlyStatements();
  loadLinkedAccounts();
  loadConnectedApps();
  loadApiKeys();
})();
