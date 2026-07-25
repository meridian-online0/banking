/* =============================================================
   MERIDIAN — Admin panel
   assets/js/admin/admin-guard.js

   PURPOSE
   -------
   The role-aware equivalent of requireAuth() in supabase/auth.js,
   for pages under pages/admin/ instead of pages/.

   WHY THIS ISN'T JUST "call requireAuth()"
   -----------------------------------------
   requireAuth() redirects unauthenticated visitors to ROUTES.login,
   which is (per supabase/config.js's usage elsewhere) a bare
   relative string like 'login.html'. That resolves correctly from
   pages/*.html, one directory below the project root. Admin pages
   live at pages/admin/*.html — one directory deeper — so the same
   string would resolve to pages/admin/login.html, which doesn't
   exist, instead of pages/login.html.

   requireAuth() also has no concept of role — it only asks "is
   there a session", not "is this session allowed in the admin
   panel". A signed-in customer must not be able to reach any
   pages/admin/*.html page.

   Rather than adding a parameter to requireAuth() (which would
   ripple into every existing call site across the customer app for
   a concern only the admin panel has), this file is a parallel,
   admin-specific guard. It reuses the two low-level, non-redirecting
   primitives auth.js already exports — getCurrentSession() and
   getCurrentUser() — and owns its own redirect + role-check logic.
   supabase/auth.js remains the single source of truth for what a
   valid session IS; this file only adds "...and is that session
   allowed in here", the same layering as page-guard.js re-exporting
   requireAuth() rather than reimplementing it.

   If Meridian's auth model ever changes (session shape, MFA, token
   refresh), that still only needs to change in auth.js — this file
   never touches supabase.auth directly.

   USAGE
   -----   Import at the top of every pages/admin/*.js page script,
   before touching any admin data, EXCEPT admin-login.js itself:

     import { requireAdmin } from '../../assets/js/admin/admin-guard.js';

     const admin = await requireAdmin();
     if (!admin) return; // already redirected

   `admin` is { user, profile } — the Supabase auth user plus their
   user_profiles row (id, first_name, last_name, role, ...), since
   almost every admin page needs the role for permission-gated UI
   (see admin-layout.js) and most want the admin's display name for
   the topbar anyway. No second query needed on top of this one.

   PAGE MARKUP
   -----------
   Same hide-until-confirmed pattern as the customer app. Use the
   data-auth attribute form (matches settings.html):

     <body class="app-body admin-body" data-auth="pending">
       <div class="auth-loader" aria-hidden="true"><span class="auth-loader-mark"></span></div>
       ...

   requireAdmin() reveals the page on success, same as requireAuth().

   admin-login.html is the one admin page that must NOT import this
   file — it needs the opposite check (bounce an already-logged-in
   admin straight to the dashboard). See redirectIfAdminAuthenticated()
   at the bottom, the admin equivalent of redirectIfAuthenticated().
   ============================================================= */

import { getCurrentSession, getCurrentUser, onAuthStateChange } from '../../../supabase/auth.js';
import { supabase } from '../../../supabase/config.js';

/* -----------------------------------------------------------
   Paths — relative to pages/admin/*.html, NOT pages/*.html.
   Deliberately not reusing ROUTES from supabase/config.js: that
   object's paths are written for callers at pages/ depth, and
   silently reusing it here is exactly the kind of one-level-off
   redirect bug this file exists to avoid. If ROUTES ever grows
   admin-aware entries, point these at it explicitly instead of
   collapsing the two.
   ----------------------------------------------------------- */
const ADMIN_LOGIN_PATH = 'admin-login.html';
const ADMIN_DASHBOARD_PATH = 'admin-dashboard.html';

const ADMIN_ROLES = ['support', 'admin', 'superadmin'];

/* -----------------------------------------------------------
   Page reveal — same two patterns supabase/auth.js's internal
   revealPage() supports, duplicated here since that helper isn't
   exported. If auth.js ever exports revealPage() directly, replace
   this with an import instead of keeping a second copy in sync.
   ----------------------------------------------------------- */
