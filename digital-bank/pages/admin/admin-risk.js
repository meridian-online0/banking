/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-risk.js
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import {
  getRiskFlagSummary,
  listRiskFlags,
  getRiskFlagDetail,
  dismissRiskFlag,
  escalateRiskFlag,
  resolveRiskFlag,
} from '../../supabase/admin.js';
import { showToast } from '../../assets/js/notifications.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let currentFlagId = null;
let pendingAction = null; // 'dismiss' | 'escalate' | 'resolve'
let filters = { search: '', status: '', severity: '' };
let currentPage = 1;
const PAGE_SIZE = 25;

const STATUS_LABELS = { active: 'Active', escalated: 'Escalated', dismissed: 'Dismissed', resolved: 'Resolved' };
const STATUS_CLASSES = { active: 'admin-status-pill--danger', escalated: 'admin-status-pill--warning', dismissed: 'admin-status-pill--neutral', resolved: 'admin-status-pill--success' };
const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const FLAG_TYPE_LABELS = { manual_review: 'Manual review', velocity: 'Velocity anomaly', large_transfer: 'Large transfer', new_device: 'New device', location_mismatch: 'Location mismatch' };

function customerName(customer) {
  if (!customer) return 'Unknown customer';
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email || 'Unknown customer';
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* -----------------------------------------------------------
   Stat row
   ----------------------------------------------------------- */
async function loadStats() {
  const { data, error } = await getRiskFlagSummary();
  if (error) return;
  const cards = $$('#risk-stat-row .admin-stat-value');
  cards[0].textContent = data.active;
  cards[1].textContent = data.escalated;
  cards[2].textContent = data.resolved;
}

/* -----------------------------------------------------------
   Table
   ----------------------------------------------------------- */
function renderFlagRow(flag) {
  const tr = document.createElement('tr');
  tr.style.cursor = 'pointer';
  tr.innerHTML = `
    <td>${escapeHtml(flag.description).slice(0, 80)}</td>
    <td>${escapeHtml(customerName(flag.customer))}</td>
    <td>${FLAG_TYPE_LABELS[flag.flag_type] || flag.flag_type}</td>
    <td><span class="admin-status-pill">${SEVERITY_LABELS[flag.severity] || flag.severity}</span></td>
    <td><span class="admin-status-pill ${STATUS_CLASSES[flag.status] || ''}">${STATUS_LABELS[flag.status] || flag.status}</span></td>
    <td>${formatDate(flag.created_at)}</td>
  `;
  tr.addEventListener('click', () => openDrawer(flag.id));
  return tr;
}

async function loadFlags() {
  const tbody = $('#flag-table-body');
  tbody.innerHTML = '<tr class="admin-table-skeleton-row"><td colspan="6">Loading flags…</td></tr>';

  const { data, error } = await listRiskFlags({
    search: filters.search || undefined,
    status: filters.status || undefined,
    severity: filters.severity || undefined,
    page: currentPage,
    pageSize: PAGE_SIZE,
  });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table-empty">${escapeHtml(error)}</td></tr>`;
    return;
  }

  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-table-empty">No flags match these filters.</td></tr>';
  } else {
    tbody.innerHTML = '';
    data.rows.forEach((flag) => tbody.appendChild(renderFlagRow(flag)));
  }

  $('#flag-count').textContent = `${data.total} flag${data.total === 1 ? '' : 's'}`;
  renderPagination(data.total);
}

function renderPagination(total) {
  const wrap = $('#flag-pagination');
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = `
    <button type="button" class="admin-btn admin-btn--ghost admin-btn-sm" id="prev-page" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
    <span>Page ${currentPage} of ${totalPages}</span>
    <button type="button" class="admin-btn admin-btn--ghost admin-btn-sm" id="next-page" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
  `;
  $('#prev-page')?.addEventListener('click', () => { currentPage -= 1; loadFlags(); });
  $('#next-page')?.addEventListener('click', () => { currentPage += 1; loadFlags(); });
}

/* -----------------------------------------------------------
   Filters
   ----------------------------------------------------------- */
let searchDebounce;
$('#flag-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    filters.search = e.target.value.trim();
    currentPage = 1;
    loadFlags();
  }, 300);
});

$('#status-filter').addEventListener('change', (e) => {
  filters.status = e.target.value;
  currentPage = 1;
  loadFlags();
});

$('#severity-filter').addEventListener('change', (e) => {
  filters.severity = e.target.value;
  currentPage = 1;
  loadFlags();
});

