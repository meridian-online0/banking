/* =============================================================
   MERIDIAN — International Digital Banking
   Authentication module: supabase/auth.js

   Central authentication module for the application.

   Responsibilities:
   - Registration
   - Login
   - Logout
   - Current session/user lookup
   - Protected-page authentication
   - Account-status blocking
   - Administrator force logout
   - Password reset
   - Password verification
   - Login-session logging
   - Audit logging

   IMPORTANT:
   requireAuth() is the single client-side authentication guard
   for protected pages.

   Force logout:
   - Admin sets user_profiles.force_logout_at
   - Existing customer pages detect the flag
   - Customer is signed out locally
   - Customer is redirected to login
   - Successful new password login clears force_logout_at

   The force-logout mechanism intentionally does NOT compare
   force_logout_at against a JWT iat claim. Supabase access tokens
   can be refreshed, so JWT iat is not a reliable application-level
   session revocation mechanism.

   NOTE:
   Client-side force logout is primarily a UX/session mechanism.
   Sensitive banking operations should also be protected by
   server-side/RLS authorization rules.
   ============================================================= */

import { supabase, ROUTES } from './config.js';

/* -----------------------------------------------------------
   Helpers
   ----------------------------------------------------------- */

/**
 * Very small user-agent reader — good enough for audit/session
 * logging, not intended to be a full device-detection system.
 */
function getClientContext() {
  const ua = navigator.userAgent || '';

  let browser = 'Unknown';

  if (ua.includes('Edg/')) {
    browser = 'Edge';
  } else if (ua.includes('Chrome/') && !ua.includes('Chromium')) {
    browser = 'Chrome';
  } else if (ua.includes('Firefox/')) {
    browser = 'Firefox';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    browser = 'Safari';
  }

  let os = 'Unknown';

  if (ua.includes('Windows')) {
    os = 'Windows';
  } else if (ua.includes('Mac OS')) {
    os = 'macOS';
  } else if (ua.includes('Android')) {
    os = 'Android';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    os = 'iOS';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  }

  const device =
    /Mobi|Android|iPhone|iPad/.test(ua)
      ? 'Mobile'
      : 'Desktop';

  return {
    browser,
    operating_system: os,
    device,
    user_agent: ua
  };
}

/**
 * Converts common Supabase Auth errors into friendlier messages.
 */
function friendlyAuthError(error) {
  if (!error) return null;

  const message =
    error.message ||
    'Something went wrong. Please try again.';

  const lower = message.toLowerCase();

  if (lower.includes('invalid login credentials')) {
    return 'That email and password combination doesn’t match our records.';
  }

  if (lower.includes('email not confirmed')) {
    return 'Please verify your email address before logging in.';
  }

  if (lower.includes('user already registered')) {
    return 'An account with this email already exists. Try logging in instead.';
  }

  if (lower.includes('password should be at least')) {
    return 'Your password needs to be at least 8 characters long.';
  }

  return message;
}

/**
 * Reveals a page that was hidden while authentication was
 * being confirmed.
 */
function revealPage() {
  if (
    typeof document === 'undefined' ||
    !document.body
  ) {
    return;
  }

  document.body.classList.remove('auth-pending');

  if (document.body.dataset.auth !== undefined) {
    document.body.dataset.auth = 'ready';
  }

  const loader =
    document.querySelector('.auth-loader');

  if (loader) {
    loader.setAttribute('hidden', '');
  }
}

/**
 * Returns the deployed site root.
 *
 * Example:
 * /banking/digital-bank/pages/login.html
 *
 * becomes:
 * https://example.com/banking/digital-bank
 *
 * This prevents password-reset and email-confirmation links
 * from accidentally dropping the deployment subpath.
 */
function getSiteRoot() {
  const path = window.location.pathname;
  const marker = '/pages/';
  const idx = path.indexOf(marker);

  const basePath =
    idx !== -1
      ? path.slice(0, idx)
      : '';

  return `${window.location.origin}${basePath}`;
}

/* -----------------------------------------------------------
   Account status
   ----------------------------------------------------------- */

/**
 * Account statuses that prevent access to the application.
 *
 * "restricted" is deliberately not included here because it
 * should be handled through permissions/features rather than
 * completely blocking authentication.
 */
const LOGIN_BLOCKED_STATUSES = new Set([
  'suspended',
  'closed'
]);

/**
 * Returns a friendly message if the user's account is blocked.
 *
 * Lookup errors fail open so a temporary database/network problem
 * does not accidentally lock a legitimate user out.
 */
