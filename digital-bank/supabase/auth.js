/* =============================================================
   MERIDIAN — International Digital Banking
   Authentication module: supabase/auth.js

   Wraps Supabase Auth for the app and keeps it in sync with the
   custom tables in the schema (user_profiles, login_sessions,
   audit_logs). Import the functions you need into a page script:

     import { signUpUser, signInUser, requireAuth } from '../supabase/auth.js';

   Every exported function returns a plain { data, error } object
   (error is null on success) so page scripts never need to catch
   exceptions to handle expected failures like "wrong password".

   requireAuth() IS THE SINGLE SOURCE OF TRUTH for "is this visitor
   actually signed in" across every authenticated page. Don't add a
   second implementation of this check elsewhere — supabase/page-guard.js
   re-exports this same function under the name guardPage() for pages
   that were written against that name, rather than duplicating the
   logic. If you find a page with its own inline version of this
   check, replace it with an import from here (or from page-guard.js).
   ============================================================= */

import { supabase, ROUTES } from './config.js';

/* -----------------------------------------------------------
   Helpers
   ----------------------------------------------------------- */

/** Very small user-agent reader — good enough for audit/session
 *  logging, not meant to be a full device-detection library. */
function getClientContext() {
  const ua = navigator.userAgent || '';

  let browser = 'Unknown';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/') && !ua.includes('Chromium')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';

  let os = 'Unknown';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Linux')) os = 'Linux';

  const device = /Mobi|Android|iPhone|iPad/.test(ua) ? 'Mobile' : 'Desktop';

  return { browser, operating_system: os, device, user_agent: ua };
}

function friendlyAuthError(error) {
  if (!error) return null;
  const message = error.message || 'Something went wrong. Please try again.';

  // Map a few common Supabase Auth messages to friendlier copy.
  if (message.toLowerCase().includes('invalid login credentials')) {
    return 'That email and password combination doesn\u2019t match our records.';
  }
  if (message.toLowerCase().includes('email not confirmed')) {
    return 'Please verify your email address before logging in.';
  }
  if (message.toLowerCase().includes('user already registered')) {
    return 'An account with this email already exists. Try logging in instead.';
  }
  if (message.toLowerCase().includes('password should be at least')) {
    return 'Your password needs to be at least 8 characters long.';
  }
  return message;
}

/**
 * Reveals a page that was hidden while auth was being confirmed —
 * see assets/js/auth-guard.js for the fast pre-check that hides it
 * in the first place. Supports both patterns currently in use
 * across the app, so requireAuth() works correctly no matter which
 * one a given page's markup uses:
 *
 *   <body class="app-body auth-pending">              (accounts.html)
 *   <body class="app-body" data-auth="pending"> + .auth-loader   (settings.html)
 *
 * Safe to call even if neither pattern is present, and safe to
 * call more than once (e.g. if a page also removes the class
 * itself at the end of its own init()) — later calls are no-ops.
 */
function revealPage() {
  if (typeof document === 'undefined' || !document.body) return;

  document.body.classList.remove('auth-pending');

  if (document.body.dataset.auth !== undefined) {
    document.body.dataset.auth = 'ready';
  }

  const loader = document.querySelector('.auth-loader');
  if (loader) loader.setAttribute('hidden', '');
}

/* -----------------------------------------------------------
   Registration
   ----------------------------------------------------------- */

/**
 * Creates an auth user and the matching user_profiles row.
 * @param {Object} form
 * @param {string} form.firstName
 * @param {string} form.lastName
 * @param {string} form.email
 * @param {string} form.password
 * @param {string} [form.phone]
 */
export async function signUpUser({ firstName, lastName, email, password, phone }) {
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { first_name: firstName, last_name: lastName },
      emailRedirectTo: `${window.location.origin}/pages/login.html`,
    },
  });

  if (authError) {
    return { data: null, error: friendlyAuthError(authError) };
  }

  // signUp() can succeed with no error but no new identity when the
  // email is already registered (Supabase's confirm-email-safe behavior).
  const identities = authData.user?.identities ?? [];
  if (authData.user && identities.length === 0) {
    return { data: null, error: 'An account with this email already exists. Try logging in instead.' };
  }

  const newUserId = authData.user?.id;
  if (newUserId) {
    const { error: profileError } = await supabase.from('user_profiles').insert({
      id: newUserId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone: phone || null,
      account_status: 'Pending',
      email_verified: false,
    });

    if (profileError) {
      // The auth user now exists without a profile row — surface this
      // clearly so it can be retried or reconciled rather than silently lost.
      return {
        data: authData,
        error: `Account created, but your profile could not be saved: ${profileError.message}`,
      };
    }
  }

  return { data: authData, error: null };
}

/* -----------------------------------------------------------
   Login / logout
   ----------------------------------------------------------- */

export async function signInUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { data: null, error: friendlyAuthError(error) };
  }

  if (data.user) {
    await logLoginSession(data.user.id);
    await logAuditAction(data.user.id, 'User logged in');
  }

  return { data, error: null };
}

export async function signOutUser() {
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    await closeOpenLoginSession(user.id);
    await logAuditAction(user.id, 'User logged out');
  }

  const { error } = await supabase.auth.signOut();
  return { data: !error, error: error ? friendlyAuthError(error) : null };
}

/* -----------------------------------------------------------
   Session / user access
   ----------------------------------------------------------- */

export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  return { data: data?.session ?? null, error: error ? error.message : null };
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  return { data: data?.user ?? null, error: error ? error.message : null };
}

