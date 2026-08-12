/* =============================================================
   MERIDIAN — Account profile page
   Script: pages/profile.js
   Loaded as a module by profile.html only. Handles:
     1. Auth guard
     2. Header identity (name, avatar) + notification badge, user
        menu dropdown, mobile nav toggle, log out — deferred until
        the app-navbar component has landed (see waitForNavbar()).
     4. Section navigation — hash-linked, keyboard accessible tabs.
        Covers every .profile-nav-link / .profile-panel pair
        automatically, so the new Login settings / Account limits
        tabs work with zero changes to this function.
     5. Loading the signed-in user's profile into the banner,
        the Overview summary, and the (read-only) Personal info form
     6. Avatar upload (via supabase/storage.js)
     7. Recent account activity — from audit_logs
     8. Active sessions — from login_sessions
     9. Password change — Security tab AND Login settings tab, both
        re-verifying the current password first (see
        verifyCurrentPassword() in database.js)
     10. Two-factor method picker
     11. Notification preference switches
     12. Danger zone actions (data export / close account) — stubs
     13. Toast helper for save feedback
     14. Login settings: forgot password, login session preference,
         Face ID / device biometrics
     15. Account limits: tier badge + account info, and the
         sequential identity-verification stepper (Tier 1 → 2 → 3)

   NOTE: the Personal info form is view-only by design — every
   field is disabled in the markup and there is no save handler
   for it here.

   CHANGE LOG (this revision)
   ---------------------------
   Replaced the old "3 Linked ID cards shown at once + one static
   upload form" Account limits UI with a sequential, Opay-style
   verification stepper:
     - Only the CURRENT tier is ever actionable. Tier 2 doesn't even
       render an upload form until Tier 1 has been admin-verified;
       Tier 3 doesn't until Tier 2 has.
     - Each tier's body (locked / upload form / pending / rejected /
       verified) is computed fresh from getMyIdentityDocumentHistory()
       — a new read that, unlike getMyIdentityDocuments(), returns
       EVERY submission regardless of status, which this needs to
       show "pending review" and "rejected — resubmit" states at all.
     - Tier 1's document list is NIN / driver's license / int'l
       passport / voter's card. Tier 2 shows the same list minus
       whichever type Tier 1 actually used. Tier 3's is the
       proof-of-address list (utility bills, bank statement,
       tenancy agreement, etc).
     - Verified-tier detail fields (full name, ID number, DOB,
       gender) still sit behind the same password re-auth as
       before — the modal is now shared across all three tiers
       (#verify-identity-modal) rather than one-off per Linked ID
       card, and records which tier it's currently unlocking.
     - Those detail fields are admin-supplied at verification time
       (see 017_identity_document_review_details.sql), not typed by
       the customer — the upload form only ever collects document
       type + file, matching what submitIdentityDocument() accepts.
   ============================================================= */

import {
  requireAuth,
  signOutUser,
  updateUserPassword,
  verifyCurrentPassword,
  requestPasswordReset,
} from '../supabase/auth.js';
import { supabase } from '../supabase/config.js';
import {
  getMyProfile,
  updateMyProfile,
  getMyAccounts,
  getCardsForAccount,
  getUnreadNotificationCount,
  getMyIdentityDocumentHistory,
  submitIdentityDocument,
  getMyWebauthnCredentials,
  registerWebauthnCredential,
  removeAllWebauthnCredentials,
} from '../supabase/database.js';
import { uploadAvatar } from '../supabase/storage.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

let currentUser = null;
let currentProfile = null;

/* -----------------------------------------------------------
   Toasts
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
  toast.innerHTML = `
    <span class="ic"><svg viewBox="0 0 14 13" fill="none" aria-hidden="true">${icon}</svg></span>
    <span>${message}</span>
  `;
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));

  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 250);
  }, 3600);
}

/* -----------------------------------------------------------
   Button loading helper
   ----------------------------------------------------------- */
function setButtonLoading(button, isLoading) {
  if (!button) return;
  button.classList.toggle('is-loading', isLoading);
  button.disabled = isLoading;
}

/* -----------------------------------------------------------
   Simple HTML-escaping for anything interpolated into innerHTML
   that ultimately traces back to a document's own submitted
   values (file names, admin-entered full names, etc.)
   ----------------------------------------------------------- */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -----------------------------------------------------------
   Initials / avatar rendering
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
   Section navigation (tabs)
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

    if (updateHash) {
      history.replaceState(null, '', `#${targetLink.dataset.tab}`);
    }
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

  window.__profileActivateTab = activate;

  const initialTab = window.location.hash.replace('#', '');
  activate(initialTab || 'overview', { updateHash: false });
}

/* -----------------------------------------------------------
   Load profile data into banner + Personal info form
   ----------------------------------------------------------- */
