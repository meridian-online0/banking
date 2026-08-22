/* =============================================================
   MERIDIAN — International Digital Banking
   Script: pages/profile.js
   Loaded as a module by profile.html only. Wires up:
     1. Screen-stack navigation (root → sublist/content, back, history)
     2. Password show/hide toggles
     3. Profile banner + Personal info (read-only display)
     4. Overview summary cards + activity
     5. Security > Password, Two-factor (display only), Sessions
     6. Account & security > Login settings (password, forgot
        password, session preference, Face ID — status only)
     7. Account & security > Account limits (info, Linked ID,
        accepted docs, document upload)
     8. Danger zone (no backend yet — honest placeholders)
     9. Avatar upload

   -----------------------------------------------------------
   I18N WIRING — added in THIS pass, same method settings.js uses:

     1. The local t(key, fallback) helper below prefers
        window.MeridianI18n's dictionary lookup and falls back to
        the English string passed in if the key isn't in the
        dictionary yet — so every dynamic string in this file
        (toasts, re-rendered lists, status labels, confirm
        dialogs) is safe to ship even before these keys are
        merged into translation.js's TRANSLATIONS object, and
        will pick up the real translation automatically once
        they are. Static markup with data-i18n attributes in
        profile.html is handled by translation.js itself, same
        as everywhere else — this file only ever needed to cover
        the strings it builds dynamically in JS.

     2. currentLocale() maps MeridianI18n's active 2-letter
        language code to a concrete locale for
        toLocaleString()/toLocaleDateString() calls (session
        timestamps, etc.) — previously these always formatted in
        the browser's default locale regardless of the user's
        chosen Meridian language.

     3. init() now re-applies profile.language via
        MeridianI18n.setLanguage(profile.language, { persist:
        false }) once the profile loads — same as settings.js —
        so a returning user's saved language preference is
        honored on this page too, not just on settings.html.
        persist:false because this is a re-apply of an existing
        choice, not a new one.

   translation.js and its window.MeridianI18n global are expected
   to already be loaded before this module runs — same load order
   as settings.html (translation.js, then this script). If
   profile.html doesn't yet load translation.js, t() still works
   correctly (falls back to the English string every time) — it's
   only fully "live" once that script tag + a data-i18n pass over
   profile.html's static markup are added.

   See the NEW TRANSLATION KEYS list at the bottom of this file —
   same as settings.js's own fix log, these are all net-new and
   not yet in translation.js's TRANSLATIONS dictionary. English
   fallbacks are inline above so functionality doesn't wait on the
   merge.

   -----------------------------------------------------------
   KNOWN GAPS / ASSUMPTIONS — flagged rather than silently
   guessed, per the files actually available at the time this
   was written:

   - AVATAR FIELD MISMATCH: storage.js's uploadAvatar() writes
     user_profiles.profile_photo, but auth-ui.js reads
     user_profiles.avatar_url. These look like two different
     column names for the same thing. This file reads whichever
     is present (avatar_url first, profile_photo as fallback) so
     the photo shows up either way, but the underlying mismatch
     should be fixed in the schema/storage.js — right now a
     photo uploaded here may not be picked up by auth-ui.js's
     header rendering (or vice versa) depending on which column
     actually exists.
   - SESSIONS: database.js has no exported "list my sessions"
     function. fetchLoginSessions() below queries the
     login_sessions table directly (the same table auth.js
     already reads/writes), assuming an owner-scoped SELECT RLS
     policy exists. If it doesn't yet, this section will just
     show "no sessions on record" rather than break the page.
   - ACTIVITY LIST: no exported getter exists for audit_logs (or
     any activity feed) in database.js, so the Overview activity
     list honestly says it isn't wired up yet instead of spinning
     forever or fabricating entries.
   - NOTIFICATION PREFERENCES: still no known user_profiles
     column for these, so the toggles remain UI feedback only
     (not persisted server-side) and say so in their toast text.
     (Login session preference — previously flagged the same way
     — is now backed by user_profiles.login_session_preference
     per migration 016 PART D and is persisted for real below.
     Per that migration's own honesty note, the column records
     stated intent only; it doesn't yet shorten or lengthen any
     actual Supabase session.)
   - ACCOUNT TIER: backed by user_profiles.account_tier
     (migration 016 PART A — admin-write-only via a DB trigger).
     Tier badges render the real value; this file never attempts
     to write it.
   - ACCOUNT NUMBER: user_profiles.account_number (migration 016
     PART B) is the single, stable, server-generated customer
     number shown on Account information — distinct from each
     currency account's own account_number/iban on the `accounts`
     table. The reveal toggle reads the former, not a currency
     account's number.
   - DANGER ZONE (data export / close account): no backend
     functions exist yet, so both buttons show an honest "not
     available yet — contact support" message instead of doing
     nothing silently or faking success.
   - AVATAR FILE INPUT: profile.html's .profile-avatar-edit
     button has no associated <input type="file">. One is
     created here in JS rather than editing that markup.
   - FACE ID: per instruction, left for later. This file only
     reads and displays real state (via getMyWebauthnCredentials
     — a credential existing means "enabled") and disables the
     enable/disable button with a "Coming soon" label. It does
     NOT attempt navigator.credentials.create()/get() or any
     enrollment/login flow.
   ============================================================= */