/**
 * Subscribes to auth state changes (sign in, sign out, token refresh).
 * Returns the subscription so the caller can unsubscribe if needed:
 *   const sub = onAuthStateChange((event, session) => {...});
 *   sub.unsubscribe();
 */
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return data.subscription;
}

/* -----------------------------------------------------------
   Route guards — call at the top of a page script
   ----------------------------------------------------------- */

/**
 * THE single, server-validated auth check for every protected page.
 * Use at the very top of a page's module script, before touching
 * any account data:
 *
 *   const user = await requireAuth();
 *   if (!user) return; // already redirected to login.html
 *
 * On success, also reveals the page (see revealPage() above) — so
 * for most pages that's the only auth-related call you need. If a
 * page's own init() also removes its hidden-state class/attribute
 * afterwards, that's harmless; this just makes it not strictly
 * required.
 *
 * Redirects to login.html if there's no active session, preserving
 * the current path as ?next= so login.html can send the visitor
 * back after signing in.
 */
export async function requireAuth() {
  const { data: session } = await getCurrentSession();
  if (!session) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${ROUTES.login}?next=${next}`;
    return null;
  }
  const { data: user } = await getCurrentUser();
  if (!user) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${ROUTES.login}?next=${next}`;
    return null;
  }
  revealPage();
  return user;
}

/**
 * Use on login.html / register.html so an already-logged-in
 * visitor is sent straight to their dashboard.
 */
export async function redirectIfAuthenticated() {
  const { data: session } = await getCurrentSession();
  if (session) {
    window.location.href = ROUTES.dashboard;
  }
}

/* -----------------------------------------------------------
   Password management
   ----------------------------------------------------------- */

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/pages/login.html`,
  });
  return { data: !error, error: error ? friendlyAuthError(error) : null };
}

export async function updateUserPassword(newPassword) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  return { data: data?.user ?? null, error: error ? friendlyAuthError(error) : null };
}

export async function resendVerificationEmail(email) {
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  return { data: !error, error: error ? friendlyAuthError(error) : null };
}

/**
 * Re-confirms the *currently signed-in* user's identity by testing
 * their password against Supabase Auth — used as a stand-in
 * confirmation step wherever a sensitive action (like sending a
 * transfer) needs an extra check but no OTP/2FA delivery exists
 * yet. See transfer.js's Verify step for the caller.
 *
 * Deliberately does NOT sign the user into a new session or touch
 * login_sessions/audit_logs — it re-validates the password of the
 * same session that's already active, it isn't a new login event.
 *
 * TODO: once the admin dashboard ships real OTP/2FA delivery,
 * swap the caller over to a dedicated code-verification endpoint
 * and retire this function (or keep it as a fallback method).
 */
export async function verifyCurrentPassword(password) {
  const { data: user, error: userError } = await getCurrentUser();
  if (userError || !user?.email) {
    return { data: false, error: 'Could not verify your session. Please log in again.' };
  }
  if (!password) {
    return { data: false, error: 'Enter your password to continue.' };
  }

  const { error } = await supabase.auth.signInWithPassword({ email: user.email, password });
  if (error) {
    return { data: false, error: friendlyAuthError(error) };
  }
  return { data: true, error: null };
}

/* -----------------------------------------------------------
   Session & audit logging (login_sessions / audit_logs)
   ----------------------------------------------------------- */

async function logLoginSession(userId) {
  const ctx = getClientContext();
  const { error } = await supabase.from('login_sessions').insert({
    user_id: userId,
    browser: ctx.browser,
    device: ctx.device,
    login_time: new Date().toISOString(),
  });
  if (error) console.error('[Meridian] Failed to log login session:', error.message);
}

async function closeOpenLoginSession(userId) {
  const { data: openSessions, error: fetchError } = await supabase
    .from('login_sessions')
    .select('id')
    .eq('user_id', userId)
    .is('logout_time', null)
    .order('login_time', { ascending: false })
    .limit(1);

  if (fetchError || !openSessions?.length) return;

  const { error: updateError } = await supabase
    .from('login_sessions')
    .update({ logout_time: new Date().toISOString() })
    .eq('id', openSessions[0].id);

  if (updateError) console.error('[Meridian] Failed to close login session:', updateError.message);
}

async function logAuditAction(userId, action) {
  const ctx = getClientContext();
  const { error } = await supabase.from('audit_logs').insert({
    user_id: userId,
    action,
    browser: ctx.browser,
    operating_system: ctx.operating_system,
    device: ctx.device,
  });
  if (error) console.error('[Meridian] Failed to write audit log:', error.message);
}


/**
 * Only 'suspended' and 'closed' block login outright — these are
 * the only two of admin_set_account_status()'s allow-listed values
 * (009_admin_policy_engine.sql) that plausibly mean "this person
 * should not be using the app at all." 'restricted' is deliberately
 * NOT blocked here — enforced instead via user_permissions' can_*
 * flags at the page level. 'Pending'/'rejected' are KYC states, not
 * lockouts. Flagging: this is a design choice, not confirmed
 * against a user_profiles CHECK constraint I haven't seen — revisit
 * if that constraint says otherwise.
 */
const LOGIN_BLOCKED_STATUSES = new Set(['suspended', 'closed']);

async function getBlockedStatusMessage(userId) {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('account_status')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile) return null; // fail open on a lookup error — don't lock someone out over a network blip
  if (!LOGIN_BLOCKED_STATUSES.has(profile.account_status)) return null;

  return profile.account_status === 'closed'
    ? 'This account has been closed. Contact support if you believe this is a mistake.'
    : 'This account has been suspended. Contact support for help.';
}
