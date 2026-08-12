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
     14. NEW — Login settings: forgot password, login session
         preference, Face ID / device biometrics
     15. NEW — Account limits: tier badge + account info, Linked ID
         re-auth + reveal, accepted documents (static), document
         upload

   NOTE: the Personal info form is view-only by design — every
   field is disabled in the markup and there is no save handler
   for it here.

   CHANGE LOG (this revision)
   ---------------------------
   revealLinkedIds() now explicitly filters to documents where
   status === 'verified' AND slot is set, rather than trusting
   slot alone. database.js's getMyIdentityDocuments() returns EVERY
   submission the user has ever made — pending and rejected
   included — by design (its own header comment: "Every document
   ... has ever submitted, newest first"), so a pending or rejected
   upload must never render inside a Linked ID 1/2/3 card. The
   database schema's identity_documents_slot_requires_verified
   constraint means slot alone would probably be safe today, but
   checking status explicitly here doesn't depend on that constraint
   never changing, and it's the same "only successful, with details"
   rule the accompanying migration patch (017) exists to make
   meaningful in the first place.
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
  getMyIdentityDocuments,
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

  // Exposed so "Add document" (Linked ID empty state) can jump the
  // user to the Upload documents card without duplicating this logic.
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
   Login settings tab's form. Both now re-verify the current
   password via verifyCurrentPassword() before rotating it —
   updateUserPassword() (supabase.auth.updateUser) doesn't itself
   check the old password, so without this, anyone with an open
   session could change the password without knowing it.
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
   tab, and the Linked ID modal) with no per-form wiring needed.
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
   NEW — Login settings
   ============================================================= */

/* ---- Forgot password ---- */
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

/* ---- Login session preference ---- */
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

/* ---- Face ID / device biometrics ---- */
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

    // Demo-only: stores the raw credential id and an opaque encoding of
    // the attestation response so "Face ID: Enabled" is a real, persisted
    // state. This does NOT implement the server-side signature/challenge
    // verification a production WebAuthn login would need — see migration
    // 016's "STILL OPEN" item 1. Nothing yet can verify a future assertion
    // against what's stored here.
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
   NEW — Account limits
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

/* ---- Linked ID re-auth modal + reveal ---- */
function openLinkedIdModal() {
  const modal = $('#linked-id-auth-modal');
  if (!modal) return;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('is-open'));
  const input = $('#linked-id-password');
  if (input) { input.value = ''; input.focus(); }
  const err = $('#linked-id-modal-error');
  if (err) err.textContent = '';
}