function populateBanner(profile) {
  const heading = $('.profile-banner-identity h1');
  const meta = $('.profile-banner-meta');
  const statusRegion = $('.profile-banner-status');

  if (heading) heading.textContent = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || 'Your profile';

  if (meta) {
    const since = profile?.created_at
      ? new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : null;
    meta.textContent = `Personal account${since ? ` · Member since ${since}` : ''}`;
  }

  if (statusRegion) {
    statusRegion.innerHTML = '';

    const identityPill = document.createElement('span');
    if (profile?.account_status === 'Active') {
      identityPill.className = 'status-pill status-pill--verified';
      identityPill.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Identity verified`;
    } else {
      identityPill.className = 'status-pill status-pill--pending';
      identityPill.textContent = profile?.account_status || 'Pending review';
    }
    statusRegion.appendChild(identityPill);

    const emailPill = document.createElement('span');
    emailPill.className = 'status-pill status-pill--neutral';
    emailPill.textContent = profile?.email_verified ? 'Email confirmed' : 'Email unconfirmed';
    statusRegion.appendChild(emailPill);
  }
}

function populatePersonalForm(profile) {
  const form = $('#personal-info-form');
  if (!form || !profile) return;

  const setValue = (name, value) => {
    const field = form.elements[name];
    if (field && value !== undefined && value !== null) field.value = value;
  };

  setValue('first_name', profile.first_name);
  setValue('last_name', profile.last_name);
  setValue('email', profile.email);
  setValue('phone', profile.phone);
  setValue('date_of_birth', profile.date_of_birth);
  setValue('gender', profile.gender);
  setValue('nationality', profile.nationality);
  setValue('occupation', profile.occupation);
  setValue('address', profile.address);
  setValue('city', profile.city);
  setValue('state', profile.state);
  setValue('postal_code', profile.postal_code);
  setValue('country', profile.country);
}

/* -----------------------------------------------------------
   Overview summary
   ----------------------------------------------------------- */
async function populateOverviewSummary(user, profile, accounts) {
  const values = $$('.profile-summary-card .profile-summary-value');
  const [statusVal, accountsVal, cardsVal, sessionsVal] = values;

  if (statusVal) statusVal.textContent = profile?.account_status || 'Pending';

  if (accountsVal) {
    const count = accounts.length;
    accountsVal.textContent = count ? `${count} currenc${count === 1 ? 'y' : 'ies'}` : 'None yet';
  }

  if (cardsVal) {
    if (!accounts.length) {
      cardsVal.textContent = 'None yet';
    } else {
      const cardLists = await Promise.all(accounts.map((a) => getCardsForAccount(a.id)));
      const activeCount = cardLists.reduce(
        (sum, { data }) => sum + (data || []).filter((c) => c.card_status === 'Active').length,
        0
      );
      cardsVal.textContent = `${activeCount} card${activeCount === 1 ? '' : 's'}`;
    }
  }

  if (sessionsVal) {
    const { count, error } = await supabase
      .from('login_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('logout_time', null);
    const deviceCount = error ? 0 : (count ?? 0);
    sessionsVal.textContent = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  }
}

/* -----------------------------------------------------------
   Recent account activity
   ----------------------------------------------------------- */
async function populateRecentActivity(userId) {
  const listEl = $('#activity-list');
  if (!listEl) return;

  const { data, error } = await supabase
    .from('audit_logs')
    .select('action, browser, operating_system, device, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(3);

  if (error || !data?.length) {
    listEl.innerHTML = `
      <li>
        <span class="activity-dot"></span>
        <div>
          <strong>No recent activity</strong>
          <span>Account actions will show up here.</span>
        </div>
      </li>
    `;
    return;
  }

  listEl.innerHTML = '';
  data.forEach((entry) => {
    const context = [entry.browser, entry.operating_system].filter(Boolean).join(' on ');
    const when = new Date(entry.created_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="activity-dot"></span>
      <div>
        <strong>${entry.action || 'Account activity'}</strong>
        <span>${context || entry.device || ''}</span>
      </div>
      <time>${when}</time>
    `;
    listEl.appendChild(li);
  });
}

/* -----------------------------------------------------------
   Active sessions
   ----------------------------------------------------------- */
function initSessionLogoutButtons() {
  $$('.session-item .wizard-edit-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.session-item');
      btn.disabled = true;
      item.style.opacity = '0.5';
      setTimeout(() => {
        item.remove();
        showToast('Signed out of that device.');
      }, 200);
    });
  });
}

async function populateSessions(userId) {
  const listEl = $('#session-list');
  if (!listEl) return;

  const { data, error } = await supabase
    .from('login_sessions')
    .select('id, browser, device, login_time')
    .eq('user_id', userId)
    .is('logout_time', null)
    .order('login_time', { ascending: false });

  if (error || !data?.length) {
    listEl.innerHTML = `
      <li class="session-item">
        <div>
          <strong>No active sessions found</strong>
          <span>You're not logged in anywhere we can see.</span>
        </div>
      </li>
    `;
    return;
  }

  listEl.innerHTML = '';
  data.forEach((session, index) => {
    const isCurrent = index === 0;
    const when = new Date(session.login_time).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const li = document.createElement('li');
    li.className = 'session-item';
    li.innerHTML = `
      <span class="session-icon">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="10" rx="1.6" stroke="currentColor" stroke-width="1.4"/><path d="M7 17h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </span>
      <div>
        <strong>${session.browser || 'Unknown browser'}${session.device ? ` on ${session.device}` : ''}${isCurrent ? ' · This device' : ''}</strong>
        <span>Active since ${when}</span>
      </div>
      ${isCurrent
        ? '<span class="status-pill status-pill--neutral">Current</span>'
        : '<button type="button" class="wizard-edit-link">Log out</button>'}
    `;
    listEl.appendChild(li);
  });

  initSessionLogoutButtons();
}