async function getBlockedStatusMessage(userId) {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('account_status')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile) {
    return null;
  }

  if (
    !LOGIN_BLOCKED_STATUSES.has(
      String(profile.account_status || '').toLowerCase()
    )
  ) {
    return null;
  }

  const status =
    String(profile.account_status || '').toLowerCase();

  if (status === 'closed') {
    return 'This account has been closed. Contact support if you believe this is a mistake.';
  }

  return 'This account has been suspended. Contact support for help.';
}

/* -----------------------------------------------------------
   Force logout
   ----------------------------------------------------------- */

/**
 * Checks whether an administrator has marked this user for
 * force logout.
 *
 * We intentionally do NOT compare force_logout_at with JWT iat.
 *
 * force_logout_at simply means:
 *
 *     "This currently active session must be terminated."
 *
 * After a successful new login, signInUser() clears the flag.
 */
async function isForceLoggedOut(userId) {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('force_logout_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error(
      '[Meridian] Failed to check force logout:',
      error.message
    );

    // Fail open on temporary database errors.
    return false;
  }

  return Boolean(profile?.force_logout_at);
}

/**
 * Redirects the current user to the login page after an
 * administrator force logout.
 */
async function handleForceLogout(userId) {
  try {
    await closeOpenLoginSession(userId);
  } catch (error) {
    console.error(
      '[Meridian] Failed to close forced logout session:',
      error
    );
  }

  try {
    await supabase.auth.signOut({
      scope: 'local'
    });
  } catch (error) {
    console.error(
      '[Meridian] Failed to sign out forced user:',
      error
    );
  }

  const message =
    'You have been signed out by an administrator. Please log in again.';

  window.location.href =
    `${ROUTES.login}?blocked=${encodeURIComponent(message)}`;
}

/**
 * Background force-logout watcher.
 *
 * This solves the main problem with the previous implementation:
 *
 * If the customer is already sitting on dashboard.html when an
 * admin clicks Force Logout, requireAuth() does not automatically
 * run again.
 *
 * We therefore check the database periodically while the user is
 * on an authenticated page.
 *
 * The default interval is 5 seconds.
 */

let forceLogoutWatcher = null;

export function startForceLogoutWatcher(userId) {
  if (!userId) {
    return;
  }

  // Prevent multiple watchers on the same page.
  if (forceLogoutWatcher) {
    clearInterval(forceLogoutWatcher);
    forceLogoutWatcher = null;
  }

  let checking = false;

  const checkForceLogout = async () => {
    // Prevent overlapping requests if a request takes longer
    // than expected.
    if (checking) {
      return;
    }

    checking = true;

    try {
      const forcedOut =
        await isForceLoggedOut(userId);

      if (forcedOut) {
        clearInterval(forceLogoutWatcher);
        forceLogoutWatcher = null;

        console.log(
          '[Meridian] Administrator force logout detected.'
        );

        await handleForceLogout(userId);
      }
    } catch (error) {
      console.error(
        '[Meridian] Force logout watcher error:',
        error
      );
    } finally {
      checking = false;
    }
  };

  // Check immediately.
  checkForceLogout();

  // Continue checking while the page is open.
  forceLogoutWatcher = setInterval(
    checkForceLogout,
    5000
  );
}

/**
 * Stops the force logout watcher.
 *
 * This is optional for most pages because navigation destroys
 * the page anyway, but it is useful for single-page sections.
 */
export function stopForceLogoutWatcher() {
  if (forceLogoutWatcher) {
    clearInterval(forceLogoutWatcher);
    forceLogoutWatcher = null;
  }
}

/* -----------------------------------------------------------
   Registration
   ----------------------------------------------------------- */

/**
 * Creates an Auth user and matching user_profiles row.
 *
 * @param {Object} form
 * @param {string} form.firstName
 * @param {string} form.lastName
 * @param {string} form.email
 * @param {string} form.password
 * @param {string} [form.phone]
 */
