/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-approvals.js
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import {
  getApprovalStats, getApprovalQueue, getApprovalRequest, decideApproval,
  listAdminAuditLog, getAuditFilterOptions,
} from '../../supabase/admin.js';
import { getMyProfile } from '../../supabase/database.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

let admin = null;
let queueStatus = 'pending';
let queueType = 'all';
let selectedRequestId = null;

let auditPage = 0;
const AUDIT_PAGE_SIZE = 25;

/* -----------------------------------------------------------
   Toast
   ----------------------------------------------------------- */
function showToast(message, type = 'success') {
  const region = $('.profile-toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `profile-toast profile-toast--${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 250);
  }, 3600);
}

function setButtonLoading(button, isLoading) {
  if (!button) return;
  button.classList.toggle('is-loading', isLoading);
  button.disabled = isLoading;
}

/* -----------------------------------------------------------
   Tabs
   ----------------------------------------------------------- */
function initTabs() {
  const links = $$('.admin-tab-link');
  const panels = $$('.admin-tab-panel');

  links.forEach((link) => {
    link.addEventListener('click', () => {
      const tab = link.dataset.tab;
      links.forEach((l) => l.classList.toggle('is-active', l === link));
      panels.forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
      if (tab === 'audit' && !panels.find((p) => p.dataset.panel === 'audit').dataset.loaded) {
        initAuditFilters().then(loadAuditLog);
      }
    });
  });
}

/* -----------------------------------------------------------
   Summary stats
   ----------------------------------------------------------- */
async function loadStats() {
  const { data, error } = await getApprovalStats();
  if (error || !data) return;
  const stats = Array.isArray(data) ? data[0] : data;
  $$('[data-stat]').forEach((el) => {
    const key = el.dataset.stat;
    if (stats[key] !== undefined) el.textContent = stats[key];
  });
}

/* -----------------------------------------------------------
   Approval queue
   ----------------------------------------------------------- */
function initQueueFilters() {
  $$('.admin-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.admin-filter-chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      queueStatus = chip.dataset.statusFilter;
      loadQueue();
    });
  });

  $('#approval-type-filter').addEventListener('change', (event) => {
    queueType = event.target.value;
    loadQueue();
  });
}

const REQUEST_TYPE_LABELS = {
  large_transfer: 'Large transfer',
  new_card_request: 'New card request',
  loan_approval: 'Loan approval',
  international_transfer: 'International transfer',
  profile_change: 'Profile change',
  high_risk_login: 'High-risk login',
};