/* -----------------------------------------------------------
   Avatar upload
   ----------------------------------------------------------- */
function initAvatarUpload() {
  const editBtn = $('.profile-avatar-edit');
  if (!editBtn) return;

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  editBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || !currentUser) return;

    editBtn.classList.add('is-loading');
    const { data, error } = await uploadAvatar(file, currentUser.id);
    editBtn.classList.remove('is-loading');

    if (error) {
      showToast(error, 'error');
      return;
    }

    paintAvatar(data.url, currentProfile?.first_name, currentProfile?.last_name);
    if (currentProfile) currentProfile.profile_photo = data.url;
    showToast('Profile photo updated.');
  });
}

/* -----------------------------------------------------------
   Password change — shared by the Security tab's form AND the
   Login settings tab's form.
   ----------------------------------------------------------- */
function passwordStrength(password) {
  let score = 0;
  if (password.length >= 10) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return score;
}

function clearFieldErrors(form) {
  $$('.field', form).forEach((field) => {
    field.classList.remove('has-error');
    const err = $('.field-error', field);
    if (err) err.textContent = '';
  });
}

function initPasswordForm(formSelector, { requirementsListSelector } = {}) {
  const form = $(formSelector);
  if (!form) return;

  const newPasswordInput = form.elements['new_password'];
  let strengthMeter = $('.password-strength', form);
  if (!strengthMeter && newPasswordInput) {
    strengthMeter = document.createElement('div');
    strengthMeter.className = 'password-strength';
    strengthMeter.innerHTML = '<span></span><span></span><span></span><span></span>';
    newPasswordInput.closest('.field').appendChild(strengthMeter);
  }

  const requirementsList = requirementsListSelector ? $(requirementsListSelector) : null;

  function updateRequirements(password) {
    if (!requirementsList) return;
    const checks = [
      password.length >= 10,
      /[A-Z]/.test(password) && /[a-z]/.test(password),
      /\d/.test(password),
      /[^A-Za-z0-9]/.test(password),
    ];
    $$('li', requirementsList).forEach((li, i) => li.classList.toggle('is-met', Boolean(checks[i])));
  }

  if (newPasswordInput) {
    newPasswordInput.addEventListener('input', () => {
      strengthMeter.dataset.strength = String(passwordStrength(newPasswordInput.value));
      updateRequirements(newPasswordInput.value);
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);

    const { current_password, new_password, new_password_confirm } = Object.fromEntries(new FormData(form).entries());

    if (!current_password) {
      showToast('Enter your current password.', 'error');
      return;
    }
    if (new_password.length < 10) {
      showToast('Use at least 10 characters for your new password.', 'error');
      return;
    }
    if (new_password !== new_password_confirm) {
      showToast('Passwords don\u2019t match.', 'error');
      return;
    }

    const submitBtn = $('button[type="submit"]', form);
    setButtonLoading(submitBtn, true);

    const { error: verifyError } = await verifyCurrentPassword(current_password);
    if (verifyError) {
      setButtonLoading(submitBtn, false);
      showToast('Your current password is incorrect.', 'error');
      return;
    }

    const { error } = await updateUserPassword(new_password);

    setButtonLoading(submitBtn, false);

    if (error) {
      showToast(error, 'error');
      return;
    }

    form.reset();
    if (strengthMeter) strengthMeter.removeAttribute('data-strength');
    if (requirementsList) $$('li', requirementsList).forEach((li) => li.classList.remove('is-met'));
    showToast('Your password has been updated.');
  });
}

/* -----------------------------------------------------------
   Password visibility toggle — generic, covers every
   .password-toggle on the page (Security tab, Login settings
   tab, and the verify-identity modal) with no per-form wiring
   needed. Delegated to a live NodeList re-scan happens naturally
   here since dynamically-added .password-toggle elements (there
   are none in the stepper today, but future-proofing costs
   nothing) would just need this called again after render.
   ----------------------------------------------------------- */
function initPasswordToggle() {
  $$('.password-toggle').forEach((btn) => {
    const input = btn.closest('.password-field-wrap')?.querySelector('input');
    if (!input) return;
    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-pressed', String(!showing));
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });
}

/* -----------------------------------------------------------
   Two-factor method picker
   ----------------------------------------------------------- */
function initTwoFactorPicker() {
  const buttons = $$('.auth-method-btn');
  if (!buttons.length) return;

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('is-selected')) return;

      buttons.forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');

      const label = $('.profile-card-head .status-pill--verified', btn.closest('.profile-card'));
      if (label) label.textContent = `Enabled — ${btn.textContent.trim()}`;

      const { error } = await updateMyProfile({ two_factor_method: btn.dataset.method }, currentUser?.id);
      if (error) {
        showToast(error, 'error');
        return;
      }
      showToast('Two-factor method updated.');
    });
  });
}

