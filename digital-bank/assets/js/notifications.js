/* =============================================================
   MERIDIAN — International Digital Banking
   Notifications: assets/js/notifications.js

   Two things live here:

     1. Toast helper (toastSuccess / toastError / toastInfo) — builds
        the .toast-stack markup already defined in style.css and
        drops transient messages into it. Works on any page, no
        Supabase needed.

     2. The header notification bell — drives the REAL markup
        already shipped in components/app-navbar.html
        ([data-notification-bell] and its children). It pulls unread
        count + recent notifications from the `notifications` table
        via supabase/database.js, and subscribes to Supabase Realtime
        so a new notification appears without a refresh.

     import { toastSuccess, toastError, initNotificationCenter } from '../assets/js/notifications.js';

   NOTE on relative paths: this file always lives at
   /assets/js/notifications.js — two directories deep from the
   project root — so its dynamic import() calls always need '../../'
   to reach root-level supabase/, regardless of which page (root or
   under /pages/) triggered the import. import() resolves relative
   to THIS file's own location, not the current page's URL.
   ============================================================= */

import { $, $$, formatTimestamp } from './utils.js';
import { pulse } from './animations.js';

/* -----------------------------------------------------------
   Toasts
   ----------------------------------------------------------- */

const TOAST_ICONS = {
  success: '<path d="M5 12.5 10 17l9-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  error: '<path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  info: '<circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v5M10 6.5v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

function getOrCreateToastStack() {
  let stack = $('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

export function showToast({ type = 'info', title, message, duration = 5000 } = {}) {
  const stack = getOrCreateToastStack();

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <span class="toast-icon"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${TOAST_ICONS[type] || TOAST_ICONS.info}</svg></span>
    <div class="toast-body">
      ${title ? `<strong></strong>` : ''}
      <span></span>
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss notification">
      <svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
  `;
  if (title) $('strong', toast).textContent = title;
  $('.toast-body span', toast).textContent = message || '';

  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));

  let dismissTimer;
  const dismiss = () => {
    clearTimeout(dismissTimer);
    toast.classList.remove('is-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  };

  $('.toast-close', toast).addEventListener('click', dismiss);
  if (duration > 0) dismissTimer = setTimeout(dismiss, duration);

  return { dismiss };
}

export const toastSuccess = (message, title = 'Success') => showToast({ type: 'success', title, message });
export const toastError = (message, title = 'Something went wrong') => showToast({ type: 'error', title, message });
export const toastInfo = (message, title) => showToast({ type: 'info', title, message });

/* -----------------------------------------------------------
   Header notification bell — logged-in app pages only
   ----------------------------------------------------------- */

function resolveSupabaseBase() {
  return '../../supabase/';
}

let dbModulePromise = null;
function loadDatabaseModule() {
  if (!dbModulePromise) dbModulePromise = import(`${resolveSupabaseBase()}database.js`);
  return dbModulePromise;
}

let configModulePromise = null;
function loadConfigModule() {
  if (!configModulePromise) configModulePromise = import(`${resolveSupabaseBase()}config.js`);
  return configModulePromise;
}

function getBellElements() {
  const wrap = document.querySelector('[data-notification-bell]');
  if (!wrap) return null;

  const toggle = wrap.querySelector('[data-notification-toggle]');
  const dropdown = wrap.querySelector('[data-notification-dropdown]');
  if (!toggle || !dropdown) return null;

  return {
    wrap,
    toggle,
    dropdown,
    badge: wrap.querySelector('[data-notification-badge]'),
    body: dropdown.querySelector('[data-notification-body]'),
    list: dropdown.querySelector('[data-notification-list]'),
    loading: dropdown.querySelector('[data-notification-loading]'),
    empty: dropdown.querySelector('[data-notification-empty]'),
    error: dropdown.querySelector('[data-notification-error]'),
    retryBtn: dropdown.querySelector('[data-notification-retry]'),
    markAllBtn: dropdown.querySelector('[data-notification-mark-all]'),
  };
}

/**
 * Toggles both the `hidden` attribute AND inline `style.display`.
 * notifications.css gives `.notification-state--loading` an explicit
 * `display: flex`, which beats the browser's default
 * `[hidden] { display: none }` rule on its own — so `hidden` alone
 * doesn't actually hide it once another state is shown. Setting
 * `style.display` directly closes that gap.
 */
function showBodyState(els, state) {
  const targets = { loading: els.loading, list: els.list, empty: els.empty, error: els.error };
  Object.entries(targets).forEach(([key, el]) => {
    if (!el) return;
    const show = key === state;
    el.hidden = !show;
    el.style.display = show ? '' : 'none';
  });
}

function renderNotificationRow(notification) {
  const row = document.createElement('li');
  row.className = 'notification-row';
  row.dataset.notificationId = notification.id;
  row.setAttribute('role', 'menuitem');
  row.tabIndex = 0;
  row.innerHTML = `
    <span class="notification-row-text">
      <span>${notification.title || 'Notification'}</span>
      <small></small>
    </span>
    ${notification.is_read ? '' : '<span class="notification-row-state" data-state="on">New</span>'}
  `;
  row.querySelector('small').textContent = `${notification.message || ''} · ${formatTimestamp(notification.created_at)}`;
  return row;
}

function setBadgeCount(badge, count) {
  if (!badge) return;
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.style.display = count > 0 ? 'flex' : 'none';
}

const MOBILE_SHEET_QUERY = '(max-width: 640px)';

function openDropdown(els) {
  // On mobile, .notification-dropdown becomes position:fixed to act as a
  // bottom sheet — but .app-header (its ancestor) sets backdrop-filter,
  // which creates a new containing block and makes "fixed" resolve
  // against the header instead of the real viewport. Reparenting to
  // <body> while open removes it from that ancestor chain so fixed
  // positioning behaves correctly. Desktop's position:absolute doesn't
  // need this — it stays put and keeps anchoring off .notification-bell-wrap.
  if (window.matchMedia(MOBILE_SHEET_QUERY).matches && els.dropdown.parentElement !== document.body) {
    els.dropdownHome = els.dropdown.parentElement;
    els.dropdownNextSibling = els.dropdown.nextSibling;
    document.body.appendChild(els.dropdown);
  }

  els.dropdown.setAttribute('aria-hidden', 'false');
  els.toggle.setAttribute('aria-expanded', 'true');
  els.dropdown.classList.add('is-open');
}

function closeDropdown(els) {
  els.dropdown.setAttribute('aria-hidden', 'true');
  els.toggle.setAttribute('aria-expanded', 'false');
  els.dropdown.classList.remove('is-open');

  // Move it back where it came from so desktop's position:absolute
  // (anchored to .notification-bell-wrap) still works next time.
  if (els.dropdownHome) {
    els.dropdownHome.insertBefore(els.dropdown, els.dropdownNextSibling);
    els.dropdownHome = null;
    els.dropdownNextSibling = null;
  }
}

function isDropdownOpen(els) {
  return els.dropdown.classList.contains('is-open');
}

export async function initNotificationCenter(userId) {
  const els = getBellElements();
  if (!els) return;

  closeDropdown(els);

  let db;
  try {
    db = await loadDatabaseModule();
  } catch (err) {
    console.error('Notifications: failed to load database module', err);
    showBodyState(els, 'error');
    return;
  }

  const { getNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead } = db;

  async function refreshBadge() {
    try {
      const { data: count, error } = await getUnreadNotificationCount(userId);
      if (error) throw new Error(error);
      setBadgeCount(els.badge, count);
    } catch (err) {
      console.error('Notifications: failed to refresh unread count', err);
    }
  }

  async function renderList() {
    showBodyState(els, 'loading');
    try {
      const { data: notifications, error } = await getNotifications(userId, { limit: 20 });
      if (error) throw new Error(error);

      if (els.list) els.list.innerHTML = '';

      if (!notifications.length) {
        showBodyState(els, 'empty');
        return;
      }

      notifications.forEach((n) => els.list.appendChild(renderNotificationRow(n)));
      showBodyState(els, 'list');

      els.list.querySelectorAll('[data-notification-id]').forEach((row) => {
        row.addEventListener('click', async () => {
          try {
            await markNotificationRead(row.dataset.notificationId);
            row.querySelector('.notification-row-state')?.remove();
            refreshBadge();
          } catch (err) {
            console.error('Notifications: failed to mark row read', err);
          }
        });
      });
    } catch (err) {
      console.error('Notifications: failed to load notification list', err);
      showBodyState(els, 'error');
    }
  }

  els.toggle.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (isDropdownOpen(els)) {
      closeDropdown(els);
      return;
    }
    openDropdown(els);
    await renderList();
  });

  document.addEventListener('click', (event) => {
    if (isDropdownOpen(els) && !els.dropdown.contains(event.target) && event.target !== els.toggle) {
      closeDropdown(els);
    }
  });

  els.retryBtn?.addEventListener('click', async (event) => {
    event.stopPropagation();
    await renderList();
  });

  els.markAllBtn?.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await markAllNotificationsRead(userId);
      els.list?.querySelectorAll('.notification-row-state').forEach((el) => el.remove());
      refreshBadge();
    } catch (err) {
      console.error('Notifications: failed to mark all read', err);
      toastError("Couldn't mark all notifications as read.");
    }
  });

  await refreshBadge();

  try {
    await subscribeToNewNotifications(userId, async (notification) => {
      toastInfo(notification.message, notification.title || 'New notification');
      pulse(els.toggle);
      refreshBadge();
      if (isDropdownOpen(els)) renderList();
    });
  } catch (err) {
    console.error('Notifications: realtime subscription failed', err);
  }
}

export async function subscribeToNewNotifications(userId, onInsert) {
  const { supabase } = await loadConfigModule();

  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => onInsert(payload.new)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