import { getCurrentUser, updateUserPassword, verifyCurrentPassword, requestPasswordReset } from '../supabase/auth.js';
import {
  getMyProfile,
  getMyAccounts,
  getCardsForAccount,
  getMyIdentityDocuments,
  getMyWebauthnCredentials,
  submitIdentityDocument,
} from '../supabase/database.js';
import { uploadAvatar } from '../supabase/storage.js';
import { supabase } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

let currentUser = null;
let currentProfile = null;
let screenStack = null;

/* -----------------------------------------------------------
   NEW — i18n helpers (same method settings.js uses)
   ----------------------------------------------------------- */
function t(key, fallback) {
  if (window.MeridianI18n) {
    const val = window.MeridianI18n.t(key);
    if (val && val !== key) return val;
  }
  return fallback !== undefined ? fallback : key;
}

// Maps Meridian's 2-letter language codes to a concrete locale for
// Intl/toLocaleString calls — same map as settings.js, kept in
// sync with it. Extend both if a language ever ships in more than
// one regional flavor.
const LOCALE_MAP = {
  en: 'en-US', fr: 'fr-FR', es: 'es-ES', ko: 'ko-KR', de: 'de-DE',
  pt: 'pt-PT', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ha: 'ha-NG',
};

function currentLocale() {
  const lang = window.MeridianI18n ? window.MeridianI18n.getLanguage() : 'en';
  return LOCALE_MAP[lang] || 'en-US';
}

/* -----------------------------------------------------------
   Small shared helpers
   ----------------------------------------------------------- */

function getInitials(name) {
  return (
    String(name || '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || '·'
  );
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Mirrors auth-ui.js's renderAvatar() locally — that function isn't exported, so this page owns its own copy for the elements it controls. */
function renderAvatarLocal(el, avatarUrl, initials) {
  if (!el) return;
  const existingImg = el.querySelector('img.avatar-image');
  if (avatarUrl) {
    const img = existingImg || document.createElement('img');
    img.className = 'avatar-image';
    img.alt = '';
    img.onerror = () => {
      img.remove();
      el.classList.remove('has-avatar-image');
      el.textContent = initials;
    };
    img.src = avatarUrl;
    if (!existingImg) {
      el.textContent = '';
      el.appendChild(img);
    }
    el.classList.add('has-avatar-image');
  } else {
    if (existingImg) existingImg.remove();
    el.classList.remove('has-avatar-image');
    el.textContent = initials;
  }
}

function currentFullName() {
  return document.querySelector('.profile-banner-identity h1')?.textContent?.trim() || '';
}

/* -----------------------------------------------------------
   Toast — uses the canonical #toast-stack element from
   components.css, but doesn't assume any specific class names
   from that (unseen) file — styled inline so it renders
   correctly regardless of what components.css defines.
   ----------------------------------------------------------- */
function toast(message, tone = 'success') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = `
    display:flex;align-items:center;gap:.6rem;
    background:${tone === 'error' ? '#c0453b' : '#0a1628'};
    color:#f6f5f0;padding:.85rem 1.1rem;border-radius:14px;
    box-shadow:0 20px 60px -20px rgba(10,22,40,.35);
    font-size:.87rem;font-weight:500;max-width:340px;
    opacity:0;transform:translateY(8px);
    transition:opacity .2s ease, transform .2s ease;
  `;
  el.textContent = message;
  stack.appendChild(el);

  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });

  window.setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    window.setTimeout(() => el.remove(), 250);
  }, 4200);
}

/* -----------------------------------------------------------
   1. Screen-stack navigation
   ----------------------------------------------------------- */
function initScreenStack() {
  const stack = document.getElementById('settings-stack');
  if (!stack) return null;

  function showScreen(id, { pushHistory = true } = {}) {
    const target = document.getElementById(id);
    if (!target) return;
    const current = stack.querySelector('.settings-screen.is-active');
    if (current === target) return;
    if (current) current.classList.remove('is-active');
    target.classList.add('is-active');
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (pushHistory) {
      history.pushState({ meridianScreen: id }, '', `#${id}`);
    }
  }

  $$('.settings-row[data-target], .settings-back[data-target]', stack).forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.getAttribute('data-target')));
  });

  window.addEventListener('popstate', (event) => {
    showScreen(event.state?.meridianScreen || 'screen-root', { pushHistory: false });
  });

  const initial = window.location.hash.replace('#', '');
  if (initial && document.getElementById(initial)) {
    $$('.settings-screen', stack).forEach((s) => s.classList.remove('is-active'));
    document.getElementById(initial).classList.add('is-active');
    history.replaceState({ meridianScreen: initial }, '', `#${initial}`);
  } else {
    history.replaceState({ meridianScreen: 'screen-root' }, '', '#screen-root');
  }

  return { showScreen };
}