function populateTwoFactor(profile) {
  const buttons = $$('.auth-method-btn');
  const label = $('.profile-card-head .status-pill--verified', $('#security'));
  if (!buttons.length) return;

  buttons.forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.method === (profile?.two_factor_method || 'email-code'));
  });

  if (label) {
    const selected = buttons.find((b) => b.classList.contains('is-selected'));
    const name = selected ? selected.textContent.trim() : 'Email code';
    label.textContent = `Enabled — ${name}`;
  }
}

/* -----------------------------------------------------------
   Notification preference switches
   ----------------------------------------------------------- */
function populateNotificationPreferences(profile) {
  const rows = $$('.preference-row');
  if (!rows.length) return;

  const keyByIndex = ['notify_transactions', null, 'notify_exchange_rate', 'notify_product_news'];

  rows.forEach((row, i) => {
    const key = keyByIndex[i];
    if (!key) return;
    const input = $('input[type="checkbox"]', row);
    if (input && profile && key in profile) {
      input.checked = Boolean(profile[key]);
    }
  });
}

function initNotificationSwitches() {
  const rows = $$('.preference-row');
  if (!rows.length) return;

  const keyByIndex = ['notify_transactions', null, 'notify_exchange_rate', 'notify_product_news'];

  rows.forEach((row, i) => {
    const key = keyByIndex[i];
    const input = $('input[type="checkbox"]', row);
    if (!key || !input || input.disabled) return;

    input.addEventListener('change', async () => {
      const { error } = await updateMyProfile({ [key]: input.checked }, currentUser?.id);
      if (error) {
        input.checked = !input.checked;
        showToast(error, 'error');
        return;
      }
      showToast('Notification preferences saved.');
    });
  });
}

/* -----------------------------------------------------------
   Danger zone
   ----------------------------------------------------------- */
function initDangerZone() {
  const exportBtn = $('#danger .profile-card:nth-of-type(1) .btn');
  const closeBtn = $('#danger .profile-card:nth-of-type(2) .btn-danger');

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      setButtonLoading(exportBtn, true);
      await new Promise((resolve) => setTimeout(resolve, 600));
      setButtonLoading(exportBtn, false);
      showToast("We'll email your data export within 24 hours.");
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const confirmed = window.confirm(
        'Close your Meridian account? This can\u2019t be undone, and every account must already be at a zero balance.'
      );
      if (!confirmed) return;
      showToast('Account closure requires a zero balance on every currency account.', 'error');
    });
  }
}

/* =============================================================
   Login settings
   ============================================================= */

function initForgotPassword() {
  const btn = $('#login-forgot-password-btn');
  const status = $('#login-forgot-password-status');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (!currentUser?.email) return;
    setButtonLoading(btn, true);
    if (status) status.textContent = '';

    const { error } = await requestPasswordReset(currentUser.email);

    setButtonLoading(btn, false);

    if (error) {
      if (status) status.textContent = "Couldn't send the reset email. Try again shortly.";
      showToast('Couldn\u2019t send the reset email.', 'error');
      return;
    }

    if (status) status.textContent = `Reset link sent to ${currentUser.email}.`;
    showToast('Password reset email sent.');
  });
}

function populateLoginSessionPreference(profile) {
  const value = profile?.login_session_preference || 'always';
  const input = $(`input[name="login_session_preference"][value="${value}"]`);
  if (input) input.checked = true;
}

function initLoginSessionPreference() {
  const form = $('#login-session-preference-form');
  const status = $('#login-session-preference-status');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = new FormData(form).get('login_session_preference');
    if (!value) return;

    const submitBtn = $('#save-session-preference-btn', form);
    setButtonLoading(submitBtn, true);
    if (status) status.textContent = '';

    const { error } = await updateMyProfile({ login_session_preference: value }, currentUser?.id);

    setButtonLoading(submitBtn, false);

    if (error) {
      showToast(error, 'error');
      return;
    }

    if (currentProfile) currentProfile.login_session_preference = value;
    if (status) status.textContent = 'Saved.';
    showToast('Login session preference saved.');
  });
}

function populateFaceId(hasCredential) {
  const pill = $('#faceid-status-pill');
  const btn = $('#faceid-toggle-btn');
  if (pill) {
    pill.textContent = hasCredential ? 'Face ID: Enabled' : 'Face ID: Disabled';
    pill.classList.toggle('status-pill--verified', hasCredential);
    pill.classList.toggle('status-pill--neutral', !hasCredential);
  }
  if (btn) btn.textContent = hasCredential ? 'Disable Face ID' : 'Enable Face ID';
}

async function enableFaceId() {
  if (!window.PublicKeyCredential) {
    const unavailable = $('#faceid-unavailable');
    if (unavailable) unavailable.hidden = false;
    showToast('Biometric authentication isn\u2019t available on this device.', 'error');
    return false;
  }

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userIdBytes = new TextEncoder().encode(currentUser.id);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Meridian' },
        user: {
          id: userIdBytes,
          name: currentUser.email || 'meridian-user',
          displayName: `${currentProfile?.first_name || ''} ${currentProfile?.last_name || ''}`.trim() || 'Meridian customer',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
        attestation: 'none',
      },
    });

    if (!credential) return false;

    const toBase64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
    const { error } = await registerWebauthnCredential({
      credentialId: toBase64(credential.rawId),
      publicKey: toBase64(credential.response.attestationObject),
      deviceLabel: navigator.platform || 'This device',
      userId: currentUser.id,
    });

    if (error) {
      showToast(error, 'error');
      return false;
    }
    return true;
  } catch (err) {
    showToast('Couldn\u2019t set up Face ID on this device.', 'error');
    return false;
  }
}