export async function signUpUser({
  firstName,
  lastName,
  email,
  password,
  phone
}) {
  const { data: authData, error: authError } =
    await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName
        },

        emailRedirectTo:
          `${getSiteRoot()}/pages/${ROUTES.login}`
      }
    });

  if (authError) {
    return {
      data: null,
      error: friendlyAuthError(authError)
    };
  }

  /*
   * Supabase can return a successful signUp response with no
   * identity when the email already exists.
   */
  const identities =
    authData.user?.identities ?? [];

  if (
    authData.user &&
    identities.length === 0
  ) {
    return {
      data: null,
      error:
        'An account with this email already exists. Try logging in instead.'
    };
  }

  const newUserId =
    authData.user?.id;

  if (newUserId) {
    const { error: profileError } =
      await supabase
        .from('user_profiles')
        .insert({
          id: newUserId,
          first_name: firstName,
          last_name: lastName,
          email,
          phone: phone || null,
          account_status: 'Pending',
          email_verified: false,
          force_logout_at: null
        });

    if (profileError) {
      return {
        data: authData,
        error:
          `Account created, but your profile could not be saved: ${profileError.message}`
      };
    }
  }

  return {
    data: authData,
    error: null
  };
}

/* -----------------------------------------------------------
   Login / logout
   ----------------------------------------------------------- */

/**
 * Signs a user in with email/password.
 *
 * IMPORTANT:
 * A successful new login clears force_logout_at.
 *
 * This allows an administrator to force someone out of their
 * existing session without permanently preventing them from
 * logging in again.
 */
export async function signInUser(
  email,
  password
) {
  const { data, error } =
    await supabase.auth.signInWithPassword({
      email,
      password
    });

  if (error) {
    return {
      data: null,
      error: friendlyAuthError(error)
    };
  }

  if (data.user) {
    /*
     * Clear any previous force-logout marker.
     *
     * If this update fails because of RLS, the user may be
     * immediately forced out again by requireAuth()/the watcher.
     * In that case, fix the user_profiles UPDATE policy.
     */
    const { error: clearForceLogoutError } =
      await supabase
        .from('user_profiles')
        .update({
          force_logout_at: null
        })
        .eq('id', data.user.id);

    if (clearForceLogoutError) {
      console.error(
        '[Meridian] Failed to clear force logout:',
        clearForceLogoutError.message
      );
    }

    await logLoginSession(data.user.id);

    await logAuditAction(
      data.user.id,
      'User logged in'
    );
  }

  return {
    data,
    error: null
  };
}

/**
 * Signs out the current browser/session.
 */
export async function signOutUser() {
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    await closeOpenLoginSession(user.id);

    await logAuditAction(
      user.id,
      'User logged out'
    );
  }

  stopForceLogoutWatcher();

  const { error } =
    await supabase.auth.signOut({
      scope: 'local'
    });

  return {
    data: !error,
    error:
      error
        ? friendlyAuthError(error)
        : null
  };
}

/* -----------------------------------------------------------
   Session / user access
   ----------------------------------------------------------- */

/**
 * Gets the current Supabase session.
 */
export async function getCurrentSession() {
  const { data, error } =
    await supabase.auth.getSession();

  return {
    data: data?.session ?? null,
    error: error
      ? error.message
      : null
  };
}

/**
 * Gets the current authenticated user.
 */
export async function getCurrentUser() {
  const { data, error } =
    await supabase.auth.getUser();

  return {
    data: data?.user ?? null,
    error: error
      ? error.message
      : null
  };
}

/**
 * Subscribes to Supabase Auth state changes.
 */
export function onAuthStateChange(callback) {
  const { data } =
    supabase.auth.onAuthStateChange(
      callback
    );

  return data.subscription;
}

/* -----------------------------------------------------------
   Route guards
   ----------------------------------------------------------- */

/**
 * THE single client-side authentication check for protected
 * pages.
 *
 * Checks:
 *
 * 1. Does a session exist?
 * 2. Does the authenticated user exist?
 * 3. Is the account suspended/closed?
 * 4. Has an administrator force-logged the user out?
 *
 * If everything is valid:
 * - Starts the force logout watcher
 * - Reveals the page
 * - Returns the authenticated user
 */
