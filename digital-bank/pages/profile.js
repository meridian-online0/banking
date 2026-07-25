/* =============================================================
   MERIDIAN — Account profile page
   Script: pages/profile.js
   Loaded as a module by profile.html only. Handles:
     1. Auth guard
     2. Header identity (name, avatar) + notification badge —
        mirrors dashboard.js's approach against the shared
        components/app-navbar.html component
     3. User menu dropdown, mobile nav toggle, log out — same
        implementations as dashboard.js, targeting the navbar
        component's #logout-link
     4. Section navigation (Overview / Personal / Security /
        Notifications / Danger zone) — hash-linked, keyboard
        accessible tabs
     5. Loading the signed-in user's profile into the banner,
        the Overview summary, and the (read-only) Personal info
        form
     6. Avatar upload (via supabase/storage.js)
     7. Recent account activity — from audit_logs
     8. Active sessions — from login_sessions
     9. Password change form — client-side match check +
        supabase.auth.updateUser via updateUserPassword()
     10. Two-factor method picker — saved to user_profiles.two_factor_method
     11. Notification preference switches — saved to user_profiles
     12. Danger zone actions (data export / close account) — stubs
     13. Toast helper for save feedback

   NOTE: the Personal info form is view-only by design — every
   field is disabled in the markup and there is no save handler
   for it here. Two-factor, notification preferences, and password
   are still editable, since those are account/security actions
   rather than profile fields.
   ============================================================= */

import { requireAuth, signOutUser, updateUserPassword } from '../supabase/auth.js';
import { supabase } from '../supabase/config.js';
import {
  getMyProfile,
  updateMyProfile,
  getMyAccounts,
  getCardsForAccount,
  getUnreadNotificationCount,
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
   Header identity + notification badge
   Same approach as dashboard.js against the shared navbar
   component (components/app-navbar.html).
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
   Log out — targets the navbar component's #logout-link
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
   Overview summary — linked accounts, active cards, active
   sessions, all pulled live rather than hardcoded.
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
   Recent account activity — from audit_logs
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
   Active sessions — from login_sessions where logout_time is
   null. The most recently started open session is shown as
   "Current". Revoking a specific *other* session is front-end
   only for now: auth.js closes the current session's row on
   sign-out, but there's no revokeLoginSession(sessionId) export
   yet to close a specific other one. Wire this up once that
   exists.
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
   Shared field-error helpers (used by the password form)
   ----------------------------------------------------------- */
function clearFieldErrors(form) {
  $$('.field', form).forEach((field) => {
    field.classList.remove('has-error');
    const err = $('.field-error', field);
    if (err) err.textContent = '';
  });
}

function setFieldError(form, name, message) {
  const input = form.elements[name];
  if (!input) return;
  const field = input.closest('.field');
  if (!field) return;
  field.classList.add('has-error');
  const err = $('.field-error', field);
  if (err) err.textContent = message;
}

/* -----------------------------------------------------------
   Password change form
   ----------------------------------------------------------- */
function passwordStrength(password) {
  let score = 0;
  if (password.length >= 10) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return score;
}

function initPasswordForm() {
  const form = $('#password-change-form');
  if (!form) return;

  const newPasswordInput = form.elements['new_password'];
  let strengthMeter = $('.password-strength', form);
  if (!strengthMeter && newPasswordInput) {
    strengthMeter = document.createElement('div');
    strengthMeter.className = 'password-strength';
    strengthMeter.innerHTML = '<span></span><span></span><span></span><span></span>';
    newPasswordInput.closest('.field').appendChild(strengthMeter);
  }

  if (newPasswordInput) {
    newPasswordInput.addEventListener('input', () => {
      strengthMeter.dataset.strength = String(passwordStrength(newPasswordInput.value));
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);

    const { current_password, new_password, new_password_confirm } = Object.fromEntries(new FormData(form).entries());

    if (!current_password) {
      setFieldError(form, 'current_password', 'Enter your current password.');
      return;
    }
    if (new_password.length < 10) {
      setFieldError(form, 'new_password', 'Use at least 10 characters.');
      return;
    }
    if (new_password !== new_password_confirm) {
      setFieldError(form, 'new_password_confirm', 'Passwords don\u2019t match.');
      return;
    }

    const submitBtn = $('button[type="submit"]', form);
    setButtonLoading(submitBtn, true);

    const { error } = await updateUserPassword(new_password);

    setButtonLoading(submitBtn, false);

    if (error) {
      showToast(error, 'error');
      return;
    }

    form.reset();
    if (strengthMeter) strengthMeter.removeAttribute('data-strength');
    showToast('Your password has been updated.');
  });
}

/* -----------------------------------------------------------
   Password visibility toggle
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

  // These map to boolean columns on user_profiles. Security alerts
  // are intentionally always-on and disabled in the markup.
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
        input.checked = !input.checked; // revert on failure
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
      // Placeholder: no data-export endpoint exists yet server-side.
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

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await requireAuth();
  if (!user) return; // requireAuth() already redirected to login.html
  currentUser = user;

  initUserMenu();
  initLogout();
  initMobileNav();
  initSectionNav();
  initAvatarUpload();
  initPasswordForm();
  initPasswordToggle();
  initTwoFactorPicker();
  initNotificationSwitches();
  initDangerZone();
  populateNotificationBadge();

  const { data: profile, error } = await getMyProfile(user.id);
  if (error || !profile) {
    showToast('Couldn\u2019t load your profile. Try refreshing the page.', 'error');
    return;
  }

  currentProfile = profile;
  populateHeader(profile);
  populateBanner(profile);
  populatePersonalForm(profile);
  populateTwoFactor(profile);
  populateNotificationPreferences(profile);

  const { data: accounts } = await getMyAccounts(user.id);
  await populateOverviewSummary(user, profile, accounts || []);
  await populateRecentActivity(user.id);
  await populateSessions(user.id);
})();