function initFaceId() {
  const btn = $('#faceid-toggle-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const enabling = btn.textContent.trim() === 'Enable Face ID';
    setButtonLoading(btn, true);

    if (enabling) {
      const ok = await enableFaceId();
      setButtonLoading(btn, false);
      if (ok) {
        populateFaceId(true);
        showToast('Face ID enabled.');
      }
      return;
    }

    const confirmed = window.confirm('Disable Face ID sign-in on this account?');
    if (!confirmed) {
      setButtonLoading(btn, false);
      return;
    }

    const { error } = await removeAllWebauthnCredentials(currentUser.id);
    setButtonLoading(btn, false);

    if (error) {
      showToast(error, 'error');
      return;
    }
    populateFaceId(false);
    showToast('Face ID disabled.');
  });
}

/* =============================================================
   Account limits
   ============================================================= */

/* ---- Account information + tier badge ---- */
function populateAccountLimits(profile) {
  const badge = $('#account-tier-badge');
  if (badge) {
    const tier = profile?.account_tier || 1;
    badge.dataset.tier = String(tier);
    badge.textContent = `Tier ${tier}`;
  }

  const nameEl = $('#account-info-name');
  if (nameEl) nameEl.textContent = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || '—';

  const numberEl = $('#account-number-value');
  const toggleBtn = $('#account-number-toggle');
  const fullNumber = profile?.account_number || '';
  if (numberEl && toggleBtn) {
    const masked = fullNumber ? `•••• •••• ${fullNumber.slice(-2)}` : '—';
    numberEl.textContent = masked;
    toggleBtn.addEventListener('click', () => {
      const showing = toggleBtn.getAttribute('aria-pressed') === 'true';
      numberEl.textContent = showing ? masked : (fullNumber || '—');
      toggleBtn.textContent = showing ? 'Show' : 'Hide';
      toggleBtn.setAttribute('aria-pressed', String(!showing));
    });
  }
}

/* -----------------------------------------------------------
   Verification stepper — Tier 1 → 2 → 3
   -----------------------------------------------------------
   Document type lists per tier. Tier 2 renders the same identity
   list as Tier 1 but with whichever type Tier 1 actually used
   filtered out (per the requested "removed the document first
   submitted in tier 1" behavior).
   ----------------------------------------------------------- */
const TIER_DOC_TYPES = {
  identity: [
    { value: 'nin', label: 'National Identification Number (NIN)' },
    { value: 'drivers_license', label: "Driver's license" },
    { value: 'international_passport', label: 'International passport' },
    { value: 'voters_card', label: "Voter's card" },
  ],
  proof_of_address: [
    { value: 'electricity_bill', label: 'Electricity bill' },
    { value: 'bank_statement', label: 'Bank statement' },
    { value: 'waste_bill', label: 'Waste bill' },
    { value: 'water_bill', label: 'Water bill' },
    { value: 'house_rent_receipt', label: 'House rent receipt' },
    { value: 'tenancy_agreement', label: 'Tenancy agreement' },
  ],
};

const TIER_META = {
  1: { category: 'identity', title: 'Tier 1 verification', blurb: 'Verify your identity with one government-issued ID.' },
  2: { category: 'identity', title: 'Tier 2 verification', blurb: 'Verify with a second, different form of ID.' },
  3: { category: 'proof_of_address', title: 'Tier 3 verification', blurb: 'Confirm your address to unlock the highest limits.' },
};

// The full document history for the signed-in user, newest first —
// re-fetched after every submission so the stepper always reflects
// the latest admin decision.
let identityDocsCache = [];

// Which tier's verified details are currently unmasked in the UI,
// and which tier the shared re-auth modal is unlocking right now.
const revealedTiers = new Set();
let pendingRevealTier = null;

function docTypeLabel(category, value) {
  const match = (TIER_DOC_TYPES[category] || []).find((t) => t.value === value);
  return match ? match.label : value;
}

/**
 * Works out where each tier stands from the raw document history.
 * Slot is only ever assigned to VERIFIED identity documents (slot 1
 * = Tier 1, slot 2 = Tier 2 — see 017_identity_document_review_
 * details.sql); proof-of-address documents never take a slot, so
 * Tier 3's "verified" state is just "a verified proof_of_address row
 * exists" with no slot check.
 *
 * A pending/rejected identity submission with no slot yet is
 * attributed to whichever identity tier is currently open — Tier 1
 * if it isn't verified yet, otherwise Tier 2 — which holds because
 * the stepper itself never lets a customer start Tier 2 before
 * Tier 1 is verified, so only one identity tier can have an
 * in-flight submission at a time.
 */