/* -----------------------------------------------------------
   2. Password show/hide toggles (every .password-toggle on the page)
   ----------------------------------------------------------- */
function wirePasswordToggles() {
  $$('.password-toggle').forEach((btn) => {
    const wrap = btn.closest('.password-field-wrap');
    const input = wrap?.querySelector('input');
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? t('profile.password.hide', 'Hide password') : t('profile.password.show', 'Show password'));
    });
  });
}

/* -----------------------------------------------------------
   3. Profile banner + Personal info
   ----------------------------------------------------------- */
function populateBanner(user, profile) {
  const h1 = document.querySelector('.profile-banner-identity h1');
  const meta = user.user_metadata || {};
  const firstName = profile?.first_name || meta.first_name || '';
  const lastName = profile?.last_name || meta.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || user.email || t('profile.banner.default_name', 'Meridian customer');
  if (h1) h1.textContent = fullName;

  const avatarEl = document.querySelector('.profile-avatar-wrap .avatar-initial');
  const avatarUrl = profile?.avatar_url || profile?.profile_photo || null;
  renderAvatarLocal(avatarEl, avatarUrl, getInitials(fullName));

  const statusWrap = document.querySelector('.profile-banner-status');
  if (statusWrap) {
    const status = profile?.account_status || 'Pending';
    const lower = String(status).toLowerCase();
    const cls =
      lower === 'active' || lower === 'verified'
        ? 'status-pill--verified'
        : lower === 'pending'
        ? 'status-pill--pending'
        : lower === 'suspended' || lower === 'closed'
        ? 'status-pill--blocked'
        : 'status-pill--neutral';
    // Account status itself comes from the database (a data value,
    // not UI copy) — translate it through a status.* key set so a
    // Supabase-side value like "Pending" still renders in the
    // user's language, with the raw string as a safe fallback.
    const statusLabel = t(`profile.status.${lower}`, status);
    statusWrap.innerHTML = `<span class="status-pill ${cls}">${escapeHtml(statusLabel)}</span>`;
  }
}

function populatePersonalInfo(user, profile) {
  const form = document.getElementById('personal-info-form');
  if (!form) return;

  const values = {
    first_name: profile?.first_name || user.user_metadata?.first_name || '',
    last_name: profile?.last_name || user.user_metadata?.last_name || '',
    email: profile?.email || user.email || '',
    phone: profile?.phone || '',
    date_of_birth: profile?.date_of_birth || '',
    gender: profile?.gender || '',
    nationality: profile?.nationality || '',
    occupation: profile?.occupation || '',
    address: profile?.address || '',
    city: profile?.city || '',
    state: profile?.state || '',
    postal_code: profile?.postal_code || '',
    country: profile?.country || '',
  };

  Object.entries(values).forEach(([name, value]) => {
    const field = form.elements.namedItem(name);
    if (field) field.value = value;
  });
}

function populateAccountInfo(profile) {
  const nameEl = document.getElementById('account-info-name');
  if (nameEl) {
    const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
    nameEl.textContent = fullName || '—';
  }
}

function wireAccountNumberToggle(accounts) {
  const valueEl = document.getElementById('account-number-value');
  const toggleBtn = document.getElementById('account-number-toggle');
  if (!valueEl || !toggleBtn) return;

  const primary = accounts?.[0];
  const full = primary?.account_number || primary?.iban || null;

  if (!full) {
    valueEl.textContent = t('profile.account_info.no_account', 'No account on file');
    toggleBtn.disabled = true;
    return;
  }

  const masked = `•••• •••• ${String(full).slice(-2)}`;
  valueEl.textContent = masked;

  const showLabel = t('profile.account_info.show', 'Show');
  const hideLabel = t('profile.account_info.hide', 'Hide');

  toggleBtn.addEventListener('click', () => {
    const showing = toggleBtn.getAttribute('aria-pressed') === 'true';
    toggleBtn.setAttribute('aria-pressed', String(!showing));
    toggleBtn.textContent = showing ? showLabel : hideLabel;
    valueEl.textContent = showing ? masked : full;
  });
}

/* -----------------------------------------------------------
   4. Overview summary + activity
   ----------------------------------------------------------- */
function populateActivityPlaceholder() {
  const list = document.getElementById('activity-list');
  if (!list) return;
  list.innerHTML = `
    <li>
      <span class="activity-dot"></span>
      <div><strong>${t('profile.activity.unavailable_title', "Activity history isn't available yet")}</strong><span>${t('profile.activity.unavailable_desc', 'This screen needs a backend endpoint before it can show real activity.')}</span></div>
    </li>`;
}

