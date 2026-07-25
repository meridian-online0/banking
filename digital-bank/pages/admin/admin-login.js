/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-login.js

   FLOW
   ----
   1. redirectIfAdminAuthenticated() — bounce a valid, already
      signed-in admin straight to admin-dashboard.html (or ?next=).
   2. Email + password via signInUser() from supabase/auth.js —
      the same function the customer login page uses. Meridian has
      one auth system (see admin_schema.sql's design note: role
      lives on user_profiles, not a separate login table), so
      signing in as an admin IS signing in as a Supabase Auth user;
      what makes it an "admin" login is everything AFTER that
      succeeds, not a different credential check.
   3. Immediately after a successful sign-in, fetch the user's own
      user_profiles row and check `role`:
        - not support/admin/superadmin → sign back out immediately
          and show a generic error. A customer's password working
          on this page must never leave them in a signed-in state
          here, even briefly — there's nothing for them to do with
          that session on this origin, and leaving it live is
          needless residual risk.
        - support/admin/superadmin → signed in.
   4. On success, redirect to the ?next= this page was opened with
      (validated — see isSafeNextPath below) or admin-dashboard.html.

   NOTE — 2FA REMOVED
   -------------------
   This page previously had a second step (code entry) for
   admin/superadmin roles. It was demo-scaffolding only — no real
   OTP delivery backend existed, and the code was generated and
   checked entirely client-side (visible in the console), so it
   was providing a UI flow, not real security. It's been removed
   rather than left in place as a false signal of protection. The
   role check below (VALID_ADMIN_ROLES) is what actually gates
   access — a visitor still needs a correct email/password for an
   account whose role is support, admin, or superadmin.

   If real 2FA is added later, it belongs behind a server-side
   verification endpoint (e.g. a Supabase Edge Function that
   generates a code, stores a hash with an expiry, and verifies it
   server-side) — never compared in the browser the way the
   removed scaffold did.
   ============================================================= */

import { signInUser, signOutUser } from '../../supabase/auth.js';
import { redirectIfAdminAuthenticated } from '../../assets/js/admin/admin-guard.js';
import { supabase } from '../../supabase/config.js';

const ADMIN_DASHBOARD_PATH = 'admin-dashboard.html';
const VALID_ADMIN_ROLES = ['support', 'admin', 'superadmin'];

const $ = (selector) => document.querySelector(selector);

const credentialsForm = $('#admin-login-step-credentials');
const credentialsError = $('#credentials-error');

function setButtonLoading(form, isLoading) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  btn.disabled = isLoading;
  btn.classList.toggle('is-loading', isLoading);
}

/**
 * Only ever redirect to a same-page-relative path within
 * pages/admin/ — never an absolute URL or a protocol-relative one.
 * ?next= is attacker-controllable (it's a query param on a public
 * URL), so this is what stops it being turned into an open
 * redirect off Meridian's admin login page.
 */
function isSafeNextPath(path) {
  if (!path) return false;
  if (/^https?:\/\//i.test(path)) return false;
  if (path.startsWith('//')) return false;
  if (path.startsWith('/')) return false;
  return true;
}

function resolveRedirectTarget() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  return isSafeNextPath(next) ? next : ADMIN_DASHBOARD_PATH;
}

async function fetchOwnProfile(userId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

/* -----------------------------------------------------------
   Sign in
   ----------------------------------------------------------- */
credentialsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  credentialsError.textContent = '';

  const email = credentialsForm.elements.email.value.trim();
  const password = credentialsForm.elements.password.value;

  setButtonLoading(credentialsForm, true);
  const { data, error } = await signInUser(email, password);
  setButtonLoading(credentialsForm, false);

  if (error) {
    credentialsError.textContent = error;
    return;
  }

  const user = data.user;
  const { data: profile, error: profileError } = await fetchOwnProfile(user.id);

  if (profileError || !profile || !VALID_ADMIN_ROLES.includes(profile.role)) {
    // Not an admin account — do not leave this session live on the
    // admin login page. Generic message: don't confirm to the
    // visitor whether the account exists but lacks access vs.
    // doesn't exist at all.
    await signOutUser();
    credentialsError.textContent = 'That email and password combination doesn\u2019t match our records.';
    return;
  }

  window.location.href = resolveRedirectTarget();
});

/* -----------------------------------------------------------
   Init — bounce an already-signed-in admin immediately.
   ----------------------------------------------------------- */
(async function init() {
  await redirectIfAdminAuthenticated();
  // If that redirected, the browser is already navigating away —
  // nothing below matters. If not, reveal the form.
  document.body.dataset.adminAuth = 'ready';
  credentialsForm.hidden = false;
})();