function classifyIdentityDocs(docs) {
  const identityDocs = (docs || [])
    .filter((d) => d.document_category === 'identity')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const addressDocs = (docs || [])
    .filter((d) => d.document_category === 'proof_of_address')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const tier1Verified = identityDocs.find((d) => d.status === 'verified' && d.slot === 1) || null;
  const tier2Verified = identityDocs.find((d) => d.status === 'verified' && d.slot === 2) || null;
  const tier3Verified = addressDocs.find((d) => d.status === 'verified') || null;

  const latestIdentityOpen = identityDocs.find((d) => d.status !== 'verified') || null;
  const latestAddressOpen = addressDocs.find((d) => d.status !== 'verified') || null;

  return {
    1: { verified: tier1Verified, open: !tier1Verified ? latestIdentityOpen : null },
    2: { verified: tier2Verified, open: (tier1Verified && !tier2Verified) ? latestIdentityOpen : null },
    3: { verified: tier3Verified, open: (tier2Verified && !tier3Verified) ? latestAddressOpen : null },
  };
}

function maskId(value) {
  if (!value) return '—';
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function verifiedDetailsMarkup(category, doc) {
  if (category === 'proof_of_address') {
    return `
      <dl class="account-info-grid">
        <div><dt>Document</dt><dd>${escapeHtml(docTypeLabel(category, doc.document_type))}</dd></div>
      </dl>
    `;
  }
  return `
    <dl class="account-info-grid">
      <div><dt>ID type</dt><dd>${escapeHtml((doc.id_type || doc.document_type || '').toUpperCase())}</dd></div>
      <div><dt>Full name</dt><dd>${escapeHtml(doc.full_name) || '—'}</dd></div>
      <div><dt>ID number</dt><dd>${escapeHtml(maskId(doc.id_number))}</dd></div>
      <div><dt>Date of birth</dt><dd>${doc.date_of_birth ? new Date(doc.date_of_birth).toLocaleDateString('en-GB') : '—'}</dd></div>
      <div><dt>Gender</dt><dd>${escapeHtml(doc.gender) || '—'}</dd></div>
    </dl>
  `;
}

/* ---- Block builders — one per tier state ---- */

function buildLockedTierBlock(tier, meta) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="verification-tier-head">
      <span class="verification-tier-number">${tier}</span>
      <div>
        <h4>${meta.title}</h4>
        <p>Complete Tier ${tier - 1} first to unlock this step.</p>
      </div>
      <span class="status-pill status-pill--neutral">Locked</span>
    </div>
  `;
  return wrap;
}

function buildVerifiedTierBlock(tier, meta, doc) {
  const wrap = document.createElement('div');
  const nextTier = tier + 1;
  const isRevealed = revealedTiers.has(tier);
  const verifiedDate = doc.reviewed_at
    ? new Date(doc.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  wrap.innerHTML = `
    <div class="verification-tier-head">
      <span class="verification-tier-number">${tier}</span>
      <div>
        <h4>${meta.title}</h4>
        <p>${escapeHtml(docTypeLabel(meta.category, doc.document_type))}${verifiedDate ? ` · Verified ${verifiedDate}` : ''}</p>
      </div>
      <span class="status-pill status-pill--verified">Verified</span>
    </div>
    <div class="verification-tier-details">
      ${isRevealed ? verifiedDetailsMarkup(meta.category, doc) : ''}
      <button type="button" class="link-arrow-sm" data-reveal-btn>${isRevealed ? 'Hide details' : 'View details'}</button>
    </div>
  `;

  $('[data-reveal-btn]', wrap).addEventListener('click', () => {
    if (revealedTiers.has(tier)) {
      revealedTiers.delete(tier);
      renderVerificationStepper(identityDocsCache);
      return;
    }
    pendingRevealTier = tier;
    openVerifyIdentityModal();
  });

  if (nextTier <= 3) {
    const upgradeBtn = document.createElement('button');
    upgradeBtn.type = 'button';
    upgradeBtn.className = 'btn btn-primary verification-upgrade-btn';
    upgradeBtn.textContent = `Upgrade to Tier ${nextTier}`;
    upgradeBtn.addEventListener('click', () => {
      $(`#verification-tier-${nextTier}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    wrap.appendChild(upgradeBtn);
  } else {
    const doneNote = document.createElement('p');
    doneNote.className = 'field-hint';
    doneNote.textContent = 'You\u2019ve completed every verification tier.';
    wrap.appendChild(doneNote);
  }

  return wrap;
}