function formatDetail(row) {
  const value = row.new_value;
  if (value && typeof value === 'object' && 'amount' in value) {
    return `${value.currency || 'USD'} ${Number(value.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  }
  return value ? JSON.stringify(value).slice(0, 40) : '—';
}

async function loadQueue() {
  const body = $('#approval-queue-body');
  const empty = $('#approval-queue-empty');
  body.innerHTML = '<tr class="admin-table-row-skeleton"><td colspan="8"><div class="skeleton"></div></td></tr>'.repeat(3);
  empty.hidden = true;

  const { data, error } = await getApprovalQueue({ status: queueStatus, type: queueType, limit: 25 });

  if (error) { showToast(error, 'error'); body.innerHTML = ''; empty.hidden = false; return; }
  if (!data.length) { body.innerHTML = ''; empty.hidden = false; return; }

  body.innerHTML = data.map((row) => `
    <tr data-request-id="${row.id}">
      <td class="mono">#${String(row.id).slice(0, 8)}</td>
      <td>${REQUEST_TYPE_LABELS[row.type] || row.type}</td>
      <td>${row.customer ? `${row.customer.first_name} ${row.customer.last_name}` : '—'}</td>
      <td>${row.requester ? `${row.requester.first_name} ${row.requester.last_name}` : '—'}</td>
      <td>${new Date(row.requested_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td class="mono">${formatDetail(row)}</td>
      <td><span class="status-pill status-pill--${row.status === 'approved' ? 'verified' : row.status === 'rejected' ? 'error' : 'pending'}">${row.status}</span></td>
      <td><button type="button" class="link-arrow-sm" data-review-btn>Review</button></td>
    </tr>
  `).join('');

  $$('[data-review-btn]', body).forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.requestId;
      openReviewModal(id);
    });
  });
}

/* -----------------------------------------------------------
   Review / decision modal
   ----------------------------------------------------------- */
async function openReviewModal(requestId) {
  const { data: row, error } = await getApprovalRequest(requestId);
  if (error || !row) { showToast(error || 'Could not load this request.', 'error'); return; }

  selectedRequestId = requestId;
  const modal = $('#approval-review-modal');

  $('[data-review-type]').textContent = REQUEST_TYPE_LABELS[row.type] || row.type;
  $('[data-review-customer]').textContent = row.customer ? `${row.customer.first_name} ${row.customer.last_name}` : '—';
  $('[data-review-requester]').textContent = row.requester ? `${row.requester.first_name} ${row.requester.last_name}` : '—';
  $('[data-review-requested-at]').textContent = new Date(row.requested_at).toLocaleString('en-US');
  $('[data-review-previous]').textContent = row.previous_value ? JSON.stringify(row.previous_value, null, 2) : '—';
  $('[data-review-new]').textContent = row.new_value ? JSON.stringify(row.new_value, null, 2) : '—';

  const isSelfRequest = row.requested_by === admin.user.id;
  $('[data-self-approval-notice]').hidden = !isSelfRequest;
  $('#approval-approve-btn').disabled = isSelfRequest || row.status !== 'pending';
  $('#approval-reject-btn').disabled = isSelfRequest || row.status !== 'pending';

  $('#approval-modal-error').textContent = '';
  $('#approval-decision-form').reset();

  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('is-open'));
}

function closeReviewModal() {
  const modal = $('#approval-review-modal');
  modal.classList.remove('is-open');
  setTimeout(() => { modal.hidden = true; }, 200);
  selectedRequestId = null;
}

function initReviewModal() {
  const modal = $('#approval-review-modal');
  $('.modal-close', modal).addEventListener('click', closeReviewModal);
  $('.modal-cancel', modal).addEventListener('click', closeReviewModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeReviewModal(); });

  $('#approval-decision-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedRequestId) return;

    const decision = event.submitter?.dataset.decision;
    if (!decision) return;

    const reason = event.target.elements.decision_reason.value.trim();
    const errorEl = $('#approval-modal-error');
    errorEl.textContent = '';

    setButtonLoading($('#approval-approve-btn'), true);
    setButtonLoading($('#approval-reject-btn'), true);

    const { error } = await decideApproval(selectedRequestId, decision, reason);

    setButtonLoading($('#approval-approve-btn'), false);
    setButtonLoading($('#approval-reject-btn'), false);

    if (error) { errorEl.textContent = error; return; }

    showToast(`Request ${decision}.`);
    closeReviewModal();
    loadQueue();
    loadStats();
  });
}

/* -----------------------------------------------------------
   Audit trail
   ----------------------------------------------------------- */
async function initAuditFilters() {
  const { data } = await getAuditFilterOptions();
  const adminSelect = $('#audit-admin-filter');
  const actionSelect = $('#audit-action-filter');

  data.admins.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.first_name} ${a.last_name}`;
    adminSelect.appendChild(opt);
  });

  data.actions.forEach((action) => {
    const opt = document.createElement('option');
    opt.value = action;
    opt.textContent = action;
    actionSelect.appendChild(opt);
  });

  [adminSelect, actionSelect, $('#audit-from-date'), $('#audit-to-date')].forEach((el) => {
    el.addEventListener('change', () => { auditPage = 0; loadAuditLog(); });
  });

  let searchDebounce;
  $('#audit-reason-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { auditPage = 0; loadAuditLog(); }, 300);
  });

  $('#audit-prev-page').addEventListener('click', () => { if (auditPage > 0) { auditPage -= 1; loadAuditLog(); } });
  $('#audit-next-page').addEventListener('click', () => { auditPage += 1; loadAuditLog(); });

  $('#audit-export-btn').addEventListener('click', exportAuditCsv);
}

