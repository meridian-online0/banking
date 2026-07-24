/* =============================================================
   MERIDIAN — International Digital Banking
   Notification Center page logic: assets/js/notifications-center.js
   Powers pages/notifications.html only. The navbar dropdown on
   every other page is handled by assets/js/notifications.js.

   NOTE on relative paths: this file lives at assets/js/, two
   directories deep from the project root, so it needs '../../'
   to reach the root-level supabase/ folder — a single '../' only
   reaches assets/, which has no supabase/ folder of its own.
   ============================================================= */

import { $, $$, debounce, formatTimestamp } from './utils.js';
import { toastError, toastSuccess } from './notifications.js';
import { requireAuth } from '../../supabase/auth.js';
import { getAccountById } from '../../supabase/database.js';
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  archiveNotification,
  restoreNotification,
  deleteNotification,
  subscribeToNotifications,
  NOTIFICATION_CATEGORIES,
} from '../../supabase/notifications.js';

const PAGE_SIZE = 20;

const state = {
  userId: null,
  status: 'all',       // all | unread | archived
  category: 'all',
  search: '',
  offset: 0,
  total: 0,
  items: [],
  loading: false,
};

const els = {};

function cacheEls() {
  els.list = $('#notif-list');
  els.loading = $('#notif-loading');
  els.empty = $('#notif-empty');
  els.error = $('#notif-error');
  els.loadMoreWrap = $('#notif-load-more');
  els.loadMoreBtn = $('#notif-load-more-btn');
  els.searchInput = $('#notif-search-input');
  els.statusTabs = $$('.tab-toggle-btn', $('#notif-status-tabs'));
  els.categoryChips = $('#notif-category-chips');
  els.markAllBtn = $('#notif-mark-all');
  els.retryBtn = $('#notif-retry');

  els.detailOverlay = $('#notif-detail-overlay');
  els.detailClose = $('#notif-detail-close');
  els.detailCategory = $('#notif-detail-category');
  els.detailTitle = $('#notif-detail-title');
  els.detailMessage = $('#notif-detail-message');
  els.detailDate = $('#notif-detail-date');
  els.detailStatus = $('#notif-detail-status');
  els.detailAccountRow = $('#notif-detail-account-row');
  els.detailAccount = $('#notif-detail-account');
  els.detailTxRow = $('#notif-detail-tx-row');
  els.detailAction = $('#notif-detail-action');
  els.detailArchive = $('#notif-detail-archive');
  els.detailDelete = $('#notif-detail-delete');
}

function buildCategoryChips() {
  NOTIFICATION_CATEGORIES.forEach(({ value, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notif-chip';
    btn.dataset.category = value;
    btn.textContent = label;
    els.categoryChips.appendChild(btn);
  });
}

/* -----------------------------------------------------------
   Grouping — Today / Yesterday / This Week / Earlier
   ----------------------------------------------------------- */
function groupLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'This week';
  return 'Earlier';
}

const CATEGORY_ICON_PATHS = {
  banking: '<path d="M4 8.5 10 3l6 5.5M5 8v8h10V8" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  account: '<circle cx="10" cy="7" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M4 17c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.4"/>',
  security: '<path d="M10 2.5 16 5v4.5c0 4-2.7 6.9-6 8-3.3-1.1-6-4-6-8V5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  cards: '<rect x="2.5" y="5.5" width="15" height="9" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 9h15" stroke="currentColor" stroke-width="1.4"/>',
  investments: '<path d="M4 15 8 10l3 2.5 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  loans: '<rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M6 8h8M6 11h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  savings: '<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l3 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  rewards: '<path d="M10 2.5 12.4 7.4 18 8.2 14 12l1 5.5L10 15l-5 2.5 1-5.5-4-3.7 5.6-.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  system: '<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 8.5v5M10 6.5v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};

function renderRow(notification) {
  const li = document.createElement('li');
  li.className = 'notification-row' + (notification.is_read ? '' : ' is-unread');
  li.dataset.notificationId = notification.id;
  li.tabIndex = 0;
  li.innerHTML = `
    <span class="notification-row-icon notification-row-icon--${notification.category || 'system'}">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${CATEGORY_ICON_PATHS[notification.category] || CATEGORY_ICON_PATHS.system}</svg>
    </span>
    <span class="notification-row-body">
      <strong></strong>
      <span class="notification-row-msg"></span>
      <time></time>
    </span>
    ${notification.is_read ? '' : '<span class="notification-dot" aria-hidden="true"></span>'}
  `;
  $('strong', li).textContent = notification.title || 'Notification';
  $('.notification-row-msg', li).textContent = notification.message || '';
  $('time', li).textContent = formatTimestamp(notification.created_at);
  li.addEventListener('click', () => openDetail(notification));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(notification); } });
  return li;
}

function renderGroupedList(items, { append = false } = {}) {
  if (!append) els.list.innerHTML = '';

  let lastGroup = append ? els.list.dataset.lastGroup || null : null;

  items.forEach((notification) => {
    const group = groupLabel(notification.created_at);
    if (group !== lastGroup) {
      const heading = document.createElement('li');
      heading.className = 'notif-group-label';
      heading.textContent = group;
      heading.setAttribute('role', 'presentation');
      els.list.appendChild(heading);
      lastGroup = group;
    }
    els.list.appendChild(renderRow(notification));
  });

  els.list.dataset.lastGroup = lastGroup || '';
}