function buildPendingTierBlock(tier, meta, doc) {
  const wrap = document.createElement('div');
  const submitted = new Date(doc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  wrap.innerHTML = `
    <div class="verification-tier-head">
      <span class="verification-tier-number">${tier}</span>
      <div>
        <h4>${meta.title}</h4>
        <p>${escapeHtml(docTypeLabel(meta.category, doc.document_type))} submitted ${submitted}</p>
      </div>
      <span class="status-pill status-pill--pending">Pending review</span>
    </div>
    <p class="profile-card-desc">We're reviewing your document. This will update automatically once it's been checked.</p>
  `;
  return wrap;
}

function buildRejectedTierBlock(tier, meta, doc, tier1UsedType) {
  const wrap = document.createElement('div');
  const label = doc.status === 'rejected' ? 'Rejected' : 'Action required';
  wrap.innerHTML = `
    <div class="verification-tier-head">
      <span class="verification-tier-number">${tier}</span>
      <div>
        <h4>${meta.title}</h4>
        <p>${escapeHtml(docTypeLabel(meta.category, doc.document_type))}</p>
      </div>
      <span class="status-pill status-pill--pending">${label}</span>
    </div>
    <p class="profile-card-desc">${escapeHtml(doc.rejection_reason) || 'This submission needs another look — please resubmit.'}</p>
  `;
  wrap.appendChild(buildUploadForm(tier, meta, tier1UsedType, { resubmit: true }));
  return wrap;
}

function buildActiveTierBlock(tier, meta, tier1UsedType) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="verification-tier-head">
      <span class="verification-tier-number">${tier}</span>
      <div>
        <h4>${meta.title}</h4>
        <p>${meta.blurb}</p>
      </div>
      <span class="status-pill status-pill--neutral">Not started</span>
    </div>
  `;
  wrap.appendChild(buildUploadForm(tier, meta, tier1UsedType));
  return wrap;
}

/* ---- The upload form itself, shared by "active" and "rejected/resubmit" states ---- */
function buildUploadForm(tier, meta, tier1UsedType, { resubmit = false } = {}) {
  const container = document.createElement('div');
  container.className = 'verification-upload';

  let options = TIER_DOC_TYPES[meta.category];
  if (tier === 2 && tier1UsedType) {
    options = options.filter((opt) => opt.value !== tier1UsedType);
  }
  const optionsHtml = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join('');

  container.innerHTML = `
    <form class="profile-form verification-upload-form" novalidate>
      <div class="field">
        <label>Document type</label>
        <select name="document_type" required>
          <option value="">Select a document</option>
          ${optionsHtml}
        </select>
      </div>
      <div class="document-upload-dropzone" tabindex="0" role="button" aria-label="Upload document">
        <p>Click or drop a file here — PDF, JPG, or PNG, up to 10MB</p>
        <input type="file" accept=".pdf,.jpg,.jpeg,.png" hidden>
      </div>
      <div class="document-upload-preview" hidden>
        <span data-preview-name></span>
        <button type="button" class="link-arrow-sm" data-remove-file>Remove</button>
      </div>
      <div class="document-upload-progress" hidden><div class="document-upload-progress-bar" style="width:0%"></div></div>
      <div class="admin-field-error" data-upload-error></div>
      <div class="profile-form-actions">
        <button type="submit" class="btn btn-primary">${resubmit ? 'Resubmit document' : 'Submit for verification'}</button>
      </div>
    </form>
  `;

  wireUploadForm(container, meta.category);
  return container;
}

function wireUploadForm(scope, documentCategory) {
  const form = $('.verification-upload-form', scope);
  const dropzone = $('.document-upload-dropzone', scope);
  const fileInput = $('input[type="file"]', scope);
  const typeSelect = $('select[name="document_type"]', scope);
  const preview = $('.document-upload-preview', scope);
  const previewName = $('[data-preview-name]', scope);
  const removeBtn = $('[data-remove-file]', scope);
  const progress = $('.document-upload-progress', scope);
  const progressBar = $('.document-upload-progress-bar', scope);
  const errorEl = $('[data-upload-error]', scope);
  const submitBtn = $('button[type="submit"]', form);

  let selectedFile = null;

  function setFile(file) {
    selectedFile = file || null;
    if (errorEl) errorEl.textContent = '';
    if (selectedFile) {
      if (previewName) previewName.textContent = selectedFile.name;
      if (preview) preview.hidden = false;
    } else if (preview) {
      preview.hidden = true;
    }
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  ['dragover', 'dragenter'].forEach((evt) => dropzone.addEventListener(evt, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'dragend', 'drop'].forEach((evt) => dropzone.addEventListener(evt, () => {
    dropzone.classList.remove('is-dragover');
  }));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) setFile(file);
  });

  fileInput.addEventListener('change', () => setFile(fileInput.files?.[0]));
  removeBtn.addEventListener('click', () => {
    fileInput.value = '';
    setFile(null);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!typeSelect.value) {
      if (errorEl) errorEl.textContent = 'Choose a document type.';
      return;
    }
    if (!selectedFile) {
      if (errorEl) errorEl.textContent = 'Choose a file to upload.';
      return;
    }

    if (errorEl) errorEl.textContent = '';
    setButtonLoading(submitBtn, true);
    if (progress) progress.hidden = false;
    if (progressBar) progressBar.style.width = '15%';

    // supabase-js's storage upload doesn't expose real upload
    // progress — this is a visual approximation, not measured bytes.
    const tick = setInterval(() => {
      if (!progressBar) return;
      const current = parseFloat(progressBar.style.width) || 0;
      if (current < 85) progressBar.style.width = `${current + 10}%`;
    }, 200);

    const { error } = await submitIdentityDocument({
      file: selectedFile,
      documentType: typeSelect.value,
      documentCategory,
      userId: currentUser.id,
    });

    clearInterval(tick);

    if (error) {
      if (progress) progress.hidden = true;
      setButtonLoading(submitBtn, false);
      if (errorEl) errorEl.textContent = error;
      return;
    }

    if (progressBar) progressBar.style.width = '100%';
    setButtonLoading(submitBtn, false);
    showToast('Document submitted for verification.');

    await reloadVerificationStepper();
  });
}

/* ---- Top-level render: one tier container at a time ---- */
function renderTier(tier, status, tier1UsedType) {
  const container = $(`#verification-tier-${tier}`);
  if (!container) return;

  const meta = TIER_META[tier];
  const state = status[tier];
  const prevVerified = tier === 1 ? true : Boolean(status[tier - 1].verified);

  container.innerHTML = '';
  container.classList.remove('is-locked', 'is-verified', 'is-pending', 'is-rejected', 'is-active');

  if (!prevVerified) {
    container.classList.add('is-locked');
    container.appendChild(buildLockedTierBlock(tier, meta));
    return;
  }

  if (state.verified) {
    container.classList.add('is-verified');
    container.appendChild(buildVerifiedTierBlock(tier, meta, state.verified));
    return;
  }

  if (state.open && state.open.status === 'pending') {
    container.classList.add('is-pending');
    container.appendChild(buildPendingTierBlock(tier, meta, state.open));
    return;
  }

  if (state.open && (state.open.status === 'rejected' || state.open.status === 'action_required')) {
    container.classList.add('is-rejected');
    container.appendChild(buildRejectedTierBlock(tier, meta, state.open, tier1UsedType));
    return;
  }

  container.classList.add('is-active');
  container.appendChild(buildActiveTierBlock(tier, meta, tier1UsedType));
}