function getAuditFilters() {
  const adminId = $('#audit-admin-filter').value;
  const action = $('#audit-action-filter').value;
  return {
    adminId: adminId && adminId !== 'all' ? adminId : undefined,
    action: action && action !== 'all' ? action : undefined,
    from: $('#audit-from-date').value || undefined,
    to: $('#audit-to-date').value ? `${$('#audit-to-date').value}T23:59:59` : undefined,
    search: $('#audit-reason-search').value.trim() || undefined,
  };
}

function formatMetadata(metadata) {
  if (!metadata || (typeof metadata === 'object' && !Object.keys(metadata).length)) return '—';
  const str = JSON.stringify(metadata);
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

async function loadAuditLog() {
  const body = $('#audit-log-body');
  const empty = $('#audit-log-empty');
  const panel = $('.admin-tab-panel[data-panel="audit"]');
  body.innerHTML = '<tr class="admin-table-row-skeleton"><td colspan="6"><div class="skeleton"></div></td></tr>'.repeat(4);
  empty.hidden = true;

  const { data, error } = await listAdminAuditLog({
    ...getAuditFilters(),
    page: auditPage + 1,
    pageSize: AUDIT_PAGE_SIZE,
  });

  panel.dataset.loaded = 'true';

  if (error) { showToast(error, 'error'); body.innerHTML = ''; empty.hidden = false; return; }
  if (!data.rows.length) { body.innerHTML = ''; empty.hidden = false; return; }

  body.innerHTML = data.rows.map((row) => `
    <tr>
      <td>${new Date(row.created_at).toLocaleString('en-US')}</td>
      <td>${row.admin ? `${row.admin.first_name} ${row.admin.last_name}` : '—'}</td>
      <td>${row.action}</td>
      <td class="mono">${row.target_table || '—'}${row.target_id ? ` #${String(row.target_id).slice(0, 8)}` : ''}</td>
      <td class="mono">${formatMetadata(row.metadata)}</td>
      <td>${row.reason || '—'}</td>
    </tr>
  `).join('');

  $('#audit-page-indicator').textContent = `Page ${auditPage + 1}`;
  $('#audit-prev-page').disabled = auditPage === 0;
  $('#audit-next-page').disabled = (auditPage + 1) * AUDIT_PAGE_SIZE >= data.total;
}

async function exportAuditCsv() {
  const { data, error } = await listAdminAuditLog({ ...getAuditFilters(), page: 1, pageSize: 5000 });
  if (error || !data.rows.length) { showToast('Nothing to export for these filters.', 'error'); return; }

  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Timestamp', 'Administrator', 'Action', 'Target table', 'Target ID', 'Metadata', 'Reason'];
  const lines = [header.map(escape).join(',')];
  data.rows.forEach((row) => {
    lines.push([
      new Date(row.created_at).toLocaleString('en-US'),
      row.admin ? `${row.admin.first_name} ${row.admin.last_name}` : '',
      row.action,
      row.target_table || '',
      row.target_id || '',
      row.metadata ? JSON.stringify(row.metadata) : '',
      row.reason || '',
    ].map(escape).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `meridian-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  admin = await requireAdmin();
  if (!admin) return;

  const { data: profile } = await getMyProfile(admin.user.id);
  $$('[data-admin-name]').forEach((el) => { el.textContent = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || 'Admin'; });
  $$('[data-admin-role]').forEach((el) => { el.textContent = admin.profile.role; });

  initTabs();
  initQueueFilters();
  initReviewModal();

  loadStats();
  loadQueue();
})();