async function loadOverviewSummary(userId, accounts) {
  const cards = $$('.profile-summary-card .profile-summary-value');
  const [accountStatusEl, linkedEl, cardsEl, sessionsEl] = cards;

  if (accountStatusEl) {
    const status = currentProfile?.account_status || '—';
    accountStatusEl.textContent = status === '—' ? status : t(`profile.status.${String(status).toLowerCase()}`, status);
  }

  const { data: idDocs } = await getMyIdentityDocuments(userId);
  if (linkedEl) linkedEl.textContent = `${idDocs?.length || 0} / 3`;

  let cardCount = 0;
  for (const account of accounts) {
    const { data: accountCards } = await getCardsForAccount(account.id);
    cardCount += (accountCards || []).filter((c) => String(c.card_status || '').toLowerCase() !== 'cancelled').length;
  }
  if (cardsEl) cardsEl.textContent = String(cardCount);

  const { data: sessions } = await fetchLoginSessions(userId);
  if (sessionsEl) sessionsEl.textContent = String((sessions || []).filter((s) => !s.logout_time).length);
}

/* -----------------------------------------------------------
   5. Sessions (see KNOWN GAPS note at the top of this file)
   ----------------------------------------------------------- */
async function fetchLoginSessions(userId) {
  try {
    const { data, error } = await supabase
      .from('login_sessions')
      .select('id, browser, device, login_time, logout_time')
      .eq('user_id', userId)
      .order('login_time', { ascending: false })
      .limit(20);
    if (error) return { data: [], error: error.message };
    return { data: data || [], error: null };
  } catch (err) {
    return { data: [], error: err.message };
  }
}

async function loadSessions(userId) {
  const list = document.getElementById('session-list');
  if (!list) return;

  const { data: sessions, error } = await fetchLoginSessions(userId);

  if (error || !sessions.length) {
    list.innerHTML = `<li class="session-item"><div><strong>${
      error ? t('profile.sessions.load_error', "Couldn't load sessions") : t('profile.sessions.empty', 'No sessions on record')
    }</strong></div></li>`;
    return;
  }

  const unknownBrowser = t('profile.sessions.unknown_browser', 'Unknown browser');
  const unknownDevice = t('profile.sessions.unknown_device', 'Unknown device');
  const activeNow = t('profile.sessions.active_now', 'Active now');
  const signedOut = t('profile.sessions.signed_out', 'Signed out');
  const unknownTime = t('profile.sessions.unknown_time', 'Unknown time');

  list.innerHTML = sessions
    .map((s) => {
      const active = !s.logout_time;
      // CHANGED — now formats in the user's active Meridian
      // language, not always the browser's default locale.
      const when = s.login_time ? new Date(s.login_time).toLocaleString(currentLocale()) : unknownTime;
      return `
      <li class="session-item">
        <span class="session-icon">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="10" rx="1.6" stroke="currentColor" stroke-width="1.4"/><path d="M7 17h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </span>
        <div>
          <strong>${escapeHtml(s.browser || unknownBrowser)} · ${escapeHtml(s.device || unknownDevice)}</strong>
          <span>${active ? activeNow : signedOut} · ${escapeHtml(when)}</span>
        </div>
      </li>`;
    })
    .join('');
}

/* -----------------------------------------------------------
   6a. Password change (shared by Security > Password and
       Account & security > Login settings > Change password)
   ----------------------------------------------------------- */
function passwordMeetsRequirements(pw) {
  return pw.length >= 10 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

function wirePasswordForms() {
  const configs = [
    { formId: 'password-change-form', currentId: 'current-password', newId: 'new-password', confirmId: 'new-password-confirm' },
    { formId: 'login-password-change-form', currentId: 'login-current-password', newId: 'login-new-password', confirmId: 'login-new-password-confirm' },
  ];

  configs.forEach(({ formId, currentId, newId, confirmId }) => {
    const form = document.getElementById(formId);
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const currentInput = document.getElementById(currentId);
      const newInput = document.getElementById(newId);
      const confirmInput = document.getElementById(confirmId);
      const submitBtn = form.querySelector('button[type="submit"]');

      const currentPassword = currentInput?.value || '';
      const newPassword = newInput?.value || '';
      const confirmPassword = confirmInput?.value || '';

      if (!currentPassword) {
        toast(t('profile.password.enter_current', 'Enter your current password.'), 'error');
        currentInput?.focus();
        return;
      }
      if (!passwordMeetsRequirements(newPassword)) {
        toast(t('profile.password.requirements', 'New password needs 10+ characters, upper and lower case, a number, and a symbol.'), 'error');
        newInput?.focus();
        return;
      }
      if (newPassword !== confirmPassword) {
        toast(t('profile.password.mismatch', 'New password and confirmation do not match.'), 'error');
        confirmInput?.focus();
        return;
      }

      submitBtn?.classList.add('is-loading');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const { data: verified, error: verifyError } = await verifyCurrentPassword(currentPassword);
        if (verifyError || !verified) {
          toast(verifyError || t('profile.password.incorrect', 'Current password is incorrect.'), 'error');
          return;
        }
        const { error: updateError } = await updateUserPassword(newPassword);
        if (updateError) {
          toast(updateError, 'error');
          return;
        }
        toast(t('profile.password.updated', 'Password updated.'));
        form.reset();
      } catch (err) {
        toast(t('profile.password.update_error', 'Something went wrong updating your password.'), 'error');
      } finally {
        submitBtn?.classList.remove('is-loading');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  });
}

/* -----------------------------------------------------------
   6b. Forgot password (Login settings)
   ----------------------------------------------------------- */
function wireForgotPassword() {
  const btn = document.getElementById('login-forgot-password-btn');
  const status = document.getElementById('login-forgot-password-status');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (!currentUser?.email) {
      if (status) status.textContent = t('profile.forgot_password.no_email', 'Could not determine your email address.');
      return;
    }
    btn.classList.add('is-loading');
    btn.disabled = true;
    const { error } = await requestPasswordReset(currentUser.email);
    btn.classList.remove('is-loading');
    btn.disabled = false;

    if (status) {
      status.textContent = error || t('profile.forgot_password.sent', 'Reset link sent to {email}.').replace('{email}', currentUser.email);
    }
    toast(error ? t('profile.forgot_password.error_toast', 'Could not send reset email.') : t('profile.forgot_password.sent_toast', 'Reset email sent.'), error ? 'error' : 'success');
  });
}

