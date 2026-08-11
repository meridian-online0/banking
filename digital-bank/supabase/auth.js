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

   CHANGE LOG (this revision)
   ---------------------------
   - Force logout / "Clear device list" (admin-policy.html) previously
     had no real client-side enforcement: user_profiles.force_logout_at
     was being set server-side, but nothing checked it, so an admin
     force-logging-out a customer had no visible effect until their
     token happened to expire naturally.
   - A first attempt at enforcing this compared
     user_profiles.force_logout_at against the most recent
     login_sessions.login_time row — this caused a redirect LOOP:
     those are two independently-written timestamps from two
     separate requests with no guaranteed ordering relative to each
     other, so a freshly logged-in user could still be judged
     "force logged out" and get bounced right back to login.
   - Fixed by comparing force_logout_at against the CURRENT SESSION
     TOKEN's own `iat` (issued-at) claim instead — decoded client-side
     via decodeJwtPayload() (unverified, fine for this UX check only;
     every real write is still gated server-side by is_admin()/RLS).
     A token's iat is fixed the instant that exact token was minted
     and never changes, so there's nothing left to race.
   - signInUser() now also clears force_logout_at back to NULL on a
     successful password sign-in — a fresh login is itself proof the
     force-logout has been "served", so the flag resets automatically
     without needing an admin to undo it manually.
   - requestPasswordReset() / signUpUser()'s emailRedirectTo previously
     used window.location.origin alone, which only returns
     protocol+domain and silently drops any subpath the site is
     deployed under (this project lives under /banking/digital-bank/,
     not the domain root) — every emailed link 404'd. Added
     getSiteRoot(), which derives the full deployed root from the
     current page's own path (everything before "/pages/"), and both
     redirect URLs now use it instead of window.location.origin alone.
   - requireAuth() previously only checked "is there a session" —
     it never looked at user_profiles.account_status, so a
     suspended or closed customer could still log in and use the
     app normally. Added getBlockedStatusMessage() + the
     LOGIN_BLOCKED_STATUSES set and wired it into requireAuth():
     a session belonging to a 'suspended' or 'closed' account is
     now signed out immediately and redirected to login.html with
     a ?blocked= message, instead of being let through.
       - Only 'suspended' and 'closed' block login outright — these
         are two of the values admin_set_account_status() actually
         allow-lists (009_admin_policy_engine.sql). 'restricted' is
         deliberately NOT blocked here — that's meant to be enforced
         at the page/feature level via user_permissions' can_* flags
         instead of a full lockout. 'Pending' / 'rejected' are KYC
         states, not lockouts, so they're left alone too.
       - This is a design choice, not something confirmed against a
         user_profiles CHECK constraint (that migration hasn't been
         provided yet) — revisit LOGIN_BLOCKED_STATUSES if that
         constraint turns out to define a different set of values.
       - On a lookup error (network blip, etc.) this fails OPEN —
         it does not block login — so a transient DB error can't
         accidentally lock a legitimate customer out.
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

/**
 * window.location.origin only ever gives protocol + domain
 * (e.g. "https://meridian-online0.github.io") — it drops any
 * subpath the site is actually deployed under (this project is
 * served from /banking/digital-bank/, not the domain root). Every
 * redirectTo/emailRedirectTo below needs the FULL site root, not
 * just the origin, or Supabase's emailed links 404.
 *
 * Derived from the current page's own path rather than hardcoded,
 * so it keeps working if the deployed subpath ever changes: every
 * page in this app lives under /pages/, so whatever comes before
 * that segment in the current URL IS the site root.
 */
function getSiteRoot() {
  const path = window.location.pathname; // e.g. /banking/digital-bank/pages/login.html
  const marker = '/pages/';
  const idx = path.indexOf(marker);
  const basePath = idx !== -1 ? path.slice(0, idx) : '';
  return `${window.location.origin}${basePath}`;
}

/**
 * Decodes a JWT's payload without verifying the signature — safe
 * here because we're only reading our OWN token's iat claim for a
 * client-side UX check, not trusting it for anything security-
 * critical (RLS + is_admin() still gate every real write server-side).
 */
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

/**
 * Statuses that mean "do not let this person into the app at all" —
 * see the CHANGE LOG note at the top of this file for why only
 * these two are included here, and not 'restricted'.
 */
const LOGIN_BLOCKED_STATUSES = new Set(['suspended', 'closed']);

/**
 * Looks up the given user's account_status and returns a friendly
 * message if it's one of LOGIN_BLOCKED_STATUSES, or null if the
 * user is fine to proceed (including on a lookup error — this
 * fails OPEN, it never blocks login just because the status check
 * itself failed).
 */
async function getBlockedStatusMessage(userId) {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('account_status')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile) return null;
  if (!LOGIN_BLOCKED_STATUSES.has(profile.account_status)) return null;

  return profile.account_status === 'closed'
    ? 'This account has been closed. Contact support if you believe this is a mistake.'
    : 'This account has been suspended. Contact support for help.';
}

/**
 * Checks whether an admin force-logged this user out more recently
 * than the CURRENT SESSION TOKEN was issued — using the JWT's own
 * `iat` claim, not a second table's timestamp. This is what avoids
 * a redirect loop: login_sessions.login_time and force_logout_at
 * are two independently-written rows with no guaranteed ordering
 * relative to each other. A token's iat is fixed at the moment
 * that exact token was minted and never changes, so there's
 * nothing left to race.
 */
async function isForceLoggedOut(userId, session) {
  const payload = session?.access_token ? decodeJwtPayload(session.access_token) : null;
  if (!payload?.iat) return false;

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('force_logout_at')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile?.force_logout_at) return false;

  const tokenIssuedAt = payload.iat * 1000; // JWT iat is seconds, not ms
  return tokenIssuedAt < new Date(profile.force_logout_at).getTime();
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
      emailRedirectTo: `${getSiteRoot()}/pages/${ROUTES.login}`,
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
    // A successful password sign-in is itself proof any earlier
    // force-logout has been "served" — clear it here so the next
    // requireAuth() check on this fresh session never has a reason
    // to bounce the user straight back to login.
    await supabase.from('user_profiles').update({ force_logout_at: null }).eq('id', data.user.id);
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
 *
 * ALSO checks the user's account_status once a session is confirmed
 * (see getBlockedStatusMessage() above) — a 'suspended' or 'closed'
 * account is signed out on the spot and sent to login.html with a
 * ?blocked= message instead of being allowed to use the app.
 *
 * ALSO checks whether an admin has force-logged this user out more
 * recently than the current session token was issued (see
 * isForceLoggedOut() above) — if so, the session is closed and the
 * visitor is sent to login.html with a ?blocked= message, same as
 * the account_status case.
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

  const blockedMessage = await getBlockedStatusMessage(user.id);
  if (blockedMessage) {
    await closeOpenLoginSession(user.id);
    await supabase.auth.signOut();
    window.location.href = `${ROUTES.login}?blocked=${encodeURIComponent(blockedMessage)}`;
    return null;
  }

  const forcedOut = await isForceLoggedOut(user.id, session);
  if (forcedOut) {
    await closeOpenLoginSession(user.id);
    await supabase.auth.signOut();
    window.location.href = `${ROUTES.login}?blocked=${encodeURIComponent('You have been signed out by an administrator. Please log in again.')}`;
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
    redirectTo: `${getSiteRoot()}/pages/${ROUTES.resetPassword}`,
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