/* -----------------------------------------------------------
   Fetch + render
   ----------------------------------------------------------- */
async function fetchPage({ reset = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  if (reset) {
    state.offset = 0;
    state.items = [];
    els.list.hidden = true;
    els.empty.hidden = true;
    els.error.hidden = true;
    els.loading.hidden = false;
    els.loadMoreWrap.hidden = true;
  }

  const { data, error, count } = await getNotifications(state.userId, {
    category: state.category,
    status: state.status === 'archived' ? 'all' : state.status,
    archived: state.status === 'archived',
    search: state.search,
    limit: PAGE_SIZE,
    offset: state.offset,
  });

  state.loading = false;
  els.loading.hidden = true;

  if (error) {
    els.error.hidden = false;
    return;
  }

  state.total = count ?? data.length;
  const isAppend = state.offset > 0;
  state.items = state.items.concat(data);
  state.offset += data.length;

  if (!state.items.length) {
    els.empty.hidden = false;
    els.list.hidden = true;
    els.loadMoreWrap.hidden = true;
    return;
  }

  els.empty.hidden = true;
  els.list.hidden = false;
  renderGroupedList(data, { append: isAppend });
  els.loadMoreWrap.hidden = state.offset >= state.total;
}

/* -----------------------------------------------------------
   Detail panel
   ----------------------------------------------------------- */
let activeDetail = null;

async function openDetail(notification) {
  activeDetail = notification;

  if (!notification.is_read) {
    await markAsRead(notification.id);
    notification.is_read = true;
    const row = $(`.notification-row[data-notification-id="${notification.id}"]`);
    row?.classList.remove('is-unread');
    row?.querySelector('.notification-dot')?.remove();
  }

  els.detailCategory.textContent = notification.category || 'System';
  els.detailTitle.textContent = notification.title || 'Notification';
  els.detailMessage.textContent = notification.message || '';
  els.detailDate.textContent = formatTimestamp(notification.created_at);
  els.detailStatus.textContent = notification.is_archived ? 'Archived' : (notification.is_read ? 'Read' : 'Unread');

  els.detailAccountRow.hidden = true;
  els.detailTxRow.hidden = true;
  els.detailAction.hidden = true;

  if (notification.related_account_id) {
    const { data: account } = await getAccountById(notification.related_account_id);
    if (account) {
      els.detailAccount.textContent = `${account.currency} •••• ${String(account.account_number || '').slice(-4)}`;
      els.detailAccountRow.hidden = false;
    }
  }

  if (notification.action_url) {
    els.detailAction.href = notification.action_url;
    els.detailAction.hidden = false;
  }

  els.detailArchive.textContent = notification.is_archived ? 'Restore' : 'Archive';

  els.detailOverlay.classList.add('is-open');
  els.detailOverlay.setAttribute('aria-hidden', 'false');
}

function closeDetail() {
  els.detailOverlay.classList.remove('is-open');
  els.detailOverlay.setAttribute('aria-hidden', 'true');
  activeDetail = null;
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
async function init() {
  const user = await requireAuth();
  if (!user) return;
  state.userId = user.id;

  cacheEls();
  buildCategoryChips();
  await fetchPage({ reset: true });

  els.searchInput.addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim();
    fetchPage({ reset: true });
  }, 350));

  els.statusTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      els.statusTabs.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.status = btn.dataset.status;
      fetchPage({ reset: true });
    });
  });

  els.categoryChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.notif-chip');
    if (!chip) return;
    $$('.notif-chip', els.categoryChips).forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    state.category = chip.dataset.category;
    fetchPage({ reset: true });
  });

  els.loadMoreBtn.addEventListener('click', () => fetchPage());
  els.retryBtn.addEventListener('click', () => fetchPage({ reset: true }));

  els.markAllBtn.addEventListener('click', async () => {
    const { error } = await markAllAsRead(state.userId);
    if (error) return toastError(error);
    toastSuccess('All notifications marked as read.');
    fetchPage({ reset: true });
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailOverlay.addEventListener('click', (e) => { if (e.target === els.detailOverlay) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  els.detailArchive.addEventListener('click', async () => {
    if (!activeDetail) return;
    const action = activeDetail.is_archived ? restoreNotification : archiveNotification;
    const { error } = await action(activeDetail.id);
    if (error) return toastError(error);
    toastSuccess(activeDetail.is_archived ? 'Notification restored.' : 'Notification archived.');
    closeDetail();
    fetchPage({ reset: true });
  });

  els.detailDelete.addEventListener('click', async () => {
    if (!activeDetail) return;
    const { error } = await deleteNotification(activeDetail.id);
    if (error) return toastError(error);
    toastSuccess('Notification deleted.');
    closeDetail();
    fetchPage({ reset: true });
  });

  // Infinite scroll — load the next page a little before the bottom.
  window.addEventListener('scroll', debounce(() => {
    if (els.loadMoreWrap.hidden) return;
    const nearBottom = window.innerHeight + window.scrollY > document.body.offsetHeight - 400;
    if (nearBottom) fetchPage();
  }, 200));

  subscribeToNotifications(state.userId, {
    onInsert: () => fetchPage({ reset: true }),
    onUpdate: () => fetchPage({ reset: true }),
  });
}

init();