/* -----------------------------------------------------------
   6c. Two-factor method picker (display + dead-end, matching
       login.js's existing pattern — no backend to switch method)
   ----------------------------------------------------------- */
function wireTwoFactorPicker() {
  $$('.auth-method-btn[data-method]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-selected')) return;
      const methodKey = btn.getAttribute('data-method') === 'authenticator' ? 'authenticator' : 'email_code';
      const methodLabel = methodKey === 'authenticator'
        ? t('profile.two_factor.method.authenticator', 'an authenticator app')
        : t('profile.two_factor.method.email_code', 'an email code');
      toast(t('profile.two_factor.switch_unavailable', 'Switching to {method} isn\'t available yet.').replace('{method}', methodLabel), 'error');
    });
  });
}

/* -----------------------------------------------------------
   6d. Notification preferences (UI-only — see KNOWN GAPS)
   ----------------------------------------------------------- */
function wireNotificationToggles() {
  $$('.preference-row .switch input:not(:disabled)').forEach((input) => {
    input.addEventListener('change', () => {
      toast(t('profile.notifications.not_persisted', "Saved for this session — notification preferences aren't stored on your account yet."));
    });
  });
}

/* -----------------------------------------------------------
   6e. Login session preference (UI-only — see KNOWN GAPS)
   ----------------------------------------------------------- */
function wireLoginSessionPreference() {
  const form = document.getElementById('login-session-preference-form');
  const preview = document.getElementById('login-session-preview');
  const status = document.getElementById('login-session-preference-status');
  if (!form) return;

  const labels = {
    until_logout: t('profile.session_pref.until_logout', 'Until I log out'),
    sixty_minutes: t('profile.session_pref.sixty_minutes', '60 minutes'),
    always: t('profile.session_pref.always', 'Always require'),
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = form.querySelector('input[name="login_session_preference"]:checked');
    const value = selected?.value || 'always';
    if (preview) preview.textContent = labels[value] || labels.always;
    if (status) status.textContent = t('profile.session_pref.not_synced', "Saved for this device — this preference isn't synced to your account yet.");
    toast(t('profile.session_pref.updated_toast', 'Session preference updated for this device.'));
  });
}

/* -----------------------------------------------------------
   6f. Face ID — status display only, deferred per instruction
   ----------------------------------------------------------- */
async function loadFaceIdStatus(userId) {
  const { data: creds } = await getMyWebauthnCredentials(userId);
  const enabled = !!(creds && creds.length);

  const enabledLabel = t('profile.faceid.enabled', 'Enabled');
  const disabledLabel = t('profile.faceid.disabled', 'Disabled');

  const previewPill = document.getElementById('login-faceid-preview');
  if (previewPill) {
    previewPill.textContent = enabled ? enabledLabel : disabledLabel;
    previewPill.classList.toggle('status-pill--verified', enabled);
    previewPill.classList.toggle('status-pill--neutral', !enabled);
  }

  const statusPill = document.getElementById('faceid-status-pill');
  if (statusPill) {
    statusPill.textContent = t('profile.faceid.status_label', 'Face ID: {status}').replace('{status}', enabled ? enabledLabel : disabledLabel);
    statusPill.classList.toggle('status-pill--verified', enabled);
    statusPill.classList.toggle('status-pill--neutral', !enabled);
  }

  const toggleBtn = document.getElementById('faceid-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = t('profile.faceid.coming_soon', 'Coming soon');
    toggleBtn.disabled = true;
    toggleBtn.title = t('profile.faceid.coming_soon_title', "Face ID sign-in is being built — enrollment and login verification aren't wired up yet.");
  }

  const unavailableNote = document.getElementById('faceid-unavailable');
  if (unavailableNote && !window.PublicKeyCredential) {
    unavailableNote.hidden = false;
  }
}

/* -----------------------------------------------------------
   7a. Linked ID — password-gated reveal
   ----------------------------------------------------------- */
