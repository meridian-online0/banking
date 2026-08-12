/* =============================================================
   MERIDIAN — Send money page
   Script: pages/transfer.js   (REDESIGN)
   Loaded as a module by transfer.html only. Handles:
     1. Auth guard + shared app-header bits (avatar initial, name,
        notification badge, user menu, log out) — unchanged from
        the previous version.
     2. A 5-step wizard: Recipient -> Details -> Review -> Verify
        -> Done. Same steps and same Supabase calls as before; only
        the DOM hooks changed (.send-panel / .send-rail-step instead
        of the old .wizard-panel / .wizard-step).
     3. Recipient step: single account-number/IBAN field that
        auto-verifies via findRecipient() and reveals a recipient
        profile card, or a not-found state with manual fallback
        fields. Saved beneficiaries + a "recent" strip live in a
        collapsed secondary section.
        NOTE: the lookup (and therefore the verified/not-found
        cards) only fires once the typed identifier reaches
        ACCOUNT_NUMBER_MIN_LENGTH characters — see
        handleIdentifierInput(). Below that length nothing renders,
        so the "not found" card can't flash up mid-keystroke or on
        a still-empty field.
     4. Details step: from-account picker, live currency conversion
        via getExchangeRate(), transfer type, purpose, optional
        scheduling.
     5. Review step: read-only summary — edits happen by going back
        to the relevant step.
     6. Verify step: re-confirms identity via verifyCurrentPassword()
        (no OTP delivery exists yet — swap this out once it does,
        see the TODO by handleConfirmSend()). Locks after repeated
        failures.
     7. Send: addBeneficiary() (if the recipient is new and the user
        opted to save them) + createTransfer(), then the success step.
        createTransfer() is now given BOTH a receiverAccountId (only
        when the caller legitimately already has one — not used on
        this page) AND a receiverIdentifier (the raw account
        number/IBAN we have on hand, whatever its source) — the
        process_transfer RPC resolves a real Meridian account from
        that identifier itself, server-side, so a transfer to another
        Meridian user now actually gets credited instead of sitting
        on "Processing" forever. See getRecipientIdentifierForTransfer().

     NEW: a single "Ledger" panel (#ledger) is now the one source of
     truth for recipient + amounts + fees, visible and updating live
     from step 1 through the success screen, instead of a separate
     floating preview + a separate fee panel + a separate review page
     all repeating the same numbers.
   ============================================================= */

import { signOutUser } from '../supabase/auth.js';
import { guardPage } from '../supabase/page-guard.js';
import { verifyCurrentPassword } from '../supabase/auth.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getMyBeneficiaries,
  addBeneficiary,
  findRecipient,
  getExchangeRate,
  createTransfer,
} from '../supabase/database.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF',
};
const RECENT_RECIPIENTS_KEY = 'meridian_recent_recipients';
const TOTAL_STEPS = 5;
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 60000;

// Minimum characters (after stripping whitespace) typed into the
// recipient identifier field before we attempt a lookup at all.
// Below this, we show neither a spinner nor a verified/not-found
// card — just a plain empty field. Meridian's own account numbers
// run 8–10 digits (GBP accounts are 8; USD/others are 10) and IBANs
// are much longer, so 10 avoids false "not found" flashes on a
// half-typed number while still letting IBAN-length input through.
// If you need to support 8-digit GBP account lookups too, lower
// this to 8 — it'll just mean the lookup fires a little earlier.
const ACCOUNT_NUMBER_MIN_LENGTH = 10;

