/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-cards.js

   Boot sequence: requireAdmin() → initAdminLayout() → data load.
   Same table+drawer shape as admin-users.js / admin-transactions.js.
   ============================================================= */

import { requireAdmin, canAccess } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { listCards, getCardDetail, getCardStatusSummary, setCardStatus } from '../../supabase/admin.js';
import { $, $$, debounce, getInitials, maskAccountNumber } from '../../assets/js/utils.js';

const PAGE_SIZE = 25;

const STATUS_TRANSITIONS = {
  Active: ['Frozen', 'Cancelled'],
  Frozen: ['Active', 'Cancelled'],
  Pending: ['Active', 'Cancelled'],
  Cancelled: [], // terminal — no path back out
};

const state = {
  admin: null,
  page: 1,
  total: 0,
  rows: [],
  filters: { search: '', status: '', type: '' },
  activeCardId: null,
  pendingStatus: null,
};

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  state.admin = admin;
  initAdminLayout(admin, { pageTitle: 'Cards' });

  wireToolbar();
  wireDrawer();
  wireStatusModal();

  await Promise.all([loadCards(), loadSummary()]);
}

/* -----------------------------------------------------------
   Toolbar
   ----------------------------------------------------------- */
function wireToolbar() {
  $('#card-search').addEventListener(
    'input',
    debounce((e) => {
      state.filters.search = e.target.value.trim();
      state.page = 1;
      loadCards();
    }, 300)
  );

  $('#status-filter').addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    state.page = 1;
    loadCards();
  });

  $('#type-filter').addEventListener('change', (e) => {
    state.filters.type = e.target.value;
    state.page = 1;
    loadCards();
  });

  $('#cards-prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loadCards();
    }
  });

  $('#cards-next-page').addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page += 1;
      loadCards();
    }
  });
}

/* -----------------------------------------------------------
   Load + render
   ----------------------------------------------------------- */