/* -----------------------------------------------------------
   Drawer
   ----------------------------------------------------------- */
function closeDrawer() {
  $('#flag-drawer-overlay').setAttribute('aria-hidden', 'true');
  currentFlagId = null;
}

$('#flag-drawer-close').addEventListener('click', closeDrawer);
$('#flag-drawer-overlay').addEventListener('click', (e) => {
  if (e.target === $('#flag-drawer-overlay')) closeDrawer();
});

async function openDrawer(flagId) {
  currentFlagId = flagId;
  $('#flag-drawer-overlay').setAttribute('aria-hidden', 'false');
  $('#drawer-flag-type').textContent = 'Loading…';

  const { data, error } = await getRiskFlagDetail(flagId);
  if (error || !data) {
    showToast({ type: 'error', title: 'Could not load flag', message: error || 'Try again.' });
    closeDrawer();
    return;
  }

  const { flag, customer, transaction } = data;

  $('#drawer-flag-type').textContent = FLAG_TYPE_LABELS[flag.flag_type] || flag.flag_type;
  $('#drawer-flag-customer').textContent = customerName(customer);
  $('#drawer-severity').textContent = SEVERITY_LABELS[flag.severity] || flag.severity;
  $('#drawer-flag-status').textContent = STATUS_LABELS[flag.status] || flag.status;
  $('#drawer-flag-status').className = `admin-status-pill ${STATUS_CLASSES[flag.status] || ''}`;
  $('#drawer-flag-date').textContent = formatDate(flag.created_at);
  $('#drawer-description').textContent = flag.description;

  const txSection = $('#drawer-tx-section');
  if (transaction) {
    txSection.hidden = false;
    $('#drawer-tx-ref').textContent = transaction.transaction_reference || '\u2014';
    $('#drawer-tx-amount').textContent = `${transaction.currency} ${Number(transaction.amount).toLocaleString()}`;
  } else {
    txSection.hidden = true;
  }

  const isFinal = flag.status === 'dismissed' || flag.status === 'resolved';
  $('#dismiss-btn').hidden = isFinal;
  $('#escalate-btn').hidden = isFinal || flag.status === 'escalated';
  $('#resolve-flag-btn').hidden = isFinal;
}

/* -----------------------------------------------------------
   Actions — dismiss / escalate / resolve, all via the shared
   reason modal.
   ----------------------------------------------------------- */
const MODAL_COPY = {
  dismiss: { title: 'Dismiss this flag?', subtitle: 'Optional note on why this isn\u2019t a concern.', required: false },
  escalate: { title: 'Escalate this flag?', subtitle: 'Optional note for the team taking this further.', required: false },
  resolve: { title: 'Resolve this flag?', subtitle: 'A resolution note is required.', required: true },
};

function openReasonModal(action) {
  pendingAction = action;
  const copy = MODAL_COPY[action];
  $('#reason-modal-title').textContent = copy.title;
  $('#reason-modal-subtitle').textContent = copy.subtitle;
  $('#reason-input').value = '';
  $('#reason-error').textContent = '';
  $('#reason-modal').classList.add('is-open');
}

$('#dismiss-btn').addEventListener('click', () => openReasonModal('dismiss'));
$('#escalate-btn').addEventListener('click', () => openReasonModal('escalate'));
$('#resolve-flag-btn').addEventListener('click', () => openReasonModal('resolve'));

$$('[data-close-reason-modal]').forEach((btn) => {
  btn.addEventListener('click', () => $('#reason-modal').classList.remove('is-open'));
});

$('#reason-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentFlagId || !pendingAction) return;

  const note = $('#reason-input').value.trim();
  const copy = MODAL_COPY[pendingAction];

  if (copy.required && !note) {
    $('#reason-error').textContent = 'A note is required for this action.';
    return;
  }

  const btn = $('#reason-confirm-btn');
  btn.disabled = true;

  const actionFn = { dismiss: dismissRiskFlag, escalate: escalateRiskFlag, resolve: resolveRiskFlag }[pendingAction];
  const { error } = await actionFn(currentFlagId, note || null);

  btn.disabled = false;

  if (error) {
    showToast({ type: 'error', title: 'Action failed', message: error });
    return;
  }

  $('#reason-modal').classList.remove('is-open');
  showToast({ type: 'success', message: 'Flag updated.' });
  closeDrawer();
  loadFlags();
  loadStats();
});

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  await initAdminLayout(admin, { pageTitle: 'Risk & fraud' });

  loadStats();
  loadFlags();
})();
