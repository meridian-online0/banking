/* =============================================================
   MERIDIAN — Admin panel
   assets/js/admin/admin-layout.js

   PURPOSE
   -------
   The admin equivalent of components.js + auth-ui.js's chrome
   population, combined into one module because the admin panel
   only has one shared layout partial (components/admin-navbar.html)
   rather than several — no separate marketing header/footer case
   to handle here.

   WHY NOT JUST REUSE components.js's loadComponents()?
   ------------------------------------------------------
   components.js resolves its partials directory with:

     const inPagesDir = path.includes('/pages/');
     return inPagesDir ? '../components/' : 'components/';

   That check only accounts for ONE level of nesting. Admin pages
   live at pages/admin/*.html, which still contains '/pages/' in
   its path — so inPagesDir is true there too, and loadComponents()
   would resolve to '../components/', landing on pages/components/
   (doesn't exist) instead of the real components/ at the project
   root, two levels up. This is the exact same class of bug
   admin-guard.js exists to avoid for the login redirect, just in
   the component loader instead of the auth check. So: a small,
   separate injector here, hardcoded for pages/admin/ depth, rather
   than patching components.js's path logic to handle a third
   directory depth it doesn't otherwise need.

   USAGE
   -----
   Call after requireAdmin() has resolved, passing its result
   straight through — this avoids a second user_profiles query for
   the identity block, since requireAdmin() already fetched it:

     import { requireAdmin } from './admin-guard.js';
     import { initAdminLayout } from './admin-layout.js';

     const admin = await requireAdmin();
     if (!admin) return;
     await initAdminLayout(admin, { pageTitle: 'Dashboard' });

   Expects the page body to contain:

     <div data-component="admin-navbar"></div>

   somewhere before the page's own <main> content — same placeholder
   convention as components.js.
   ============================================================= */

import { signOutUser } from '../../../supabase/auth.js';
import { canAccess } from './admin-guard.js';

const ADMIN_NAVBAR_PARTIAL_PATH = '../../components/admin-navbar.html';
const ADMIN_LOGIN_PATH = 'admin-login.html';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

/* -----------------------------------------------------------
   1. Inject the partial
   ----------------------------------------------------------- */
async function injectAdminNavbar() {
  const placeholder = $('[data-component="admin-navbar"]');
  if (!placeholder) {
    console.warn('[Meridian Admin] No [data-component="admin-navbar"] placeholder on this page — layout not injected.');
    return false;
  }

  try {
    const response = await fetch(ADMIN_NAVBAR_PARTIAL_PATH);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();

    const fragment = document.createDocumentFragment();
    Array.from(wrapper.childNodes).forEach((node) => fragment.appendChild(node));
    placeholder.replaceWith(fragment);
    return true;
  } catch (err) {
    console.warn('[Meridian Admin] Failed to load admin-navbar partial:', err.message);
    return false;
  }
}

/* -----------------------------------------------------------
   2. Active nav link
   ----------------------------------------------------------- */