function wireLinkedId() {
  const viewBtn = document.getElementById('view-linked-id-btn');
  const modal = document.getElementById('linked-id-auth-modal');
  const closeBtn = document.getElementById('linked-id-modal-close');
  const cancelBtn = document.getElementById('linked-id-modal-cancel');
  const form = document.getElementById('linked-id-verify-form');
  const passwordInput = document.getElementById('linked-id-password');
  const errorEl = document.getElementById('linked-id-modal-error');
  const details = document.getElementById('linked-id-details');
  if (!viewBtn || !modal || !form) return;

  function openModal() {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
    passwordInput?.focus();
  }

  function closeModal() {
    modal.classList.remove('is-open');
    if (errorEl) errorEl.textContent = '';
    form.reset();
    window.setTimeout(() => {
      modal.hidden = true;
    }, 200);
  }

  viewBtn.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = document.getElementById('linked-id-modal-submit');
    const password = passwordInput?.value || '';

    if (!password) {
      if (errorEl) errorEl.textContent = t('profile.linked_id.enter_password', 'Enter your password to continue.');
      return;
    }

    submitBtn?.classList.add('is-loading');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const { data: verified, error } = await verifyCurrentPassword(password);
      if (error || !verified) {
        if (errorEl) errorEl.textContent = error || t('profile.linked_id.incorrect_password', 'Incorrect password.');
        return;
      }
      await renderLinkedIdCards();
      if (details) details.hidden = false;
      closeModal();
    } finally {
      submitBtn?.classList.remove('is-loading');
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $$('[data-add-document-for]').forEach((btn) => {
    btn.addEventListener('click', () => {
      screenStack?.showScreen('screen-limits-upload');
    });
  });
}

async function renderLinkedIdCards() {
  if (!currentUser) return;
  const { data: docs, error } = await getMyIdentityDocuments(currentUser.id);
  if (error) {
    toast(t('profile.linked_id.load_error', 'Could not load your linked ID details.'), 'error');
    return;
  }

  const bySlot = new Map((docs || []).map((d) => [String(d.slot), d]));
  const emptyLabel = t('profile.linked_id.status.empty', 'Empty');
  const verifiedLabel = t('profile.linked_id.status.verified', 'Verified');
  const dashPlaceholder = '—';

  [1, 2, 3].forEach((slot) => {
    const card = document.getElementById(`linked-id-card-${slot}`);
    if (!card) return;
    const doc = bySlot.get(String(slot));
    const statusPill = card.querySelector('[data-linked-id-status]');
    const emptyState = card.querySelector('.linked-id-empty');
    const fieldsList = card.querySelector('.linked-id-fields');

    if (!doc) {
      if (statusPill) {
        statusPill.textContent = emptyLabel;
        statusPill.className = 'status-pill status-pill--neutral';
        statusPill.setAttribute('data-linked-id-status', '');
      }
      if (emptyState) emptyState.hidden = false;
      if (fieldsList) fieldsList.hidden = true;
      return;
    }

    if (statusPill) {
      statusPill.textContent = verifiedLabel;
      statusPill.className = 'status-pill status-pill--verified';
      statusPill.setAttribute('data-linked-id-status', '');
    }
    if (emptyState) emptyState.hidden = true;
    if (fieldsList) {
      fieldsList.hidden = false;
      const setField = (name, value) => {
        const dd = fieldsList.querySelector(`[data-field="${name}"]`);
        if (dd) dd.textContent = value || dashPlaceholder;
      };
      setField('id_type', doc.id_type || doc.document_type);
      setField('full_name', doc.full_name);
      setField('id_number', doc.id_number);
      setField('date_of_birth', doc.date_of_birth);
      setField('gender', doc.gender);
    }
  });
}

/* -----------------------------------------------------------
   7b. Document upload
   ----------------------------------------------------------- */
const IDENTITY_CATEGORY_BY_TYPE = {
  bvn: 'bvn',
  nin: 'identity',
  drivers_license: 'identity',
  passport: 'identity',
  voters_card: 'identity',
  electricity_bill: 'proof_of_address',
  bank_statement: 'proof_of_address',
  waste_bill: 'proof_of_address',
  water_bill: 'proof_of_address',
  house_rent_receipt: 'proof_of_address',
  tenancy_agreement: 'proof_of_address',
  land_use_charge: 'proof_of_address',
};