function closeLinkedIdModal() {
  const modal = $('#linked-id-auth-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  setTimeout(() => { modal.hidden = true; }, 200);
}

function renderLinkedIdCard(slot, doc) {
  const card = $(`#linked-id-card-${slot}`);
  if (!card) return;
  const statusPill = $('[data-linked-id-status]', card);
  const emptyState = $('.linked-id-empty', card);
  const fields = $('.linked-id-fields', card);

  if (!doc) {
    if (statusPill) { statusPill.textContent = 'Empty'; statusPill.className = 'status-pill status-pill--neutral'; }
    if (emptyState) emptyState.hidden = false;
    if (fields) fields.hidden = true;
    return;
  }

  if (statusPill) { statusPill.textContent = 'Verified'; statusPill.className = 'status-pill status-pill--verified'; }
  if (emptyState) emptyState.hidden = true;
  if (fields) {
    fields.hidden = false;
    const maskId = (value) => (value ? `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : '—');
    const setField = (name, value) => {
      const el = $(`[data-field="${name}"]`, fields);
      if (el) el.textContent = value || '—';
    };
    setField('id_type', (doc.id_type || doc.document_type || '').toUpperCase());
    setField('full_name', doc.full_name);
    setField('id_number', maskId(doc.id_number));
    setField('date_of_birth', doc.date_of_birth ? new Date(doc.date_of_birth).toLocaleDateString('en-GB') : null);
    setField('gender', doc.gender);
  }
}

/**
 * getMyIdentityDocuments() returns EVERY submission the user has
 * ever made, any status — that's the right shape for a future
 * "submission history" view, but wrong for the Linked ID cards,
 * which must only ever show what an admin has actually verified
 * AND assigned a slot to. That filter lives here, explicitly, so
 * a 'pending' or 'rejected' document can never render as if it
 * were confirmed.
 */
async function revealLinkedIds() {
  const details = $('#linked-id-details');
  const { data: docs, error } = await getMyIdentityDocuments(currentUser.id);
  if (error) {
    showToast(error, 'error');
    return;
  }

  const bySlot = { 1: null, 2: null, 3: null };
  (docs || []).forEach((doc) => {
    if (doc.status === 'verified' && doc.slot) bySlot[doc.slot] = doc;
  });

  [1, 2, 3].forEach((slot) => renderLinkedIdCard(slot, bySlot[slot]));
  if (details) details.hidden = false;
}

function initLinkedIdModal() {
  const viewBtn = $('#view-linked-id-btn');
  const modal = $('#linked-id-auth-modal');
  const closeBtn = $('#linked-id-modal-close');
  const cancelBtn = $('#linked-id-modal-cancel');
  const form = $('#linked-id-verify-form');
  if (!viewBtn || !modal || !form) return;

  viewBtn.addEventListener('click', openLinkedIdModal);
  closeBtn?.addEventListener('click', closeLinkedIdModal);
  cancelBtn?.addEventListener('click', closeLinkedIdModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeLinkedIdModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const passwordInput = $('#linked-id-password');
    const password = passwordInput?.value || '';
    const errEl = $('#linked-id-modal-error');
    const submitBtn = $('#linked-id-modal-submit');

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

    closeLinkedIdModal();
    await revealLinkedIds();
  });
}

/* ---- Document upload ---- */
const IDENTITY_ADDRESS_TYPES = [
  'electricity_bill', 'bank_statement', 'waste_bill', 'water_bill',
  'house_rent_receipt', 'tenancy_agreement', 'land_use_charge',
];

function initDocumentUpload() {
  const form = $('#document-upload-form');
  if (!form) return;

  const dropzone = $('#document-upload-dropzone');
  const fileInput = $('#document-upload-input');
  const typeSelect = $('#document-type-select');
  const preview = $('#document-upload-preview');
  const previewName = $('#document-upload-preview-name');
  const removeBtn = $('#document-upload-remove');
  const progress = $('#document-upload-progress');
  const progressBar = $('#document-upload-progress-bar');
  const errorEl = $('#document-upload-error');
  const statusPill = $('#document-upload-status');
  const submitBtn = $('#document-upload-submit-btn');

  let selectedFile = null;

  function updateSubmitState() {
    submitBtn.disabled = !(selectedFile && typeSelect.value);
  }

  function setFile(file) {
    selectedFile = file || null;
    if (errorEl) errorEl.textContent = '';
    if (selectedFile) {
      if (previewName) previewName.textContent = selectedFile.name;
      if (preview) preview.hidden = false;
    } else if (preview) {
      preview.hidden = true;
    }
    updateSubmitState();
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
  typeSelect.addEventListener('change', updateSubmitState);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedFile || !typeSelect.value) return;

    const documentCategory = IDENTITY_ADDRESS_TYPES.includes(typeSelect.value) ? 'proof_of_address' : 'identity';

    if (errorEl) errorEl.textContent = '';
    setButtonLoading(submitBtn, true);
    if (progress) progress.hidden = false;
    if (progressBar) progressBar.style.width = '15%';

    // supabase-js's storage upload doesn't expose a real progress
    // callback — this is a visual approximation, not measured bytes,
    // same "demo-friendly" honesty this file already uses elsewhere.
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
    setTimeout(() => {
      if (progress) progress.hidden = true;
      if (progressBar) progressBar.style.width = '0%';
    }, 500);

    setButtonLoading(submitBtn, false);
    if (statusPill) {
      statusPill.hidden = false;
      statusPill.textContent = 'Pending verification';
      statusPill.className = 'status-pill status-pill--pending';
    }

    form.reset();
    setFile(null);
    showToast('Document submitted for verification.');
  });
}

function initAddDocumentButtons() {
  $$('[data-add-document-for]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const typeSelect = $('#document-type-select');
      if (typeSelect) typeSelect.value = '';
      $('#document-upload-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      typeSelect?.focus();
    });
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
  initLinkedIdModal();
  initDocumentUpload();
  initAddDocumentButtons();

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
})();