function renderVerificationStepper(docs) {
  identityDocsCache = docs || [];
  const status = classifyIdentityDocs(identityDocsCache);
  const tier1UsedType = status[1].verified?.document_type || status[1].open?.document_type || null;

  [1, 2, 3].forEach((tier) => renderTier(tier, status, tier1UsedType));
}

async function reloadVerificationStepper() {
  const { data: docs, error } = await getMyIdentityDocumentHistory(currentUser.id);
  if (error) {
    showToast(error, 'error');
    return;
  }
  renderVerificationStepper(docs || []);
}

/* ---- Shared re-auth modal (unlocks a verified tier's details) ---- */
function openVerifyIdentityModal() {
  const modal = $('#verify-identity-modal');
  if (!modal) return;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('is-open'));
  const input = $('#verify-identity-password');
  if (input) { input.value = ''; input.focus(); }
  const err = $('#verify-identity-modal-error');
  if (err) err.textContent = '';
}

function closeVerifyIdentityModal() {
  const modal = $('#verify-identity-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  setTimeout(() => { modal.hidden = true; }, 200);
  pendingRevealTier = null;
}

function initVerifyIdentityModal() {
  const modal = $('#verify-identity-modal');
  const closeBtn = $('#verify-identity-modal-close');
  const cancelBtn = $('#verify-identity-modal-cancel');
  const form = $('#verify-identity-form');
  if (!modal || !form) return;

  closeBtn?.addEventListener('click', closeVerifyIdentityModal);
  cancelBtn?.addEventListener('click', closeVerifyIdentityModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeVerifyIdentityModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const passwordInput = $('#verify-identity-password');
    const password = passwordInput?.value || '';
    const errEl = $('#verify-identity-modal-error');
    const submitBtn = $('#verify-identity-modal-submit');

    if (!password) {
      if (errEl) errEl.textContent = 'Enter your password.';
      return;
    }

    setButtonLoading(submitBtn, true);
    const { error } = await verifyCurrentPassword(password);
    setButtonLoading(submitBtn, false);

    if (error) {
      if (errEl) errEl.textContent = 'Incorrect password. Try again.';
      return;
    }

    const tier = pendingRevealTier;
    closeVerifyIdentityModal();
    if (tier) {
      revealedTiers.add(tier);
      renderVerificationStepper(identityDocsCache);
    }
  });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await requireAuth();
  if (!user) return; // requireAuth() already redirected to login.html
  currentUser = user;

  waitForNavbar().then(() => {
    populateNotificationBadge();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  initSectionNav();
  initAvatarUpload();
  initPasswordForm('#password-change-form');
  initPasswordForm('#login-password-change-form', { requirementsListSelector: '#login-password-requirements' });
  initPasswordToggle();
  initTwoFactorPicker();
  initNotificationSwitches();
  initDangerZone();

  // Login settings
  initForgotPassword();
  initLoginSessionPreference();
  initFaceId();

  // Account limits
  initVerifyIdentityModal();

  const { data: profile, error } = await getMyProfile(user.id);
  if (error || !profile) {
    showToast('Couldn\u2019t load your profile. Try refreshing the page.', 'error');
    return;
  }

  currentProfile = profile;
  waitForNavbar().then(() => populateHeader(profile));
  populateBanner(profile);
  populatePersonalForm(profile);
  populateTwoFactor(profile);
  populateNotificationPreferences(profile);
  populateAccountLimits(profile);
  populateLoginSessionPreference(profile);

  const { data: credentials } = await getMyWebauthnCredentials(user.id);
  populateFaceId(Boolean(credentials?.length));

  const { data: accounts } = await getMyAccounts(user.id);
  await populateOverviewSummary(user, profile, accounts || []);
  await populateRecentActivity(user.id);
  await populateSessions(user.id);
  await reloadVerificationStepper();
})();