function wireDocumentUpload() {
  const form = document.getElementById('document-upload-form');
  const typeSelect = document.getElementById('document-type-select');
  const fileField = document.getElementById('document-upload-file-field');
  const dropzone = document.getElementById('document-upload-dropzone');
  const fileInput = document.getElementById('document-upload-input');
  const preview = document.getElementById('document-upload-preview');
  const previewName = document.getElementById('document-upload-preview-name');
  const removeBtn = document.getElementById('document-upload-remove');
  const progress = document.getElementById('document-upload-progress');
  const progressBar = document.getElementById('document-upload-progress-bar');
  const errorEl = document.getElementById('document-upload-error');
  const statusPill = document.getElementById('document-upload-status');
  const submitBtn = document.getElementById('document-upload-submit-btn');
  const detailFields = document.getElementById('document-detail-fields');
  const fullNameInput = document.getElementById('document-full-name');
  const idNumberInput = document.getElementById('document-id-number');
  const dobInput = document.getElementById('document-dob');
  const genderInput = document.getElementById('document-gender');
  if (!form || !dropzone || !fileInput) return;

  let selectedFile = null;

  const currentCategory = () => IDENTITY_CATEGORY_BY_TYPE[typeSelect?.value] || null;
  const requiresFileFor = (category) => category !== 'bvn';
  const requiresDetailsFor = (category) => category === 'bvn' || category === 'identity';

  function setSelectedFile(file) {
    selectedFile = file || null;
    if (selectedFile) {
      if (previewName) previewName.textContent = selectedFile.name;
      if (preview) preview.hidden = false;
    } else {
      if (preview) preview.hidden = true;
      fileInput.value = '';
    }
    updateSubmitState();
  }

  function updateFieldVisibility() {
    const category = currentCategory();
    if (fileField) fileField.hidden = category === 'bvn';
    if (detailFields) detailFields.hidden = !requiresDetailsFor(category);
    if (category === 'bvn') setSelectedFile(null);
  }

  function updateSubmitState() {
    const category = currentCategory();
    const hasType = !!typeSelect?.value;
    const hasFile = !requiresFileFor(category) || !!selectedFile;
    const hasDetails =
      !requiresDetailsFor(category) ||
      (fullNameInput?.value.trim() && idNumberInput?.value.trim() && dobInput?.value && genderInput?.value);
    if (submitBtn) submitBtn.disabled = !(hasType && hasFile && hasDetails);
  }

  dropzone.setAttribute('tabindex', '0');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) setSelectedFile(file);
  });

  fileInput.addEventListener('change', () => setSelectedFile(fileInput.files?.[0] || null));
  removeBtn?.addEventListener('click', () => setSelectedFile(null));
  typeSelect?.addEventListener('change', () => {
    updateFieldVisibility();
    updateSubmitState();
  });
  [fullNameInput, idNumberInput, dobInput, genderInput].forEach((el) => {
    el?.addEventListener('input', updateSubmitState);
    el?.addEventListener('change', updateSubmitState);
  });

  updateFieldVisibility();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.textContent = '';

    const documentType = typeSelect?.value;
    const documentCategory = IDENTITY_CATEGORY_BY_TYPE[documentType];

    if (!documentType || !documentCategory) {
      if (errorEl) errorEl.textContent = t('profile.upload.choose_type', 'Choose a document type.');
      return;
    }
    if (requiresFileFor(documentCategory) && !selectedFile) {
      if (errorEl) errorEl.textContent = t('profile.upload.choose_file', 'Choose a file to upload.');
      return;
    }

    let fullName, idNumber, dateOfBirth, gender;
    if (requiresDetailsFor(documentCategory)) {
      fullName = fullNameInput?.value.trim();
      idNumber = idNumberInput?.value.trim();
      dateOfBirth = dobInput?.value;
      gender = genderInput?.value;
      if (!fullName || !idNumber || !dateOfBirth || !gender) {
        if (errorEl) errorEl.textContent = t('profile.upload.fill_details', 'Fill in full name, ID number, date of birth, and gender.');
        return;
      }
    }

    if (submitBtn) submitBtn.disabled = true;
    submitBtn?.classList.add('is-loading');
    const showsProgress = requiresFileFor(documentCategory);
    if (showsProgress) {
      if (progress) progress.hidden = false;
      if (progressBar) progressBar.style.width = '15%';
    }

    try {
      if (showsProgress && progressBar) progressBar.style.width = '60%';
      const { error } = await submitIdentityDocument({
        file: selectedFile,
        documentType,
        documentCategory,
        fullName,
        idNumber,
        dateOfBirth,
        gender,
      });
      if (showsProgress && progressBar) progressBar.style.width = '100%';

      if (error) {
        if (errorEl) errorEl.textContent = error;
        toast(error, 'error');
        return;
      }

      if (statusPill) statusPill.hidden = false;
      toast(t('profile.upload.submitted', 'Document submitted for verification.'));
      form.reset();
      setSelectedFile(null);
      updateFieldVisibility();
    } catch (err) {
      if (errorEl) errorEl.textContent = t('profile.upload.failed', 'Upload failed. Please try again.');
    } finally {
      submitBtn?.classList.remove('is-loading');
      updateSubmitState();
      window.setTimeout(() => {
        if (progress) progress.hidden = true;
        if (progressBar) progressBar.style.width = '0%';
      }, 600);
    }
  });
}

/* -----------------------------------------------------------
   8. Danger zone — no backend yet, honest placeholders
   ----------------------------------------------------------- */
function wireDangerZone() {
  const dangerScreen = document.getElementById('screen-danger');
  if (!dangerScreen) return;

  const exportBtn = dangerScreen.querySelector('.btn-ghost');
  const closeBtn = dangerScreen.querySelector('.btn-danger');

  exportBtn?.addEventListener('click', () => {
    toast(t('profile.danger.export_unavailable', "Data export requests aren't wired up yet — contact support in the meantime."), 'error');
  });

  closeBtn?.addEventListener('click', () => {
    toast(t('profile.danger.close_unavailable', "Account closure isn't available from this screen yet — contact support."), 'error');
  });
}

