/* =============================================================
   MERIDIAN — International Digital Banking
   Auth UI: assets/js/auth-ui.js

   Bridges supabase/auth.js to the DOM. This module doesn't talk to
   Supabase directly — it imports the wrapped functions from
   supabase/auth.js (and, for the profile row, supabase/database.js)
   and uses them to:

     1. Guard app pages (dashboard, accounts, transfer, transactions,
        profile, settings) — bounce to login.html if there's no session.
     2. Bounce an already-logged-in visitor away from login/register.
     3. Populate the header's user menu (name, avatar/initials) from
        the real session + profile row, instead of hard-coded markup.
     4. Wire up every "Log out" control so it actually signs out.
     5. Open/close the user menu dropdown itself (.app-user-trigger →
        .app-user-dropdown) — see wireUserMenuToggle() below.

   AVATAR DISPLAY
   ---------------
   Whether a user has uploaded a profile picture (user_profiles.avatar_url)
   is resolved HERE, once, and applied to every .avatar-initial element
   across the header/dropdown — not decided per-page. If avatar_url is
   set, it's rendered as an <img>; otherwise the existing initials
   fallback is used, and a broken/expired image URL falls back to
   initials automatically (see renderAvatar()). This is the single
   place that logic lives — profile.html's own avatar upload flow
   should just write to user_profiles.avatar_url and let this module
   pick it up on the next page load, rather than each page rendering
   the avatar itself.

   Import path to supabase/auth.js and supabase/database.js is
   resolved at runtime with a dynamic import() (see SUPABASE_BASE
   below) so this single file works unmodified whether it's loaded
   from index.html at the site root or from a page under /pages/.

   Usage — add to any page, after component markup exists:

     <script type="module" src="./assets/js/auth-ui.js"></script>
     <!-- or ../assets/js/auth-ui.js under /pages/ -->

   No explicit initAuthUI() call is needed on pages using
   components.js — the auto-init block at the bottom of this file
   listens for 'component:loaded' itself. Just adding the <script>
   tag is enough.
   ============================================================= */

import { $, $$, getInitials } from './utils.js';

/* -----------------------------------------------------------
   Fixed — resolves relative to auth-ui.js's own location
   (assets/js/), NOT the page that imports it. Dynamic import()
   specifiers always resolve against the importing module's URL,
   so this must not branch on window.location.pathname.
   ----------------------------------------------------------- */
const SUPABASE_BASE = '../../supabase/';

let authModulePromise = null;
function loadAuthModule() {
  if (!authModulePromise) {
    authModulePromise = import(`${SUPABASE_BASE}auth.js`);
  }
  return authModulePromise;
}

let dbModulePromise = null;
function loadDbModule() {
  if (!dbModulePromise) {
    dbModulePromise = import(`${SUPABASE_BASE}database.js`);
  }
  return dbModulePromise;
}

/* -----------------------------------------------------------
   Page classification
   ----------------------------------------------------------- */

/** Logged-in app pages all render <body class="app-body">. */
function isAppPage() {
  return document.body.classList.contains('app-body');
}

/** Pages a logged-in visitor shouldn't see again (they already have a session). */
function isGuestOnlyPage() {
  const file = window.location.pathname.split('/').pop();
  return file === 'login.html' || file === 'register.html';
}

/* -----------------------------------------------------------
   Header population
   ----------------------------------------------------------- */

/**
 * Fills in every element that displays the current user across the
 * header/dropdown — matches the markup already used in dashboard.html,
 * profile.html, settings.html, transactions.html, transfer.html:
 *   .app-user-name          → full name
 *   .app-user-menu .avatar-initial, .profile-avatar-wrap .avatar-initial → avatar photo or initials
 *   [data-user-email]       → email, where a page opts in
 *
 * `profile` is the user_profiles row (see getMyProfile() in
 * database.js) — may be null if the fetch failed, in which case
 * this falls back to auth's own user_metadata for name and shows
 * initials only (no avatar_url exists there).
 */
function populateUserChrome(user, profile) {
  const meta = user.user_metadata || {};
  const firstName = profile?.first_name || meta.first_name || '';
  const lastName = profile?.last_name || meta.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || user.email || 'Meridian customer';
  const initials = getInitials(fullName);
  const avatarUrl = profile?.avatar_url || null;

  $$('.app-user-name').forEach((el) => { el.textContent = fullName; });
  $$('.app-user-menu .avatar-initial, .profile-avatar-wrap .avatar-initial').forEach((el) => {
    renderAvatar(el, avatarUrl, initials);
  });
  $$('[data-user-email]').forEach((el) => { el.textContent = user.email; });
  $$('[data-user-first-name]').forEach((el) => { el.textContent = firstName; });
}

/**
 * Renders either the user's uploaded avatar photo or their initials
 * into a single .avatar-initial element — never both. Swaps rather
 * than assumes: a page whose avatar_url is stale/deleted (404 from
 * storage) falls back to initials automatically via the <img>'s
 * onerror, instead of showing a broken image icon in the header.
 */