function markActiveAdminNavLink() {
  const currentFile = window.location.pathname.split('/').pop() || 'admin-dashboard.html';
  $$('.admin-nav a[data-nav]').forEach((link) => {
    const isActive = link.dataset.nav === currentFile;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/* -----------------------------------------------------------
   3. Role-gated nav — UX politeness only. A support-tier admin
   simply never sees the Settings link rendered; the underlying
   page (and its RPCs) enforce the real check independently, same
   as point 4's "permission-gated UI" requirement. A support admin
   who types the URL directly still gets correctly bounced by that
   page's own requireAdmin({ roles: [...] }) call, not by anything
   here — this function only ever hides, never is the enforcement.
   ----------------------------------------------------------- */
function applyRoleGatedNav(profile) {
  $$('.admin-nav a[data-min-role]').forEach((link) => {
    const minRole = link.dataset.minRole;
    if (!canAccess(profile, roleAndAbove(minRole))) {
      link.remove();
    }
  });
}

// 'admin' should also match 'superadmin' (a superadmin can do
// everything an admin can); 'support' matches all three tiers.
function roleAndAbove(minRole) {
  const order = ['support', 'admin', 'superadmin'];
  const idx = order.indexOf(minRole);
  return idx === -1 ? order : order.slice(idx);
}

/* -----------------------------------------------------------
   4. Identity block — populated from the profile requireAdmin()
   already fetched, no extra query.
   ----------------------------------------------------------- */
function populateAdminIdentity({ profile }) {
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email || 'Admin';
  const initials = fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

  const ROLE_LABELS = { support: 'Support', admin: 'Admin', superadmin: 'Superadmin' };

  $$('[data-admin-name]').forEach((el) => { el.textContent = fullName; });
  $$('[data-admin-avatar]').forEach((el) => { el.textContent = initials || '·'; });
  $$('[data-admin-role]').forEach((el) => { el.textContent = ROLE_LABELS[profile.role] || profile.role; });
}

/* -----------------------------------------------------------
   5. Page title — each page passes its own via initAdminLayout()'s
   options rather than this file guessing from the filename, since
   "KYC queue" reads better than a title-cased "Admin Kyc".
   ----------------------------------------------------------- */
function setPageTitle(pageTitle) {
  if (!pageTitle) return;
  $$('[data-admin-page-title]').forEach((el) => { el.textContent = pageTitle; });
}

/* -----------------------------------------------------------
   6. User menu open/close — same behavior as auth-ui.js's
   wireUserMenuToggle(), duplicated rather than imported because
   auth-ui.js's version is written for the customer chrome's
   possible multiple .app-user-menu instances (bell + account); the
   admin topbar only ever has the one.
   ----------------------------------------------------------- */
function wireAdminUserMenu() {
  const wrap = $('.admin-user-menu');
  if (!wrap) return;
  const trigger = $('.app-user-trigger', wrap);
  const dropdown = $('.app-user-dropdown', wrap);
  if (!trigger || !dropdown) return;

  const open = () => {
    wrap.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    wrap.classList.contains('is-open') ? close() : open();
  });
  document.addEventListener('click', (event) => {
    if (wrap.classList.contains('is-open') && !wrap.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && wrap.classList.contains('is-open')) {
      close();
      trigger.focus();
    }
  });
}

/* -----------------------------------------------------------
   7. Mobile sidebar toggle
   ----------------------------------------------------------- */
function wireMobileSidebarToggle() {
  const toggle = $('[data-admin-nav-toggle]');
  const sidebar = $('[data-admin-sidebar]');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  document.addEventListener('click', (event) => {
    if (!sidebar.classList.contains('is-open')) return;
    if (!sidebar.contains(event.target) && !toggle.contains(event.target)) {
      sidebar.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

/* -----------------------------------------------------------
   8. Logout — goes through the same signOutUser() as the customer
   app (it doesn't distinguish admin/customer sessions, just ends
   the Supabase session), then sends the admin to admin-login.html
   specifically rather than the customer index.html.
   ----------------------------------------------------------- */
function wireAdminLogout() {
  $$('[data-admin-logout]').forEach((link) => {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      link.setAttribute('aria-disabled', 'true');
      const { error } = await signOutUser();
      if (error) console.error('[Meridian Admin] Sign out failed:', error);
      window.location.href = ADMIN_LOGIN_PATH;
    });
  });
}

/* -----------------------------------------------------------
   Public entry point
   ----------------------------------------------------------- */

/**
 * @param {{user: object, profile: object}} admin - the object
 *   returned by requireAdmin() — passed straight through so this
 *   file never re-fetches the profile.
 * @param {Object} [options]
 * @param {string} [options.pageTitle] - shown in the topbar, e.g. 'KYC queue'
 */
export async function initAdminLayout(admin, { pageTitle } = {}) {
  const injected = await injectAdminNavbar();
  if (!injected) return;

  markActiveAdminNavLink();
  applyRoleGatedNav(admin.profile);
  populateAdminIdentity(admin);
  setPageTitle(pageTitle);
  wireAdminUserMenu();
  wireMobileSidebarToggle();
  wireAdminLogout();
}