const HERO_COPY = {
  1: {
    title: "Where's this going?",
    sub: "Enter an account number, IBAN, or Meridian tag and we'll verify the recipient automatically — at the mid-market rate, with every fee shown up front.",
  },
  2: {
    title: 'How much are you sending?',
    sub: 'Check the numbers on the right as you type — nothing here is a surprise later.',
  },
  3: {
    title: 'Review your transfer',
    sub: "Take a good look. You can still change anything before you confirm.",
  },
  4: {
    title: "Confirm it's you",
    sub: 'One last check before the money moves.',
  },
  5: {
    title: 'Transfer sent',
    sub: 'Your ledger entry is complete — track it anytime from your transaction history.',
  },
};

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '';
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Toggles visibility of a card/panel two ways at once: the `hidden`
 * IDL/attribute, AND an inline `display` override.
 *
 * Why both: if transfer.html/css gives these cards their own class
 * with a `display` rule (e.g. `.send-recipient-card { display: flex }`
 * for the flex layout), that author rule can out-specificity the
 * browser's built-in `[hidden] { display: none }` UA style — so
 * setting `el.hidden = true` updates the attribute but the element
 * stays visually visible. An inline style always wins, so this
 * can't silently no-op the same way. Also null-safe: if an id
 * doesn't match what's actually in transfer.html, this logs a
 * warning instead of throwing and killing the rest of the handler
 * (a thrown error here would otherwise stop every line after it,
 * which is one way a "still showing" bug can persist indefinitely).
 *
 * IMPORTANT: every visibility toggle in this file goes through this
 * function — never assign `.hidden` directly. Two spots used to do
 * that (the "Send on" scheduled-date field, and the "recent
 * recipients" wrapper); both were silently not hiding for exactly
 * the reason explained above, which is why this rule is now absolute.
 */
function setCardHidden(elId, isHidden) {
  const el = document.getElementById(elId);
  if (!el) {
    console.warn(`[Meridian] transfer.js expected an element with id="${elId}" but didn't find one — check transfer.html.`);
    return;
  }
  el.hidden = isHidden;
  el.style.display = isHidden ? 'none' : '';
}

/* -----------------------------------------------------------
   State
   ----------------------------------------------------------- */
let accounts = [];
let beneficiaries = [];
let currentStep = 1;
let selectedFromAccountId = null;
let selectedBeneficiary = null; // chosen from the saved-beneficiaries list
let verifiedRecipient = null; // { source: 'beneficiary', beneficiary } | { source: 'internal', display_name, bank_name, currency }
let identifierLookupTimer = null;
let authFailedAttempts = 0;
let authLockedUntil = 0;

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
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

/* -----------------------------------------------------------
   Header: name, avatar, notification badge, user menu, logout
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
   Wizard navigation
   ----------------------------------------------------------- */
function goToStep(n) {
  currentStep = n;
  $$('.send-panel').forEach((panel) => panel.classList.toggle('is-active', Number(panel.dataset.panel) === n));
  $$('.send-rail-step').forEach((step) => {
    const stepNum = Number(step.dataset.step);
    step.classList.toggle('is-active', stepNum === n);
    step.classList.toggle('is-complete', stepNum < n);
  });

  const fill = $('#send-rail-fill');
  if (fill) fill.style.width = `${((n - 1) / (TOTAL_STEPS - 1)) * 100}%`;

  const copy = HERO_COPY[n];
  const titleEl = $('#send-hero-title');
  const subEl = $('#send-hero-sub');
  if (copy && titleEl && subEl) {
    titleEl.style.opacity = '0';
    subEl.style.opacity = '0';
    setTimeout(() => {
      titleEl.textContent = copy.title;
      subEl.textContent = n === 2 ? `Sending to ${getRecipientSummary().name || 'your recipient'} — check the numbers as you type.` : copy.sub;
      titleEl.style.opacity = '1';
      subEl.style.opacity = '1';
    }, 120);
  }

  if (n === 2) recalcConversion();
  if (n === 3 || n === 4) populateReview();

  updateLedger();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireSegmented(name) {
  const inputs = $$(`input[name="${name}"]`);
  inputs.forEach((input) => {
    input.addEventListener('change', () => {
      inputs.forEach((i) => i.closest('.send-segmented-btn')?.classList.toggle('is-selected', i.checked));
    });
  });
}

/* -----------------------------------------------------------
   The Ledger — single live summary, updates from step 1 to 5
   ----------------------------------------------------------- */
function updateLedger() {
  const ledger = $('#ledger');
  if (!ledger) return;

  const recipient = getRecipientSummary();
  const hasRecipient = Boolean(recipient.name);

  $('#ledger-avatar').textContent = hasRecipient ? recipient.name.trim().charAt(0).toUpperCase() : '·';
  $('#ledger-name').textContent = hasRecipient ? recipient.name : 'Add a recipient';
  $('#ledger-meta').textContent = hasRecipient ? (recipient.meta || '\u2014') : 'Their details will appear here';
  $('#ledger-seal').classList.toggle('is-visible', hasRecipient && !recipient.isNew);

  const fromAccount = currentFromAccount();
  const sendAmount = Number($('#transfer-send-amount')?.value) || 0;
  const toCurrency = $('#transfer-receive-currency')?.value || 'USD';
  const receiveAmount = Number($('#transfer-receive-amount')?.value) || 0;

  $('#ledger-send-amount').textContent = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)}` : formatAmount(sendAmount);
  $('#ledger-receive-amount').textContent = `${currencySymbol(toCurrency)}${formatAmount(receiveAmount)}`;

  $('#ledger-rate').textContent = $('#fee-rate-note-value')?.textContent || '—';
  $('#ledger-fee').textContent = $('#fee-amount-value')?.textContent || '—';
  $('#ledger-arrives').textContent = $('#fee-arrives-value')?.textContent || '—';
  $('#ledger-available').textContent = $('#fee-available-value')?.textContent || '—';
  $('#ledger-remaining').textContent = $('#fee-remaining-value')?.textContent || '—';
  $('#ledger-total').textContent = $('#fee-total-value')?.textContent || '—';

  const eyebrow = $('#ledger-eyebrow');
  const footText = $('#ledger-foot-text');
  const stamp = $('#ledger-stamp');

  if (currentStep === 5) {
    eyebrow.textContent = 'Transfer receipt';
    footText.textContent = 'Completed transfer';
    ledger.classList.add('is-complete');
    stamp.classList.add('is-visible');
  } else {
    eyebrow.textContent = 'Transfer ledger';
    footText.textContent = 'Verified before every send';
    ledger.classList.remove('is-complete');
    stamp.classList.remove('is-visible');
  }
}

/* -----------------------------------------------------------
   Saved beneficiaries: list, search, select
   ----------------------------------------------------------- */
function maskAccount(value) {
  if (!value) return '';
  const clean = String(value).replace(/\s+/g, '');
  return clean.length > 4 ? `···· ${clean.slice(-4)}` : clean;
}

function beneficiaryInitial(b) {
  return (b?.beneficiary_name || '?').trim().charAt(0).toUpperCase();
}

function beneficiarySubtitle(b) {
  return [b?.bank_name, maskAccount(b?.account_number)].filter(Boolean).join(' · ');
}

function renderBeneficiaryList(filterText = '') {
  const container = $('#beneficiary-list');
  if (!container) return;
  const q = filterText.trim().toLowerCase();

  if (!beneficiaries.length) {
    container.innerHTML = `
      <div class="send-empty">
        <div class="send-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 19.5c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <h3>No saved beneficiaries yet</h3>
        <p>Add a recipient above — you'll be able to choose them here next time.</p>
      </div>
    `;
    return;
  }

  const filtered = beneficiaries.filter(
    (b) => !q || b.beneficiary_name?.toLowerCase().includes(q) || b.bank_name?.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    container.innerHTML = `<p class="balance-note">No saved recipients match "${escapeHtml(filterText)}".</p>`;
    return;
  }

  container.innerHTML = filtered
    .map(
      (b) => `
    <label class="beneficiary-card${selectedBeneficiary?.id === b.id ? ' is-selected' : ''}" data-beneficiary-id="${b.id}">
      <input type="radio" name="beneficiary" value="${b.id}" ${selectedBeneficiary?.id === b.id ? 'checked' : ''}>
      <span class="avatar-initial avatar-initial--sm">${beneficiaryInitial(b)}</span>
      <span class="beneficiary-card-info">
        <strong>${escapeHtml(b.beneficiary_name)}</strong>
        <span>${escapeHtml(beneficiarySubtitle(b))}</span>
      </span>
      <span class="beneficiary-card-check">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    </label>
  `
    )
    .join('');

  $$('.beneficiary-card', container).forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.beneficiaryId;
      selectedBeneficiary = beneficiaries.find((b) => String(b.id) === id) || null;
      // A saved beneficiary takes priority over anything typed into the
      // identifier field — clear that path so the two sources can't disagree.
      resetNewRecipientUi();
      $('#recipient-identifier').value = '';
      $$('.beneficiary-card', container).forEach((c) => c.classList.toggle('is-selected', c === card));
      pushRecentRecipient(selectedBeneficiary);
      updateStep1ContinueState();
      updateLedger();
    });
  });
}

/* -----------------------------------------------------------
   Recent recipients — client-side convenience only (not synced
   to Supabase; just remembers the last few beneficiary ids this
   browser sent to, for a one-tap "recent" strip).
   ----------------------------------------------------------- */
function getRecentIds() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_RECIPIENTS_KEY) || '[]');
  } catch {
    return [];
  }
}

function pushRecentRecipient(b) {
  if (!b?.id) return;
  let ids = getRecentIds().filter((id) => String(id) !== String(b.id));
  ids.unshift(b.id);
  ids = ids.slice(0, 6);
  try {
    localStorage.setItem(RECENT_RECIPIENTS_KEY, JSON.stringify(ids));
  } catch {
    /* ignore quota/availability errors — this is a nice-to-have, not critical */
  }
}

function renderRecentStrip() {
  const wrap = $('#recipient-recent-wrap');
  const strip = $('#recipient-recent-strip');
  if (!wrap || !strip) return;

  const matches = getRecentIds()
    .map((id) => beneficiaries.find((b) => String(b.id) === String(id)))
    .filter(Boolean);

  if (!matches.length) {
    setCardHidden('recipient-recent-wrap', true);
    return;
  }
  setCardHidden('recipient-recent-wrap', false);
  strip.innerHTML = matches
    .map(
      (b) => `
    <button type="button" class="send-quick-chip" data-recent-id="${b.id}" title="${escapeHtml(b.beneficiary_name)}">
      <span class="avatar-initial">${beneficiaryInitial(b)}</span>
      <span>${escapeHtml((b.beneficiary_name || '').split(' ')[0] || '—')}</span>
    </button>
  `
    )
    .join('');

  $$('.send-quick-chip', strip).forEach((chip) => {
    chip.addEventListener('click', () => {
      const b = beneficiaries.find((x) => String(x.id) === chip.dataset.recentId);
      if (!b) return;
      selectedBeneficiary = b;
      resetNewRecipientUi();
      $('#recipient-identifier').value = '';
      $('#beneficiary-search').value = '';
      renderBeneficiaryList('');
      pushRecentRecipient(b);
      updateStep1ContinueState();
      updateLedger();
    });
  });
}

/* -----------------------------------------------------------
   New recipient — account-number auto-verification
   ----------------------------------------------------------- */
function showVerifiedCard({ name, bank, account, country, initial }) {
  $('#recipient-verified-name').textContent = name || '—';
  $('#recipient-verified-bank').textContent = bank || '—';
  $('#recipient-verified-account').textContent = account ? maskAccount(account) : '—';
  $('#recipient-verified-country').textContent = country || '—';
  $('#recipient-verified-avatar').textContent = initial || '?';
  setCardHidden('recipient-verified-card', false);
  setCardHidden('recipient-not-found-card', true);
  setCardHidden('recipient-manual-fields', true);
}

function resetNewRecipientUi() {
  verifiedRecipient = null;
  setCardHidden('recipient-verified-card', true);
  setCardHidden('recipient-not-found-card', true);
  setCardHidden('recipient-manual-fields', true);
  const statusEl = $('#recipient-lookup-status');
  if (statusEl) statusEl.innerHTML = '';
}

function handleIdentifierInput(event) {
  const value = event.target.value;
  clearTimeout(identifierLookupTimer);
  resetNewRecipientUi();
  // Typing a new identifier overrides a previously chosen saved beneficiary.
  selectedBeneficiary = null;
  renderBeneficiaryList($('#beneficiary-search')?.value || '');
  updateStep1ContinueState();
  updateLedger();

  const trimmed = value.trim();
  if (!trimmed) return;

  // Don't attempt a lookup (and therefore don't show a spinner or a
  // verified/not-found card) until the identifier is long enough to
  // plausibly be a real account number — otherwise every partial
  // number briefly flashes "not found" before the person finishes
  // typing, which reads as a false error rather than helpful feedback.
  if (trimmed.replace(/\s+/g, '').length < ACCOUNT_NUMBER_MIN_LENGTH) return;

  const statusEl = $('#recipient-lookup-status');
  statusEl.innerHTML = `<span class="recipient-lookup-spinner"></span> Verifying recipient…`;

  identifierLookupTimer = setTimeout(async () => {
    const { data } = await findRecipient(value, { beneficiaries });

    if (data?.source === 'beneficiary') {
      verifiedRecipient = data;
      const b = data.beneficiary;
      showVerifiedCard({
        name: b.beneficiary_name,
        bank: b.bank_name,
        account: b.account_number,
        country: b.country,
        initial: beneficiaryInitial(b),
      });
      statusEl.innerHTML = '';
    } else if (data?.source === 'internal') {
      verifiedRecipient = data;
      showVerifiedCard({
        name: data.display_name,
        bank: `${data.bank_name} · ${data.currency} Meridian account`,
        account: null,
        country: null,
        initial: (data.display_name || '?').charAt(0).toUpperCase(),
      });
      statusEl.innerHTML = '';
    } else {
      statusEl.innerHTML = '';
      setCardHidden('recipient-not-found-card', false);
      setCardHidden('recipient-manual-fields', false);
      const manualAccountInput = $('#new-beneficiary-account');
      if (manualAccountInput) manualAccountInput.value = value;
    }
    updateStep1ContinueState();
    updateLedger();
  }, 550);
}

function manualFieldsValid() {
  return Boolean(
    $('#new-beneficiary-name').value.trim() &&
    $('#new-beneficiary-bank').value.trim() &&
    $('#new-beneficiary-account').value.trim()
  );
}

function updateStep1ContinueState() {
  const valid = Boolean(selectedBeneficiary) || Boolean(verifiedRecipient) || (!$('#recipient-manual-fields').hidden && manualFieldsValid());
  $('#step1-continue').disabled = !valid;
}

/** A single normalized view of "who are we sending to", regardless
 *  of which of the three recipient paths (saved / internal-verified
 *  / manual) produced it. Read by the ledger, details, review,
 *  verify, and send steps. */
function getRecipientSummary() {
  if (selectedBeneficiary) {
    return {
      name: selectedBeneficiary.beneficiary_name,
      meta: beneficiarySubtitle(selectedBeneficiary),
      currency: null,
      beneficiaryId: selectedBeneficiary.id,
      isNew: false,
    };
  }
  if (verifiedRecipient?.source === 'beneficiary') {
    const b = verifiedRecipient.beneficiary;
    return { name: b.beneficiary_name, meta: beneficiarySubtitle(b), currency: null, beneficiaryId: b.id, isNew: false };
  }
  if (verifiedRecipient?.source === 'internal') {
    return {
      name: verifiedRecipient.display_name,
      meta: `${verifiedRecipient.bank_name} · ${verifiedRecipient.currency}`,
      currency: verifiedRecipient.currency,
      beneficiaryId: null,
      isNew: false,
      isInternal: true,
    };
  }
  const nameVal = $('#new-beneficiary-name')?.value.trim();
  if (!nameVal && !$('#new-beneficiary-bank')?.value.trim()) {
    return { name: '', meta: '', currency: null, beneficiaryId: null, isNew: true };
  }
  const countrySelect = $('#new-beneficiary-country');
  return {
    name: nameVal,
    meta: [$('#new-beneficiary-bank').value.trim(), countrySelect.options[countrySelect.selectedIndex]?.textContent].filter(Boolean).join(' · '),
    currency: null,
    beneficiaryId: null,
    isNew: true,
    manual: {
      beneficiaryName: nameVal,
      bankName: $('#new-beneficiary-bank').value.trim(),
      accountNumber: $('#new-beneficiary-account').value.trim(),
      swiftCode: $('#new-beneficiary-swift').value.trim(),
      country: countrySelect.value,
    },
  };
}

/**
 * The raw account number/IBAN text to send along with the transfer,
 * regardless of which of the three recipient paths produced it.
 * process_transfer() resolves this against real Meridian accounts
 * server-side — if it matches, that account gets credited and the
 * transfer completes; if not, it's treated as a genuine external
 * recipient (exactly as before). This is what makes sending to
 * another Meridian user's account actually arrive, instead of the
 * old behavior where receiverAccountId was always null here.
 */
function getRecipientIdentifierForTransfer() {
  if (selectedBeneficiary?.account_number) return selectedBeneficiary.account_number;
  if (verifiedRecipient?.source === 'beneficiary') return verifiedRecipient.beneficiary?.account_number || null;
  if (verifiedRecipient?.source === 'internal') return $('#recipient-identifier')?.value.trim() || null;
  const manualAccount = $('#new-beneficiary-account')?.value.trim();
  return manualAccount || null;
}

/* -----------------------------------------------------------
   Amount step — from-account picker
   ----------------------------------------------------------- */
function currentFromAccount() {
  return accounts.find((a) => String(a.id) === String(selectedFromAccountId));
}

function renderFromAccountStrip() {
  const strip = $('#from-account-strip');
  if (!strip) return;

  if (!accounts.length) {
    strip.innerHTML = `<p class="balance-note">Open a currency account before you can send money.</p>`;
    return;
  }
  if (!selectedFromAccountId || !currentFromAccount()) selectedFromAccountId = accounts[0].id;

  strip.innerHTML = accounts
    .map((a) => {
      const selected = String(a.id) === String(selectedFromAccountId);
      return `
      <button type="button" class="send-account-pill" data-account-id="${a.id}"
              role="radio" aria-checked="${selected}">
        <span class="send-account-pill-flag">${currencySymbol(a.currency)}</span>
        <span class="send-account-pill-text">
          <strong>${a.currency} account</strong>
          <span>${formatAmount(a.available_balance ?? a.balance)}</span>
        </span>
      </button>
    `;
    })
    .join('');

  $$('.send-account-pill[data-account-id]', strip).forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFromAccountId = btn.dataset.accountId;
      renderFromAccountStrip();
      recalcConversion();
    });
  });
}

/* -----------------------------------------------------------
   Live conversion + fee breakdown
   -----------------------------------------------------------
   DEMO-ONLY FEE MODEL: there's no fee-schedule table in the
   current schema, so this is a simple percentage-with-a-floor
   shape (mirroring how real transfer pricing tends to look)
   rather than a fabricated "real" number. Swap this for a lookup
   against a proper fee schedule (keyed by currency pair + speed)
   once one exists. The computed values are cached in a few hidden
   spans (#fee-*-value) so the ledger can read the same numbers
   without recomputing them.
   ----------------------------------------------------------- */
function computeFee(amount, speed) {
  const amt = Math.max(0, Number(amount) || 0);
  return speed === 'instant' ? Math.max(2.5, +(amt * 0.012).toFixed(2)) : Math.max(1, +(amt * 0.0021).toFixed(2));
}

function ensureFeeCache() {
  if ($('#fee-rate-note-value')) return;
  const cache = document.createElement('div');
  cache.hidden = true;
  cache.innerHTML = `
    <span id="fee-rate-note-value"></span>
    <span id="fee-amount-value"></span>
    <span id="fee-available-value"></span>
    <span id="fee-total-value"></span>
    <span id="fee-remaining-value"></span>
    <span id="fee-arrives-value"></span>
  `;
  document.body.appendChild(cache);
}

async function recalcConversion() {
  ensureFeeCache();
  const fromAccount = currentFromAccount();
  const fromCurrency = fromAccount?.currency || 'USD';
  $('#transfer-send-currency-tag').textContent = fromCurrency;

  const recipient = getRecipientSummary();
  const receiveSelect = $('#transfer-receive-currency');
  if (recipient.currency) {
    receiveSelect.value = recipient.currency;
    receiveSelect.disabled = true;
  } else {
    receiveSelect.disabled = false;
  }
  const toCurrency = receiveSelect.value;

  const sendAmount = Number($('#transfer-send-amount').value) || 0;
  const speed = $('input[name="speed"]:checked')?.value || 'standard';
  const fee = computeFee(sendAmount, speed);

  const { data: rateData } = await getExchangeRate(fromCurrency, toCurrency);
  const rate = Number(rateData?.exchange_rate ?? 1);
  const isFallback = fromCurrency !== toCurrency && rate === 1;
  const receiveAmount = sendAmount * rate;

  $('#transfer-receive-amount').value = receiveAmount.toFixed(2);

  $('#fee-rate-note-value').textContent = `1 ${fromCurrency} = ${rate.toFixed(4)} ${toCurrency}${isFallback ? ' · indicative' : ' · mid-market'}`;
  $('#fee-amount-value').textContent = `${currencySymbol(fromCurrency)}${formatAmount(fee)}`;
  $('#fee-total-value').textContent = `${currencySymbol(fromCurrency)}${formatAmount(sendAmount + fee)}`;
  $('#fee-arrives-value').textContent = speed === 'instant' ? 'Within minutes' : 'Within a few hours';

  const available = Number(fromAccount?.available_balance ?? fromAccount?.balance ?? 0);
  const total = sendAmount + fee;
  $('#fee-available-value').textContent = fromAccount ? `${currencySymbol(fromCurrency)}${formatAmount(available)}` : '—';
  $('#fee-remaining-value').textContent = fromAccount ? `${currencySymbol(fromCurrency)}${formatAmount(Math.max(0, available - total))}` : '—';

  const noteEl = $('#balance-note');
  if (fromAccount && total > available) {
    noteEl.textContent = `Insufficient balance — you have ${currencySymbol(fromCurrency)}${formatAmount(available)} available in this account.`;
    noteEl.classList.add('balance-note--warning');
  } else if (fromAccount) {
    noteEl.textContent = `${currencySymbol(fromCurrency)}${formatAmount(Math.max(0, available - total))} left in this account after sending.`;
    noteEl.classList.remove('balance-note--warning');
  } else {
    noteEl.textContent = '';
  }

  updateLedger();

  return { fromAccount, fromCurrency, toCurrency, sendAmount, fee, rate, receiveAmount, speed, total, available };
}

async function validateStep2() {
  const info = await recalcConversion();
  if (!info.fromAccount) {
    showToast('Open a currency account before sending money.', 'error');
    return false;
  }
  if (info.sendAmount <= 0) {
    showToast('Enter an amount greater than zero.', 'error');
    $('#transfer-send-amount').focus();
    return false;
  }
  if (info.total > info.available) {
    showToast("That's more than the available balance on this account.", 'error');
    return false;
  }
  return true;
}

/* -----------------------------------------------------------
   Review + Verify steps
   ----------------------------------------------------------- */
function formatScheduledDate() {
  const val = $('#schedule-later-datetime').value;
  if (!val) return 'a later date';
  return new Date(val).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function populateReview() {
  const recipient = getRecipientSummary();
  const fromAccount = currentFromAccount();
  const sendAmount = Number($('#transfer-send-amount').value) || 0;
  const speed = $('input[name="speed"]:checked')?.value || 'standard';
  const schedule = $('input[name="schedule"]:checked')?.value || 'now';
  const purpose = $('#transfer-purpose').value;
  const fee = computeFee(sendAmount, speed);
  const receiveAmount = Number($('#transfer-receive-amount').value) || 0;
  const toCurrency = $('#transfer-receive-currency').value;
  const { data: rateData } = await getExchangeRate(fromAccount?.currency || 'USD', toCurrency);
  const rate = Number(rateData?.exchange_rate ?? 1);

  const scheduleText = `${speed === 'instant' ? 'Instant' : 'Standard'} · ${
    schedule === 'later' ? `Scheduled for ${formatScheduledDate()}` : 'Sending now'
  }`;
  const sendAmountText = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)}` : '—';
  const feeText = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(fee)}` : '—';
  const totalText = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount + fee)}` : '—';

  $('[data-review="from_account"]').textContent = fromAccount
    ? `${fromAccount.currency} account · ${currencySymbol(fromAccount.currency)}${formatAmount(fromAccount.available_balance ?? fromAccount.balance)} available`
    : '—';
  $('[data-review="beneficiary"]').textContent = recipient.name || '—';
  $('[data-review="send_amount"]').textContent = sendAmountText;
  $('[data-review="receive_amount"]').textContent = `${currencySymbol(toCurrency)}${formatAmount(receiveAmount)}`;
  $('[data-review="rate"]').textContent = `1 ${fromAccount?.currency || 'USD'} = ${rate.toFixed(4)} ${toCurrency}`;
  $('[data-review="fee"]').textContent = feeText;
  $('[data-review="total"]').textContent = totalText;
  $('[data-review="purpose"]').textContent = purpose;
  $('[data-review="schedule"]').textContent = scheduleText;

  $('[data-review="verify_amount"]').textContent = `${sendAmountText} (total ${totalText})`;
  $('[data-review="verify_recipient"]').textContent = recipient.name || '—';
}