async function loadCards() {
  const tbody = $('#cards-table-body');
  const empty = $('#cards-empty');

  tbody.innerHTML = `<tr class="admin-table-skeleton-row"><td colspan="6">Loading cards…</td></tr>`;
  empty.hidden = true;

  const { data, error } = await listCards({
    status: state.filters.status || undefined,
    type: state.filters.type || undefined,
    search: state.filters.search || undefined,
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
  $('#card-count').textContent = `${state.total} card${state.total === 1 ? '' : 's'}`;
}

async function loadSummary() {
  const { data, error } = await getCardStatusSummary();
  if (error) return; // stat row stays at "—" — non-fatal

  $('#stat-active').textContent = data.active.toLocaleString('en-US');
  $('#stat-frozen').textContent = data.frozen.toLocaleString('en-US');
  $('#stat-pending').textContent = data.pending.toLocaleString('en-US');
  $('#stat-cancelled').textContent = data.cancelled.toLocaleString('en-US');
}

function renderTable() {
  const tbody = $('#cards-table-body');
  const empty = $('#cards-empty');

  if (!state.rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'No cards match these filters.';
    return;
  }

  empty.hidden = true;
  tbody.innerHTML = state.rows
    .map(
      (row) => `
        <tr data-card-row="${row.id}">
          <td>
            <div class="admin-table-identity">
              <span class="admin-card-chip">${escapeHtml(row.card_type || 'debit')}</span>
              <code>${maskAccountNumber(row.card_number)}</code>
            </div>
          </td>
          <td>${escapeHtml(capitalize(row.card_type))}</td>
          <td>${String(row.expiry_month).padStart(2, '0')}/${row.expiry_year}</td>
          <td>${formatDailyLimit(row.daily_limit)}</td>
          <td>${statusPill(row.card_status)}</td>
          <td class="admin-table-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-open-card="${row.id}">View</button>
          </td>
        </tr>`
    )
    .join('');

  $$('[data-open-card]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.openCard));
  });
}

function renderPagination() {
  const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  $('#cards-page-indicator').textContent = `Page ${state.page} of ${maxPage}`;
  $('#cards-prev-page').disabled = state.page <= 1;
  $('#cards-next-page').disabled = state.page >= maxPage;
}

function statusPill(status) {
  const known = { Active: 'success', Frozen: 'warning', Pending: 'neutral', Cancelled: 'danger' };
  const tone = known[status] || 'neutral';
  return `<span class="admin-status-pill admin-status-pill--${tone}">${escapeHtml(status || 'unknown')}</span>`;
}

function capitalize(value) {
  const str = String(value || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatDailyLimit(value) {
  return value == null ? '—' : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/* -----------------------------------------------------------
   Detail drawer
   ----------------------------------------------------------- */
function wireDrawer() {
  $('#card-drawer-close').addEventListener('click', closeDrawer);
  $('#card-drawer-overlay').addEventListener('click', (e) => {
    if (e.target === $('#card-drawer-overlay')) closeDrawer();
  });
}

function closeDrawer() {
  $('#card-drawer-overlay').setAttribute('aria-hidden', 'true');
  state.activeCardId = null;
}

async function openDrawer(cardId) {
  state.activeCardId = cardId;
  $('#card-drawer-overlay').setAttribute('aria-hidden', 'false');
  $('#card-drawer-body').innerHTML = `<p class="field-hint">Loading…</p>`;

  const { data, error } = await getCardDetail(cardId);
  if (error) {
    $('#card-drawer-body').innerHTML = `<p class="field-hint" style="color:var(--red)">${escapeHtml(error)}</p>`;
    return;
  }

  renderDrawer(data);
}

function renderDrawer({ card, account, holder }) {
  const holderName = holder ? `${holder.first_name || ''} ${holder.last_name || ''}`.trim() : null;

  $('#card-drawer-title').textContent = maskAccountNumber(card.card_number);
  $('#card-drawer-subtitle').textContent = holderName || 'Cardholder unknown';
  $('#card-drawer-avatar').textContent = holderName ? getInitials(holderName) : '?';

  const canManage = canAccess(state.admin.profile, ['admin', 'superadmin']);
  const transitions = STATUS_TRANSITIONS[card.card_status] || [];

  const actionsMarkup =
    canManage && transitions.length
      ? `<div class="admin-drawer-footer admin-drawer-footer--wrap">
          ${transitions
            .map(
              (next) =>
                `<button type="button" class="btn ${next === 'Cancelled' ? 'btn-danger' : 'btn-primary'} btn-sm" data-set-status="${next}">
                  ${next === 'Active' ? 'Reactivate' : next === 'Frozen' ? 'Freeze' : 'Cancel card'}
                </button>`
            )
            .join('')}
        </div>`
      : '';

  $('#card-drawer-body').innerHTML = `
    <section class="admin-drawer-section">
      <h4>Card</h4>
      <div class="admin-detail-row"><span>Cardholder name on file</span><span>${escapeHtml(card.card_holder || '—')}</span></div>
      <div class="admin-detail-row"><span>Type</span><span>${escapeHtml(capitalize(card.card_type))}</span></div>
      <div class="admin-detail-row"><span>Expires</span><span>${String(card.expiry_month).padStart(2, '0')}/${card.expiry_year}</span></div>
      <div class="admin-detail-row"><span>Daily limit</span><span>${formatDailyLimit(card.daily_limit)}</span></div>
      <div class="admin-detail-row"><span>Status</span><span>${statusPill(card.card_status)}</span></div>
    </section>
    <section class="admin-drawer-section">
      <h4>Linked account</h4>
      ${
        account
          ? `<div class="admin-detail-row"><span>Currency</span><span>${escapeHtml(account.currency)}</span></div>
             <div class="admin-detail-row"><span>Account status</span><span>${escapeHtml(account.account_status || 'active')}</span></div>`
          : `<p class="field-hint">Linked account not found.</p>`
      }
    </section>
    <section class="admin-drawer-section">
      <h4>Cardholder</h4>
      ${
        holder
          ? `<div class="admin-detail-row"><span>Name</span><span>${escapeHtml(holderName)}</span></div>
             <div class="admin-detail-row"><span>Email</span><span>${escapeHtml(holder.email || '—')}</span></div>`
          : `<p class="field-hint">Cardholder profile not found.</p>`
      }
    </section>
    ${actionsMarkup}
  `;

  $$('[data-set-status]', $('#card-drawer-body')).forEach((btn) => {
    btn.addEventListener('click', () => openStatusModal(card, btn.dataset.setStatus));
  });
}

/* -----------------------------------------------------------
   Status override modal
   ----------------------------------------------------------- */
function wireStatusModal() {
  const overlay = $('#status-modal');
  $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', closeStatusModal));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeStatusModal();
  });

  $('#status-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.pendingStatus) return;

    const reason = $('#status-modal-reason').value.trim();
    const errorEl = $('#status-modal-error');

    if (!reason) {
      errorEl.textContent = 'A reason is required.';
      errorEl.style.display = 'block';
      return;
    }

    const submitBtn = $('#status-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Working…';

    const { cardId, nextStatus } = state.pendingStatus;
    const { error } = await setCardStatus(cardId, nextStatus, reason);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm';

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    showToast('Card status updated.', 'success');
    closeStatusModal();
    await Promise.all([loadCards(), loadSummary()]);
    if (state.activeCardId) openDrawer(state.activeCardId);
  });
}

function openStatusModal(card, nextStatus) {
  state.pendingStatus = { cardId: card.id, nextStatus };
  const copy = {
    Active: 'This card will be reactivated and can be used immediately.',
    Frozen: 'This card will be immediately blocked from new transactions.',
    Cancelled: 'This card will be permanently cancelled. This cannot be undone.',
  }[nextStatus];

  $('#status-modal-title').textContent = `${nextStatus === 'Active' ? 'Reactivate' : nextStatus === 'Frozen' ? 'Freeze' : 'Cancel'} card`;
  $('#status-modal-copy').textContent = copy;
  $('#status-modal-reason').value = '';
  $('#status-modal-error').style.display = 'none';
  $('#status-modal').setAttribute('aria-hidden', 'false');
}

function closeStatusModal() {
  $('#status-modal').setAttribute('aria-hidden', 'true');
  state.pendingStatus = null;
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