/* -----------------------------------------------------------
   9. Avatar upload
   ----------------------------------------------------------- */
function wireAvatarUpload() {
  const editBtn = document.querySelector('.profile-avatar-edit');
  if (!editBtn) return;

  // profile.html has no <input type="file"> tied to this button —
  // created here rather than editing that markup (see KNOWN GAPS).
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  document.body.appendChild(input);

  editBtn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || !currentUser) return;

    editBtn.classList.add('is-loading');
    try {
      const { data, error } = await uploadAvatar(file, currentUser.id);
      if (error) {
        toast(error, 'error');
        return;
      }

      const fullName = currentFullName();
      const initials = getInitials(fullName);
      renderAvatarLocal(document.querySelector('.profile-avatar-wrap .avatar-initial'), data.url, initials);
      $$('.app-user-menu .avatar-initial').forEach((el) => renderAvatarLocal(el, data.url, initials));

      toast(t('profile.avatar.updated', 'Profile photo updated.'));
    } finally {
      editBtn.classList.remove('is-loading');
      input.value = '';
    }
  });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
async function init() {
  screenStack = initScreenStack();
  wirePasswordToggles();

  const { data: user, error: userError } = await getCurrentUser();
  if (userError || !user) return; // auth-ui.js's requireAuth() already handles the redirect

  currentUser = user;

  const { data: profile, error: profileError } = await getMyProfile(user.id);
  if (profileError) console.warn('[Meridian] Could not load profile:', profileError);
  currentProfile = profile;

  // NEW — same as settings.js: source of truth for a logged-in
  // user's language is their saved profile, not whatever
  // localStorage/geo guessed before login resolved. persist:false
  // because this re-applies an existing choice, it isn't a new one.
  if (profile?.language && window.MeridianI18n) {
    window.MeridianI18n.setLanguage(profile.language, { persist: false });
  }

  const { data: accounts } = await getMyAccounts(user.id);

  populateBanner(user, profile);
  populatePersonalInfo(user, profile);
  populateAccountInfo(profile);
  populateActivityPlaceholder();
  wireAccountNumberToggle(accounts || []);

  await loadOverviewSummary(user.id, accounts || []);
  await loadSessions(user.id);
  await loadFaceIdStatus(user.id);

  wirePasswordForms();
  wireForgotPassword();
  wireTwoFactorPicker();
  wireNotificationToggles();
  wireLoginSessionPreference();
  wireLinkedId();
  wireDocumentUpload();
  wireAvatarUpload();
  wireDangerZone();
}

document.addEventListener('DOMContentLoaded', init);

/* =============================================================
   NEW TRANSLATION KEYS THIS FILE NEEDS
   -----------------------------------------------------------
   All net-new — not yet in translation.js's TRANSLATIONS
   dictionary. English fallbacks are inline above so functionality
   doesn't wait on the merge; say the word and these can go across
   the other 9 languages next, same pattern as settings.js's key
   batches.

   profile.password.hide
   profile.password.show
   profile.banner.default_name
   profile.status.<status>              (dynamic — pending/active/verified/suspended/closed etc., built from account_status)
   profile.account_info.no_account
   profile.account_info.show
   profile.account_info.hide
   profile.activity.unavailable_title
   profile.activity.unavailable_desc
   profile.sessions.load_error
   profile.sessions.empty
   profile.sessions.unknown_browser
   profile.sessions.unknown_device
   profile.sessions.active_now
   profile.sessions.signed_out
   profile.sessions.unknown_time
   profile.password.enter_current
   profile.password.requirements
   profile.password.mismatch
   profile.password.incorrect
   profile.password.updated
   profile.password.update_error
   profile.forgot_password.no_email
   profile.forgot_password.sent          (uses {email} placeholder)
   profile.forgot_password.error_toast
   profile.forgot_password.sent_toast
   profile.two_factor.method.authenticator
   profile.two_factor.method.email_code
   profile.two_factor.switch_unavailable (uses {method} placeholder)
   profile.notifications.not_persisted
   profile.session_pref.until_logout
   profile.session_pref.sixty_minutes
   profile.session_pref.always
   profile.session_pref.not_synced
   profile.session_pref.updated_toast
   profile.faceid.enabled
   profile.faceid.disabled
   profile.faceid.status_label           (uses {status} placeholder)
   profile.faceid.coming_soon
   profile.faceid.coming_soon_title
   profile.linked_id.enter_password
   profile.linked_id.incorrect_password
   profile.linked_id.load_error
   profile.linked_id.status.empty
   profile.linked_id.status.verified
   profile.upload.choose_type
   profile.upload.choose_file
   profile.upload.fill_details
   profile.upload.submitted
   profile.upload.failed
   profile.danger.export_unavailable
   profile.danger.close_unavailable
   profile.avatar.updated
   ============================================================= */