/* -----------------------------------------------------------
   Confirm & send
   ----------------------------------------------------------- */
async function handleConfirmSend() {
  const errorEl = $('#review-error');
  errorEl.style.display = 'none';

  const pwErrorEl = $('#auth-password-error');
  const pwInput = $('#transfer-auth-password');
  pwErrorEl.textContent = '';
  pwInput.closest('.field')?.classList.remove('has-error');

  if (authLockedUntil && Date.now() < authLockedUntil) {
    const secondsLeft = Math.ceil((authLockedUntil - Date.now()) / 1000);
    pwErrorEl.textContent = `Too many attempts. Try again in ${secondsLeft}s.`;
    pwInput.closest('.field')?.classList.add('has-error');
    return;
  }

  const btn = $('#confirm-send-btn');
  btn.disabled = true;
  btn.querySelector('.auth-submit-label').textContent = 'Verifying…';

  // TEMPORARY AUTH STEP: no OTP/2FA delivery exists yet (that lands
  // with the admin dashboard), so we re-check the signed-in user's
  // password as the confirmation step instead. Swap this call for a
  // real code-verification endpoint once that's ready.
  const { data: verified, error: verifyError } = await verifyCurrentPassword(pwInput.value);

  if (!verified) {
    authFailedAttempts += 1;
    btn.disabled = false;
    btn.querySelector('.auth-submit-label').textContent = 'Confirm & send';
    pwInput.closest('.field')?.classList.add('has-error');

    if (authFailedAttempts >= MAX_AUTH_ATTEMPTS) {
      authLockedUntil = Date.now() + AUTH_LOCKOUT_MS;
      pwInput.disabled = true;
      pwErrorEl.textContent = `Too many failed attempts. Try again in ${Math.round(AUTH_LOCKOUT_MS / 1000)}s.`;
      setTimeout(() => {
        authFailedAttempts = 0;
        authLockedUntil = 0;
        pwInput.disabled = false;
        pwErrorEl.textContent = '';
      }, AUTH_LOCKOUT_MS);
    } else {
      pwErrorEl.textContent = verifyError || "That password doesn't match your account.";
      pwInput.value = '';
      pwInput.focus();
    }
    return;
  }

  authFailedAttempts = 0;

  const sendAmount = Number($('#transfer-send-amount').value) || 0;
  const fromAccount = currentFromAccount();
  if (!fromAccount) {
    showToast('Choose an account to send from first.', 'error');
    btn.disabled = false;
    btn.querySelector('.auth-submit-label').textContent = 'Confirm & send';
    return;
  }

  const recipient = getRecipientSummary();
  const speed = $('input[name="speed"]:checked')?.value || 'standard';
  const fee = computeFee(sendAmount, speed);
  const reference = $('#transfer-reference').value.trim();
  const purpose = $('#transfer-purpose').value;

  btn.querySelector('.auth-submit-label').textContent = 'Sending…';

  let beneficiaryRecordId = recipient.beneficiaryId;

  if (recipient.isNew && $('#save-beneficiary-checkbox').checked && recipient.manual?.beneficiaryName) {
    const { data: newBeneficiary, error: benError } = await addBeneficiary(recipient.manual);
    if (benError) {
      showToast(`Couldn't save this recipient: ${benError}`, 'error');
    } else if (newBeneficiary) {
      beneficiaries.push(newBeneficiary);
      beneficiaryRecordId = newBeneficiary.id;
    }
  }

  // receiverAccountId stays null here on purpose — this page never has
  // a real account id for the recipient (find_account_holder() only
  // ever returns a name/bank/currency, by design). Instead we pass
  // receiverIdentifier: the account number/IBAN we have on hand,
  // whatever its source. process_transfer() resolves a real Meridian
  // account from that identifier itself, server-side — if it matches,
  // that account actually gets credited; if not, this behaves exactly
  // like a genuine external wire (debit-only, status 'Processing').
  const { data: tx, error } = await createTransfer({
    senderAccountId: fromAccount.id,
    receiverAccountId: null,
    receiverIdentifier: getRecipientIdentifierForTransfer(),
    amount: sendAmount,
    fee,
    currency: fromAccount.currency,
    description: reference ? `${purpose} — ${reference}` : `${purpose} transfer to ${recipient.name}`,
  });

  btn.disabled = false;
  btn.querySelector('.auth-submit-label').textContent = 'Confirm & send';

  if (error) {
    errorEl.textContent = error;
    errorEl.style.display = 'block';
    showToast(error, 'error');
    return;
  }

  if (beneficiaryRecordId) {
    const saved = beneficiaries.find((b) => b.id === beneficiaryRecordId);
    if (saved) pushRecentRecipient(saved);
  }

  const speedLabel = speed === 'instant' ? 'minutes' : 'a few hours';
  const remainingBalance = Number(fromAccount.available_balance ?? fromAccount.balance ?? 0) - (sendAmount + fee);

  $('#success-reference').textContent = tx.transaction_reference;
  $('#success-status').textContent = tx.status;
  $('#success-balance').textContent = `${currencySymbol(fromAccount.currency)}${formatAmount(Math.max(0, remainingBalance))}`;
  $('#success-message').textContent = tx.status === 'Completed'
    ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)} has been sent to ${recipient.name} and is already available to them.`
    : `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)} is on its way to ${recipient.name}. Most transfers arrive within ${speedLabel}.`;

  pwInput.value = '';
  goToStep(5);
}

/* -----------------------------------------------------------
   Reset wizard for "Send another"
   ----------------------------------------------------------- */
function resetWizard() {
  selectedBeneficiary = null;
  resetNewRecipientUi();
  $('#transfer-form').reset();
  $('#recipient-identifier').value = '';
  $('#beneficiary-search').value = '';
  $('#recipient-saved-toggle').open = false;
  $('#auth-password-error').textContent = '';
  authFailedAttempts = 0;
  authLockedUntil = 0;
  $$('input[name="speed"]').forEach((r) => r.closest('.send-segmented-btn')?.classList.toggle('is-selected', r.checked));
  $$('input[name="schedule"]').forEach((r) => r.closest('.send-segmented-btn')?.classList.toggle('is-selected', r.checked));
  setCardHidden('schedule-later-field', true);
  renderBeneficiaryList('');
  renderRecentStrip();
  renderFromAccountStrip();
  updateStep1ContinueState();
  goToStep(1);
}

/* -----------------------------------------------------------
   Query params — ?from=<accountId> from accounts.html's "Send"
   button, ?beneficiary=<id> for a future "send again" link
   ----------------------------------------------------------- */
function applyQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const fromId = params.get('from');
  if (fromId && accounts.some((a) => String(a.id) === fromId)) selectedFromAccountId = fromId;

  const benId = params.get('beneficiary');
  if (benId) {
    const match = beneficiaries.find((b) => String(b.id) === benId);
    if (match) {
      selectedBeneficiary = match;
      const toggle = $('#recipient-saved-toggle');
      if (toggle) toggle.open = true;
    }
  }
}

/* -----------------------------------------------------------
   Password visibility toggle
   ----------------------------------------------------------- */
function initPasswordToggle() {
  const toggle = $('#auth-password-toggle');
  const input = $('#transfer-auth-password');
  if (!toggle || !input) return;
  toggle.addEventListener('click', () => {
    const showing = toggle.getAttribute('aria-pressed') === 'true';
    toggle.setAttribute('aria-pressed', String(!showing));
    input.type = showing ? 'password' : 'text';
    toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await guardPage();
  if (!user) return; // guardPage() already redirected to login.html

  populateHeader();
  initUserMenu();
  initLogout();
  initPasswordToggle();
  wireSegmented('speed');
  wireSegmented('schedule');

  // Defensive: make sure the verified/not-found recipient cards
  // start hidden regardless of what transfer.html ships as their
  // default markup state. Without this, a "not found" card left
  // visible in the HTML would show up on first load, before the
  // person has typed anything at all.
  resetNewRecipientUi();
  setCardHidden('schedule-later-field', true);

  // Safety net: every button in this form is type="button" on
  // purpose (the wizard advances via JS, never a real submit), but
  // pressing Enter in a lone visible text field can still trigger
  // native form submission in some browsers. Block it so that
  // never reloads the page and wipes wizard state.
  $('#transfer-form').addEventListener('submit', (event) => event.preventDefault());

  $('#beneficiary-search').addEventListener('input', (e) => renderBeneficiaryList(e.target.value));
  $('#recipient-identifier').addEventListener('input', handleIdentifierInput);
  $('#recipient-verified-clear').addEventListener('click', () => {
    resetNewRecipientUi();
    $('#recipient-identifier').value = '';
    $('#recipient-identifier').focus();
    updateStep1ContinueState();
    updateLedger();
  });
  $$('#recipient-manual-fields input, #recipient-manual-fields select').forEach((el) =>
    el.addEventListener('input', () => {
      updateStep1ContinueState();
      updateLedger();
    })
  );

  $$('.send-next').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (currentStep === 2) {
        const ok = await validateStep2();
        if (!ok) return;
      }
      goToStep(Number(btn.dataset.goto));
    });
  });
  $$('.send-back, .send-edit-link[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.goto)));
  });

  $('#transfer-send-amount').addEventListener('input', recalcConversion);
  $('#transfer-receive-currency').addEventListener('change', recalcConversion);
  $$('input[name="speed"]').forEach((r) => r.addEventListener('change', recalcConversion));
  $$('input[name="schedule"]').forEach((r) =>
    r.addEventListener('change', () => {
      setCardHidden('schedule-later-field', $('input[name="schedule"]:checked').value !== 'later');
    })
  );

  $('#confirm-send-btn').addEventListener('click', handleConfirmSend);
  $('#send-another-btn').addEventListener('click', resetWizard);
  $('#copy-reference-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#success-reference').textContent);
      showToast('Reference copied.');
    } catch {
      showToast("Couldn't copy — copy it manually instead.", 'error');
    }
  });

  const [{ data: accs, error: accError }, { data: bens, error: benError }] = await Promise.all([
    getMyAccounts(user.id),
    getMyBeneficiaries(user.id),
  ]);
  if (accError) showToast("Couldn't load your accounts. Please refresh.", 'error');
  if (benError) showToast("Couldn't load your beneficiaries. Please refresh.", 'error');
  accounts = accs || [];
  beneficiaries = bens || [];

  applyQueryParams();
  renderFromAccountStrip();
  renderBeneficiaryList('');
  renderRecentStrip();
  updateStep1ContinueState();
  updateLedger();

  if (!accounts.length) {
    showToast('Open a currency account before you can send money.', 'error');
  }
})();