function revealAdminPage() {
  if (typeof document === 'undefined' || !document.body) return;

  document.body.classList.remove('auth-pending');

  if (document.body.dataset.auth !== undefined) {
    document.body.dataset.auth = 'ready';
  }

  const loader = document.querySelector('.auth-loader');
  if (loader) loader.setAttribute('hidden', '');
}

function redirectToAdminLogin() {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `${ADMIN_LOGIN_PATH}?next=${next}`;
}

/* -----------------------------------------------------------
   Role lookup
   -----------------------------------------------------------
   Deliberately a direct table read, not a new supabase/*.js
   export — this file already talks to `supabase` for nothing else,
   and the RLS policy from admin_schema.sql
   (user_profiles_select_admin / the owner-scoped SELECT every user
   already has on their own row) means a signed-in user can always
   read their own profile regardless of role, so this never 403s
   for a legitimate customer landing here by mistake — it just
   correctly reports them as non-admin.
   ----------------------------------------------------------- */
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
   requireAdmin() — the guard every protected admin page calls
   ----------------------------------------------------------- */

/**
 * Confirms there's a real session AND that session's role is one
 * of ADMIN_ROLES. Redirects to admin-login.html (preserving
 * ?next=) if either check fails — a signed-in customer hitting an
 * admin page is treated identically to a signed-out visitor: sent
 * to admin-login.html, not shown an error page that confirms an
 * admin panel exists at this URL.
 *
 * @param {Object} [options]
 * @param {string[]} [options.roles] - override the allowed role
 *   list for pages that need a higher bar, e.g. admin-settings.html
 *   restricting role changes to superadmin only:
 *     await requireAdmin({ roles: ['superadmin'] });
 * @returns {Promise<{user: object, profile: object}|null>}
 */
export async function requireAdmin({ roles = ADMIN_ROLES } = {}) {
  const { data: session } = await getCurrentSession();
  if (!session) {
    redirectToAdminLogin();
    return null;
  }

  const { data: user } = await getCurrentUser();
  if (!user) {
    redirectToAdminLogin();
    return null;
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(user.id);
  if (profileError || !profile || !roles.includes(profile.role)) {
    // Not an admin (or not the required tier) — same redirect as
    // "not signed in at all". No distinct "forbidden" page: don't
    // give a curious customer a signal that they were *close*.
    redirectToAdminLogin();
    return null;
  }

  revealAdminPage();

  // If the session ends elsewhere (another tab, token expiry,
  // superadmin revokes this admin's role mid-session), bounce here
  // too rather than leaving a stale admin session rendered.
  onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      redirectToAdminLogin();
    }
  });

  return { user, profile };
}

/**
 * Use on admin-login.html so an already-signed-in admin is sent
 * straight to admin-dashboard.html instead of seeing the login form
 * again. Mirrors redirectIfAuthenticated() from supabase/auth.js.
 *
 * Deliberately does NOT redirect a signed-in *customer* anywhere —
 * someone with a valid customer session but no admin role should
 * still see the admin login form (and then correctly fail role
 * check if they try to sign in with it), not get bounced in a
 * confusing loop.
 */
export async function redirectIfAdminAuthenticated() {
  const { data: session } = await getCurrentSession();
  if (!session) return;

  const { data: user } = await getCurrentUser();
  if (!user) return;

  const { data: profile } = await fetchOwnProfile(user.id);
  if (profile && ADMIN_ROLES.includes(profile.role)) {
    window.location.href = ADMIN_DASHBOARD_PATH;
  }
}

/**
 * Convenience export for permission-gated UI (admin-layout.js and
 * individual page scripts) — e.g. hiding a "Reverse transaction"
 * button for a support-tier admin without a second network call:
 *
 *   import { canAccess } from './admin-guard.js';
 *   if (!canAccess(admin.profile, ['admin', 'superadmin'])) btn.remove();
 *
 * This is UX politeness only, same as the RLS/RPC role checks are
 * the real enforcement — see admin_freeze_account() etc. in
 * admin_schema.sql, which check public.is_admin()/is_superadmin()
 * themselves regardless of what the client renders.
 */
export function canAccess(profile, roles) {
  return Boolean(profile && roles.includes(profile.role));
}
