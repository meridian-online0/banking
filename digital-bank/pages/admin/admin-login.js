/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-login.js

   FLOW
   ----
   1. redirectIfAdminAuthenticated() — bounce a valid, already
      signed-in admin straight to admin-dashboard.html (or ?next=).
   2. Step 1: email + password via signInUser() from supabase/auth.js
      — the same function the customer login page uses. Meridian
      has one auth system (see admin_schema.sql's design note: role
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
        - 'support' → 2FA not required by the architecture spec
          (only admin/superadmin), go straight to step 4.
        - 'admin' / 'superadmin' with two_factor_method configured
          → step 2 (code entry).
        - 'admin' / 'superadmin' with NO two_factor_method
          configured → hard stop (step 3 in the HTML). This is a
          deliberate dead end: the architecture doc says 2FA must
          be "mandatory... enforced at login, not just offered" for
          these tiers, so letting them through without it would
          quietly violate that rather than enforce it.
   4. On success, redirect to the ?next= this page was opened with
      (validated — see isSafeNextPath below) or admin-dashboard.html.

   IMPORTANT — 2FA IS SCAFFOLDED, NOT REAL YET
   ---------------------------------------------
   There is no OTP delivery backend in this codebase yet (no email/
   SMS send, no server-side code verification) — same gap
   verifyCurrentPassword()'s TODO in supabase/auth.js already flags
   for the transfer-verification flow. sendTwoFactorCode() and
   verifyTwoFactorCode() below are DEMO-QUALITY, matching the
   precedent settings.js already set for generateApiKeySecret():
   the code is generated and checked entirely client-side, which
   provides a working UI flow and NO real security. Before this
   goes anywhere near production:
     - replace sendTwoFactorCode() with a call to a Supabase Edge
       Function that generates a code, stores a hash of it
       server-side with an expiry, and delivers it via the user's
       two_factor_method (email/SMS/authenticator).
     - replace verifyTwoFactorCode() with a call to that same
       function's verification endpoint — never compare the code
       client-side against anything the client itself generated.
   The on-screen "dev code" toast below exists ONLY so this is
   impossible to mistake for a real security boundary during
   review; remove it the moment a real backend lands.
   ============================================================= */

import { signInUser, signOutUser } from '../../supabase/auth.js';
import { redirectIfAdminAuthenticated } from '../../assets/js/admin/admin-guard.js';
import { supabase } from '../../supabase/config.js';

const ADMIN_DASHBOARD_PATH = 'admin-dashboard.html';
const ROLES_REQUIRING_2FA = ['admin', 'superadmin'];
const VALID_ADMIN_ROLES = ['support', 'admin', 'superadmin'];

const $ = (selector) => document.querySelector(selector);

const credentialsForm = $('#admin-login-step-credentials');
const credentialsError = $('#credentials-error');
const twoFaForm = $('#admin-login-step-2fa');
const twoFaError = $('#two-fa-error');
const twoFaSubtitle = $('#two-fa-subtitle');
const twoFaRequiredBlock = $('#admin-login-2fa-required');

// Carries the signed-in-but-not-yet-fully-verified user across the
// two steps of this page. Never persisted — a fresh page load
// always starts back at step 1, which is correct: if a visitor
// abandons mid-2FA and comes back, they should re-enter their
// password rather than resume a half-finished login silently.
let pendingUser = null;
let pendingProfile = null;
let devCodeForThisSession = null; // scaffold only — see file header

function setButtonLoading(form, isLoading) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  btn.disabled = isLoading;
  btn.classList.toggle('is-loading', isLoading);
}

function showStep(step) {
  credentialsForm.hidden = step !== 'credentials';
  twoFaForm.hidden = step !== 'two-fa';
  twoFaRequiredBlock.hidden = step !== 'two-fa-required';
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
   2FA scaffold — see file header. Replace both functions with
   real Edge Function calls before production use.
   ----------------------------------------------------------- */
async function sendTwoFactorCode(profile) {
  devCodeForThisSession = String(Math.floor(100000 + Math.random() * 900000));
  console.warn(
    '[Meridian Admin] DEV-ONLY 2FA code (no real delivery backend exists yet):',
    devCodeForThisSession
  );
  twoFaSubtitle.textContent =
    `DEV MODE — no real ${profile.two_factor_method || 'delivery method'} was sent. ` +
    `Check the browser console for the code.`;
  return { data: true, error: null };
}

async function verifyTwoFactorCode(code) {
  // NOT real verification — see file header. A production version
  // must call a server endpoint and never compare in the browser.
  if (code === devCodeForThisSession) {
    return { data: true, error: null };
  }
  return { data: false, error: 'That code isn\u2019t right. Check the console for the current dev code.' };
}

/* -----------------------------------------------------------
   Step 1 — credentials
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

  pendingUser = user;
  pendingProfile = profile;

  if (!ROLES_REQUIRING_2FA.includes(profile.role)) {
    // 'support' tier — no mandatory 2FA per the architecture spec.
    completeLogin();
    return;
  }

  if (!profile.two_factor_method) {
    showStep('two-fa-required');
    return;
  }

  await sendTwoFactorCode(profile);
  showStep('two-fa');
  twoFaForm.elements.code.focus();
});

/* -----------------------------------------------------------
   Step 2 — 2FA code
   ----------------------------------------------------------- */
twoFaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  twoFaError.textContent = '';

  const code = twoFaForm.elements.code.value.trim();
  setButtonLoading(twoFaForm, true);
  const { data: ok, error } = await verifyTwoFactorCode(code);
  setButtonLoading(twoFaForm, false);

  if (error || !ok) {
    twoFaError.textContent = error || 'Invalid code.';
    return;
  }

  completeLogin();
});

$('#two-fa-resend').addEventListener('click', async () => {
  if (!pendingProfile) return;
  await sendTwoFactorCode(pendingProfile);
});

$('#two-fa-back').addEventListener('click', resetToCredentials);
$('#two-fa-required-back').addEventListener('click', async () => {
  // The user got this far by authenticating successfully but
  // lacking 2FA setup — sign them back out rather than leaving an
  // authenticated-but-blocked session sitting idle in the browser.
  if (pendingUser) await signOutUser();
  resetToCredentials();
});

async function resetToCredentials() {
  pendingUser = null;
  pendingProfile = null;
  devCodeForThisSession = null;
  credentialsForm.reset();
  twoFaForm.reset();
  credentialsError.textContent = '';
  twoFaError.textContent = '';
  showStep('credentials');
}

/* -----------------------------------------------------------
   Finish — reveal is implicit: we're navigating away.
   ----------------------------------------------------------- */
function completeLogin() {
  window.location.href = resolveRedirectTarget();
}

/* -----------------------------------------------------------
   Init — bounce an already-signed-in admin immediately.
   ----------------------------------------------------------- */
(async function init() {
  await redirectIfAdminAuthenticated();
  // If that redirected, the browser is already navigating away —
  // nothing below matters. If not, reveal the form.
  document.body.dataset.adminAuth = 'ready';
  showStep('credentials');
})();
