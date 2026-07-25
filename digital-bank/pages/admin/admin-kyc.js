/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-kyc.js

   Boot sequence: requireAdmin() → initAdminLayout() → data load.
   Same table+drawer shape as the other queue pages, with two
   destructive-ish actions instead of a status-transition list:
   approve (reason optional) and reject (reason required, matching
   admin_reject_kyc()'s own server-side check).
   ============================================================= */

import { requireAdmin, canAccess } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { listKycQueue, getUserDetail, approveKyc, rejectKyc } from '../../supabase/admin.js';
import { $, $$, debounce, getInitials, formatTimestamp } from '../../assets/js/utils.js';

const PAGE_SIZE = 25;

const state = {
  admin: null,
  page: 1,
  total: 0,
  rows: [],
  search: '',
  activeUserId: null,
};

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  state.admin = admin;
  initAdminLayout(admin, { pageTitle: 'KYC queue' });

  wireToolbar();
  wireDrawer();
  wireApproveModal();
  wireRejectModal();

  await loadQueue();
}

/* -----------------------------------------------------------
   Toolbar
   ----------------------------------------------------------- */
function wireToolbar() {
  $('#kyc-search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      loadQueue();
    }, 300)
  );

  $('#kyc-prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loadQueue();
    }
  });

  $('#kyc-next-page').addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page += 1;
      loadQueue();
    }
  });
}

/* -----------------------------------------------------------
   Load + render
   ----------------------------------------------------------- */
async function loadQueue() {
  const tbody = $('#kyc-table-body');
  const empty = $('#kyc-empty');

  tbody.innerHTML = `<tr class="admin-table-skeleton-row"><td colspan="5">Loading queue…</td></tr>`;
  empty.hidden = true;

  const { data, error } = await listKycQueue({
    search: state.search || undefined,
    page: state.page,
    pageSize: PAGE_SIZE,
  });

  if (error) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = error;
    showToast(error, 'error');
    return;
  }

  state.rows = data.rows;
  state.total = data.total;
  renderTable();
  renderPagination();
  renderSummary();
  $('#kyc-count').textContent = `${state.total} waiting`;
}

function renderSummary() {
  $('#stat-pending').textContent = state.total.toLocaleString('en-US');
  const oldest = state.page === 1 ? state.rows[0] : null;
  $('#stat-oldest').textContent = oldest ? formatTimestamp(oldest.created_at) : (state.total ? '—' : 'None');
}

function renderTable() {
  const tbody = $('#kyc-table-body');
  const empty = $('#kyc-empty');

  if (!state.rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'The queue is empty.';
    return;
  }

  empty.hidden = true;
  tbody.innerHTML = state.rows
    .map((row) => {
      const fullName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || '—';
      return `
        <tr data-kyc-row="${row.id}">
          <td>
            <div class="admin-table-identity">
              <span class="avatar-initial avatar-initial--sm">${getInitials(fullName)}</span>
              <span>${escapeHtml(fullName)}</span>
            </div>
          </td>
          <td>${escapeHtml(row.email || '—')}</td>
          <td>${escapeHtml(row.country || '—')}</td>
          <td>${formatTimestamp(row.created_at)}</td>
          <td class="admin-table-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-open-kyc="${row.id}">Review</button>
          </td>
        </tr>`;
    })
    .join('');

  $$('[data-open-kyc]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.openKyc));
  });
}

function renderPagination() {
  const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  $('#kyc-page-indicator').textContent = `Page ${state.page} of ${maxPage}`;
  $('#kyc-prev-page').disabled = state.page <= 1;
  $('#kyc-next-page').disabled = state.page >= maxPage;
}

/* -----------------------------------------------------------
   Detail drawer
   ----------------------------------------------------------- */
function wireDrawer() {
  $('#kyc-drawer-close').addEventListener('click', closeDrawer);
  $('#kyc-drawer-overlay').addEventListener('click', (e) => {
    if (e.target === $('#kyc-drawer-overlay')) closeDrawer();
  });
}

function closeDrawer() {
  $('#kyc-drawer-overlay').setAttribute('aria-hidden', 'true');
  state.activeUserId = null;
}

async function openDrawer(userId) {
  state.activeUserId = userId;
  $('#kyc-drawer-overlay').setAttribute('aria-hidden', 'false');
  $('#kyc-drawer-body').innerHTML = `<p class="field-hint">Loading…</p>`;

  const { data, error } = await getUserDetail(userId);
  if (error) {
    $('#kyc-drawer-body').innerHTML = `<p class="field-hint" style="color:var(--red)">${escapeHtml(error)}</p>`;
    return;
  }

  renderDrawer(data);
}