export async function requireAuth() {
  const { data: session } =
    await getCurrentSession();

  if (!session) {
    const next =
      encodeURIComponent(
        window.location.pathname +
        window.location.search
      );

    window.location.href =
      `${ROUTES.login}?next=${next}`;

    return null;
  }

  const { data: user } =
    await getCurrentUser();

  if (!user) {
    const next =
      encodeURIComponent(
        window.location.pathname +
        window.location.search
      );

    window.location.href =
      `${ROUTES.login}?next=${next}`;

    return null;
  }

  /*
   * Check account status.
   */
  const blockedMessage =
    await getBlockedStatusMessage(
      user.id
    );

  if (blockedMessage) {
    await closeOpenLoginSession(
      user.id
    );

    await supabase.auth.signOut({
      scope: 'local'
    });

    window.location.href =
      `${ROUTES.login}?blocked=${encodeURIComponent(
        blockedMessage
      )}`;

    return null;
  }

  /*
   * Check administrator force logout.
   */
  const forcedOut =
    await isForceLoggedOut(user.id);

  if (forcedOut) {
    await handleForceLogout(user.id);
    return null;
  }

  /*
   * Keep monitoring the session while the user
   * remains on the authenticated page.
   */
  startForceLogoutWatcher(user.id);

  revealPage();

  return user;
}

/**
 * Used on login/register pages.
 *
 * If the visitor already has a session, send them to dashboard.
 */
export async function redirectIfAuthenticated() {
  const { data: session } =
    await getCurrentSession();

  if (session) {
    window.location.href =
      ROUTES.dashboard;
  }
}

/* -----------------------------------------------------------
   Password management
   ----------------------------------------------------------- */

/**
 * Requests a password-reset email.
 */
export async function requestPasswordReset(email) {
  const { error } =
    await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo:
          `${getSiteRoot()}/pages/${ROUTES.resetPassword}`
      }
    );

  return {
    data: !error,
    error:
      error
        ? friendlyAuthError(error)
        : null
  };
}

/**
 * Updates the currently authenticated user's password.
 */
export async function updateUserPassword(
  newPassword
) {
  const { data, error } =
    await supabase.auth.updateUser({
      password: newPassword
    });

  return {
    data: data?.user ?? null,
    error:
      error
        ? friendlyAuthError(error)
        : null
  };
}

/**
 * Resends signup verification email.
 */
export async function resendVerificationEmail(
  email
) {
  const { error } =
    await supabase.auth.resend({
      type: 'signup',
      email
    });

  return {
    data: !error,
    error:
      error
        ? friendlyAuthError(error)
        : null
  };
}

/**
 * Re-confirms the currently signed-in user's password.
 *
 * This does not create a separate application login event.
 */
export async function verifyCurrentPassword(
  password
) {
  const {
    data: user,
    error: userError
  } = await getCurrentUser();

  if (
    userError ||
    !user?.email
  ) {
    return {
      data: false,
      error:
        'Could not verify your session. Please log in again.'
    };
  }

  if (!password) {
    return {
      data: false,
      error:
        'Enter your password to continue.'
    };
  }

  const { error } =
    await supabase.auth.signInWithPassword({
      email: user.email,
      password
    });

  if (error) {
    return {
      data: false,
      error: friendlyAuthError(error)
    };
  }

  return {
    data: true,
    error: null
  };
}

/* -----------------------------------------------------------
   Session & audit logging
   ----------------------------------------------------------- */

/**
 * Records a new login session.
 */
async function logLoginSession(userId) {
  const ctx =
    getClientContext();

  const { error } =
    await supabase
      .from('login_sessions')
      .insert({
        user_id: userId,
        browser: ctx.browser,
        device: ctx.device,
        login_time:
          new Date().toISOString()
      });

  if (error) {
    console.error(
      '[Meridian] Failed to log login session:',
      error.message
    );
  }
}

/**
 * Closes the most recent open login session.
 */
async function closeOpenLoginSession(
  userId
) {
  const {
    data: openSessions,
    error: fetchError
  } = await supabase
    .from('login_sessions')
    .select('id')
    .eq('user_id', userId)
    .is('logout_time', null)
    .order('login_time', {
      ascending: false
    })
    .limit(1);

  if (
    fetchError ||
    !openSessions?.length
  ) {
    return;
  }

  const {
    error: updateError
  } = await supabase
    .from('login_sessions')
    .update({
      logout_time:
        new Date().toISOString()
    })
    .eq(
      'id',
      openSessions[0].id
    );

  if (updateError) {
    console.error(
      '[Meridian] Failed to close login session:',
      updateError.message
    );
  }
}

/**
 * Writes an audit log entry.
 */
async function logAuditAction(
  userId,
  action
) {
  const ctx =
    getClientContext();

  const { error } =
    await supabase
      .from('audit_logs')
      .insert({
        user_id: userId,
        action,
        browser: ctx.browser,
        operating_system:
          ctx.operating_system,
        device: ctx.device
      });

  if (error) {
    console.error(
      '[Meridian] Failed to write audit log:',
      error.message
    );
  }
}