function renderAvatar(el, avatarUrl, initials) {
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
      el.textContent = ''; // clear the initials text node before inserting the image
      el.appendChild(img);
    }
    el.classList.add('has-avatar-image');
  } else {
    if (existingImg) existingImg.remove();
    el.classList.remove('has-avatar-image');
    el.textContent = initials;
  }
}

/* -----------------------------------------------------------
   User menu open/close
   -----------------------------------------------------------
   This was the missing piece: nothing previously toggled
   .app-user-dropdown open or closed. Mirrors the same pattern used
   for the notification bell and the chat widget's options menu —
   toggle on trigger click, close on outside click or Escape, keep
   aria-expanded in sync for screen readers.
   ----------------------------------------------------------- */
function wireUserMenuToggle() {
  // There can be more than one ".app-user-menu" in the header (the
  // notification bell wrapper also uses that class) — scope to the
  // one that actually contains .app-user-trigger.
  const menus = $$('.app-user-menu').filter((wrap) => $('.app-user-trigger', wrap));

  menus.forEach((wrap) => {
    const trigger = $('.app-user-trigger', wrap);
    const dropdown = $('.app-user-dropdown', wrap);
    if (!trigger || !dropdown) return;

    const open = () => {
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      dropdown.hidden = false;
    };

    const close = () => {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      dropdown.hidden = true;
    };

    // Start closed regardless of markup default.
    close();

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      wrap.classList.contains('is-open') ? close() : open();
    });

    document.addEventListener('click', (event) => {
      if (wrap.classList.contains('is-open') && !wrap.contains(event.target)) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && wrap.classList.contains('is-open')) {
        close();
        trigger.focus();
      }
    });

    // Clicking any item inside should close the menu too (matches
    // how the notification dropdown and chat menu behave elsewhere).
    $$('a, button', dropdown).forEach((item) => {
      item.addEventListener('click', () => close());
    });
  });
}

/* -----------------------------------------------------------
   Logout wiring
   ----------------------------------------------------------- */

/**
 * Any link/button whose visible text is "Log out" (the dropdown item
 * used in dashboard.html, profile.html, settings.html, transactions.html,
 * transfer.html) or that carries [data-logout] gets intercepted so it
 * signs out through Supabase before navigating, instead of just linking
 * straight to index.html.
 */
function wireLogoutControls(signOutUser) {
  const candidates = $$('.app-user-dropdown a, [data-logout]').filter((el) => {
    if (el.hasAttribute('data-logout')) return true;
    return el.textContent.trim().toLowerCase() === 'log out';
  });

  candidates.forEach((el) => {
    el.addEventListener('click', async (event) => {
      event.preventDefault();
      el.setAttribute('aria-disabled', 'true');
      const target = el.getAttribute('href') || resolveHomeHref();
      const { error } = await signOutUser();
      if (error) {
        console.error('[Meridian] Sign out failed:', error);
      }
      window.location.href = target;
    });
  });
}

function resolveHomeHref() {
  return window.location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
}

function resolveLoginHref() {
  return window.location.pathname.includes('/pages/') ? 'login.html' : 'pages/login.html';
}

/* -----------------------------------------------------------
   Public entry point
   ----------------------------------------------------------- */

/**
 * Call once per page, after any header partial has been injected
 * (see components.js). Safe to call on every page — it figures out
 * what that page needs from its <body> class and filename.
 */
export async function initAuthUI() {
  const { getCurrentUser, requireAuth, redirectIfAuthenticated, signOutUser, onAuthStateChange } =
    await loadAuthModule();

  if (isGuestOnlyPage()) {
    await redirectIfAuthenticated();
    return; // nothing else to wire up on login/register
  }

  if (isAppPage()) {
    const user = await requireAuth(); // redirects to login.html internally if no session
    if (!user) return;

    const { getMyProfile } = await loadDbModule();
    const { data: profile, error: profileError } = await getMyProfile(user.id);
    if (profileError) {
      console.warn('[Meridian] Could not load profile for header:', profileError);
    }

    populateUserChrome(user, profile);
    wireUserMenuToggle();
    wireLogoutControls(signOutUser);

    // If the session ends elsewhere (another tab, token expiry), bounce here too.
    onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        window.location.href = resolveLoginHref();
      }
    });
    return;
  }

  // Public marketing pages (index.html): no guard needed, but if a session
  // exists, swap "Log in / Open an account" for a straight link to the
  // dashboard so a returning, already-signed-in visitor isn't asked to log in again.
  const { data: user } = await getCurrentUser();
  if (user) {
    $$('a[href$="login.html"], a[href$="register.html"]').forEach((el) => {
      el.textContent = 'Go to dashboard';
      el.setAttribute('href', 'pages/dashboard.html');
    });
  }
}

/* -----------------------------------------------------------
   Auto-init
   ----------------------------------------------------------- */
// If the page uses components.js to inject the header, initAuthUI runs
// after that markup exists. Otherwise it runs on DOMContentLoaded like
// any other page script. Both are safe to leave in place at once.
if (document.querySelector('[data-component]')) {
  document.addEventListener('component:loaded', initAuthUI, { once: true });
} else {
  document.addEventListener('DOMContentLoaded', initAuthUI, { once: true });
}