function renderDrawer({ profile }) {
  const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || '—';

  $('#kyc-drawer-title').textContent = fullName;
  $('#kyc-drawer-subtitle').textContent = profile.email || '—';
  $('#kyc-drawer-avatar').textContent = getInitials(fullName);

  const canDecide = canAccess(state.admin.profile, ['admin', 'superadmin']);

  $('#kyc-drawer-body').innerHTML = `
    <section class="admin-drawer-section">
      <h4>Identity</h4>
      <div class="admin-detail-row"><span>Full name</span><span>${escapeHtml(fullName)}</span></div>
      <div class="admin-detail-row"><span>Email</span><span>${escapeHtml(profile.email || '—')}</span></div>
      <div class="admin-detail-row"><span>Phone</span><span>${escapeHtml(profile.phone || '—')}</span></div>
      <div class="admin-detail-row"><span>Nationality</span><span>${escapeHtml(profile.nationality || '—')}</span></div>
      <div class="admin-detail-row"><span>Country</span><span>${escapeHtml(profile.country || '—')}</span></div>
      <div class="admin-detail-row"><span>Date of birth</span><span>${escapeHtml(profile.date_of_birth || '—')}</span></div>
    </section>
    <section class="admin-drawer-section">
      <h4>Application</h4>
      <div class="admin-detail-row"><span>Submitted</span><span>${formatTimestamp(profile.created_at)}</span></div>
      <div class="admin-detail-row"><span>Status</span><span><span class="admin-status-pill admin-status-pill--warning">Pending</span></span></div>
    </section>
    ${
      canDecide
        ? `<div class="admin-drawer-footer">
            <button type="button" class="btn btn-ghost" id="drawer-reject-btn">Reject</button>
            <button type="button" class="btn btn-primary" id="drawer-approve-btn">Approve</button>
          </div>`
        : `<p class="field-hint">Your role can review applications but not decide them.</p>`
    }
  `;

  if (canDecide) {
    $('#drawer-approve-btn').addEventListener('click', () => openApproveModal());
    $('#drawer-reject-btn').addEventListener('click', () => openRejectModal());
  }
}

/* -----------------------------------------------------------
   Approve modal
   ----------------------------------------------------------- */
function wireApproveModal() {
  const overlay = $('#approve-modal');
  $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', closeApproveModal));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeApproveModal();
  });

  $('#approve-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeUserId) return;

    const reason = $('#approve-modal-reason').value.trim();
    const submitBtn = $('#approve-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Approving…';

    const { error } = await approveKyc(state.activeUserId, reason || null);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Approve';

    if (error) {
      const errorEl = $('#approve-modal-error');
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    showToast('Account approved.', 'success');
    closeApproveModal();
    closeDrawer();
    await loadQueue();
  });
}

function openApproveModal() {
  $('#approve-modal-reason').value = '';
  $('#approve-modal-error').style.display = 'none';
  $('#approve-modal').setAttribute('aria-hidden', 'false');
}

function closeApproveModal() {
  $('#approve-modal').setAttribute('aria-hidden', 'true');
}

/* -----------------------------------------------------------
   Reject modal
   ----------------------------------------------------------- */
function wireRejectModal() {
  const overlay = $('#reject-modal');
  $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', closeRejectModal));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeRejectModal();
  });

  $('#reject-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeUserId) return;

    const reason = $('#reject-modal-reason').value.trim();
    const errorEl = $('#reject-modal-error');

    if (!reason) {
      errorEl.textContent = 'A reason is required to reject an application.';
      errorEl.style.display = 'block';
      return;
    }

    const submitBtn = $('#reject-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Rejecting…';

    const { error } = await rejectKyc(state.activeUserId, reason);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Reject';

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    showToast('Application rejected.', 'success');
    closeRejectModal();
    closeDrawer();
    await loadQueue();
  });
}

function openRejectModal() {
  $('#reject-modal-reason').value = '';
  $('#reject-modal-error').style.display = 'none';
  $('#reject-modal').setAttribute('aria-hidden', 'false');
}

function closeRejectModal() {
  $('#reject-modal').setAttribute('aria-hidden', 'true');
}

/* -----------------------------------------------------------
   Small helpers
   ----------------------------------------------------------- */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type = 'info') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

init();
