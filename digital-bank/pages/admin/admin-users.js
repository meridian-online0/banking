/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-users.js

   Boot sequence follows admin-dashboard.js's reference pattern:
     requireAdmin() → initAdminLayout() → page-specific data load.

   Reference implementation for the filterable/paginated table +
   detail-drawer shape — admin-transactions.html, admin-kyc.html,
   and admin-cards.html reuse this structure.

   CHANGE LOG (this revision)
   ---------------------------
   - Drawer now also loads and renders a Permissions section and a
     Limit overrides section for the active user, using
     getCustomerPermissions/saveCustomerPermissions and
     getCustomerLimitOverrides/saveCustomerLimitOverrides from
     admin.js. Both reuse the existing confirm-modal pattern
     (reason required, audit-logged server-side via the RPC) —
     same as the freeze/unfreeze flow already on this page.
   - Permissions render as real labeled checkboxes, one per column
     in user_permissions (see PERMISSION_FIELDS below) — these
     names are confirmed against 009_admin_policy_engine.sql.
   - Limit overrides render as a raw JSON textarea, NOT labeled
     inputs — user_limit_overrides.override_values is a JSONB blob
     with no field names defined anywhere in the codebase yet (no
     page, migration, or validator specifies them). Faking field
     names for a real money-limit form would be worse than an
     honest raw-JSON editor. Replace this with real inputs once
     the actual field list is confirmed (transactionValidator.js
     likely reads them).
   ============================================================= */

import { requireAdmin, canAccess } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import {
  listUsers, getUserDetail, freezeAccount, unfreezeAccount,
  getCustomerPermissions, saveCustomerPermissions,
  getCustomerLimitOverrides, saveCustomerLimitOverrides,
} from '../../supabase/admin.js';
import { $, $$, debounce, getInitials, formatTimestamp, formatCurrency } from '../../assets/js/utils.js';

const PAGE_SIZE = 25;

// Confirmed against user_permissions columns in
// 009_admin_policy_engine.sql — keep in sync if that table changes.
const PERMISSION_FIELDS = [
  ['can_transfer', 'Transfer money'],
  ['can_receive', 'Receive money'],
  ['can_withdraw', 'Withdraw funds'],
  ['can_deposit', 'Deposit funds'],
  ['can_use_card', 'Use card'],
  ['can_request_card', 'Request new card'],
  ['can_open_account', 'Open account'],
  ['can_close_account', 'Close account'],
  ['can_add_beneficiary', 'Add beneficiary'],
  ['can_international_transfer', 'International transfers'],
  ['can_apply_loan', 'Apply for loan'],
  ['can_invest', 'Invest'],
  ['can_contact_support', 'Contact support'],
];

const state = {
  admin: null,
  page: 1,
  total: 0,
  search: '',
  status: '',
  rows: [],
  activeUserId: null,
  // set by openConfirmModal(), read by the form's submit handler
  pendingAction: null,
};

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
async function init() {
  const admin = await requireAdmin();
  if (!admin) return; // requireAdmin() already redirected

  state.admin = admin;
  initAdminLayout(admin, { pageTitle: 'Users' });

  wireToolbar();
  wireDrawer();
  wireConfirmModal();

  await loadUsers();
}

/* -----------------------------------------------------------
   Toolbar — search + status filter
   ----------------------------------------------------------- */
function wireToolbar() {
  const searchInput = $('#user-search');
  const statusSelect = $('#status-filter');

  searchInput.addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      loadUsers();
    }, 300)
  );

  statusSelect.addEventListener('change', (e) => {
    state.status = e.target.value;
    state.page = 1;
    loadUsers();
  });

  $('#users-prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loadUsers();
    }
  });

  $('#users-next-page').addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page += 1;
      loadUsers();
    }
  });
}

/* -----------------------------------------------------------
   Load + render the table
   ----------------------------------------------------------- */
async function loadUsers() {
  const tbody = $('#users-table-body');
  const empty = $('#users-empty');

  tbody.innerHTML = `<tr class="admin-table-skeleton-row"><td colspan="6">Loading users…</td></tr>`;
  empty.hidden = true;

  const { data, error } = await listUsers({
    search: state.search || undefined,
    status: state.status || undefined,
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
  $('#user-count').textContent = `${state.total} user${state.total === 1 ? '' : 's'}`;
}

function renderTable() {
  const tbody = $('#users-table-body');
  const empty = $('#users-empty');

  if (!state.rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'No users match these filters.';
    return;
  }

  empty.hidden = true;
  tbody.innerHTML = state.rows
    .map((row) => {
      const fullName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || '—';
      return `
        <tr data-user-row="${row.id}">
          <td>
            <div class="admin-table-identity">
              <span class="avatar-initial avatar-initial--sm">${getInitials(fullName)}</span>
              <span>${escapeHtml(fullName)}</span>
            </div>
          </td>
          <td>${escapeHtml(row.email || '—')}</td>
          <td>${statusPill(row.account_status)}</td>
          <td><span class="admin-role-pill">${escapeHtml(row.role || 'customer')}</span></td>
          <td>${formatTimestamp(row.created_at)}</td>
          <td class="admin-table-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-open-user="${row.id}">View</button>
          </td>
        </tr>`;
    })
    .join('');

  $$('[data-open-user]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.openUser));
  });
}

function renderPagination() {
  const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  $('#users-page-indicator').textContent = `Page ${state.page} of ${maxPage}`;
  $('#users-prev-page').disabled = state.page <= 1;
  $('#users-next-page').disabled = state.page >= maxPage;
}

function statusPill(status) {
  const known = { active: 'success', Pending: 'warning', rejected: 'danger', frozen: 'danger' };
  const tone = known[status] || 'neutral';
  return `<span class="admin-status-pill admin-status-pill--${tone}">${escapeHtml(status || 'unknown')}</span>`;
}

/* -----------------------------------------------------------
   Detail drawer
   ----------------------------------------------------------- */
function wireDrawer() {
  $('#user-drawer-close').addEventListener('click', closeDrawer);
  $('#user-drawer-overlay').addEventListener('click', (e) => {
    if (e.target === $('#user-drawer-overlay')) closeDrawer();
  });
}

function closeDrawer() {
  $('#user-drawer-overlay').setAttribute('aria-hidden', 'true');
  state.activeUserId = null;
}

async function openDrawer(userId) {
  state.activeUserId = userId;
  const overlay = $('#user-drawer-overlay');
  overlay.setAttribute('aria-hidden', 'false');

  const body = $('#user-drawer-body');
  body.innerHTML = `<p class="field-hint">Loading…</p>`;

  const [{ data: detail, error }, { data: permissions }, { data: overrides }] = await Promise.all([
    getUserDetail(userId),
    getCustomerPermissions(userId),
    getCustomerLimitOverrides(userId),
  ]);

  if (error) {
    body.innerHTML = `<p class="field-hint" style="color:var(--red)">${escapeHtml(error)}</p>`;
    return;
  }

  renderDrawer(detail, permissions, overrides);
}

function renderDrawer(detail, permissions, overrides) {
  const { profile, accounts, cards, recentTransactions, loginSessions } = detail;
  const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || '—';

  $('#user-drawer-title').textContent = fullName;
  $('#user-drawer-email').textContent = profile.email || '—';
  $('#user-drawer-avatar').textContent = getInitials(fullName);

  const canFreeze = canAccess(state.admin.profile, ['admin', 'superadmin']);

  const accountsMarkup = accounts.length
    ? accounts
        .map((a) => {
          const isFrozen = a.account_status === 'frozen';
          return `
        <div class="admin-detail-row">
          <div>
            <strong>${escapeHtml(a.currency)} account</strong>
            <span class="admin-drawer-subtitle">${formatCurrency(a.balance, a.currency)} · ${escapeHtml(a.account_status || 'active')}</span>
          </div>
          ${
            canFreeze
              ? `<button type="button" class="btn btn-ghost btn-sm" data-toggle-freeze="${a.id}" data-frozen="${isFrozen}">
                  ${isFrozen ? 'Unfreeze' : 'Freeze'}
                </button>`
              : ''
          }
        </div>`;
        })
        .join('')
    : `<p class="field-hint">No accounts.</p>`;

  const cardsMarkup = cards.length
    ? cards.map((c) => `<div class="admin-detail-row"><span>•••• ${String(c.card_number).slice(-4)}</span><span class="admin-status-pill">${escapeHtml(c.card_status)}</span></div>`).join('')
    : `<p class="field-hint">No cards.</p>`;

  const txMarkup = recentTransactions.length
    ? recentTransactions
        .slice(0, 10)
        .map((t) => `<div class="admin-detail-row"><span>${escapeHtml(t.transaction_reference || '')}</span><span>${formatCurrency(t.amount, t.currency)}</span></div>`)
        .join('')
    : `<p class="field-hint">No recent transactions.</p>`;

  const sessionsMarkup = loginSessions.length
    ? loginSessions.slice(0, 5).map((s) => `<div class="admin-detail-row"><span>${formatTimestamp(s.login_time)}</span><span class="admin-drawer-subtitle">${escapeHtml(s.ip_address || '')}</span></div>`).join('')
    : `<p class="field-hint">No login history.</p>`;

  const permissionsMarkup = PERMISSION_FIELDS.map(([key, label]) => {
    // No row yet for this user → every permission defaults to
    // allowed (true), matching the DEFAULT true on every column
    // in the user_permissions table.
    const checked = permissions ? permissions[key] !== false : true;
    return `
      <label class="admin-detail-row" style="cursor:pointer;">
        <span>${escapeHtml(label)}</span>
        <input type="checkbox" data-permission-field="${key}" ${checked ? 'checked' : ''}>
      </label>`;
  }).join('');

  $('#user-drawer-body').innerHTML = `
    <section class="admin-drawer-section">
      <h4>Accounts</h4>
      ${accountsMarkup}
    </section>
    <section class="admin-drawer-section">
      <h4>Cards</h4>
      ${cardsMarkup}
    </section>
    <section class="admin-drawer-section">
      <h4>Recent transactions</h4>
      ${txMarkup}
    </section>
    <section class="admin-drawer-section">
      <h4>Recent logins</h4>
      ${sessionsMarkup}
    </section>
    <section class="admin-drawer-section">
      <h4>Permissions</h4>
      ${permissionsMarkup}
      <button type="button" class="btn btn-primary btn-sm" id="save-permissions-btn" style="margin-top:10px;">Save permissions</button>
    </section>
    <section class="admin-drawer-section">
      <h4>Limit overrides</h4>
      <p class="field-hint">Raw JSON — field names for this table aren't defined anywhere in the codebase yet. Confirm the real shape (e.g. against transactionValidator.js) before relying on this for production limits.</p>
      <textarea id="limit-overrides-json" rows="4" style="width:100%;font-family:monospace;font-size:0.8125rem;">${escapeHtml(JSON.stringify(overrides?.override_values ?? {}, null, 2))}</textarea>
      <button type="button" class="btn btn-primary btn-sm" id="save-overrides-btn" style="margin-top:10px;">Save limit overrides</button>
    </section>
  `;

  $$('[data-toggle-freeze]', $('#user-drawer-body')).forEach((btn) => {
    btn.addEventListener('click', () => {
      const accountId = btn.dataset.toggleFreeze;
      const isFrozen = btn.dataset.frozen === 'true';
      openConfirmModal({
        title: isFrozen ? 'Unfreeze account' : 'Freeze account',
        copy: isFrozen
          ? 'This account will be reinstated and can transact again.'
          : 'This account will be immediately blocked from sending or receiving funds.',
        action: async (reason) => {
          const fn = isFrozen ? unfreezeAccount : freezeAccount;
          return fn(accountId, reason);
        },
        onSuccess: () => openDrawer(state.activeUserId),
      });
    });
  });

  $('#save-permissions-btn').addEventListener('click', () => {
    openConfirmModal({
      title: 'Save permissions',
      copy: 'This updates what this customer is allowed to do.',
      action: (reason) => {
        const collected = {};
        PERMISSION_FIELDS.forEach(([key]) => {
          collected[key] = $(`[data-permission-field="${key}"]`, $('#user-drawer-body')).checked;
        });
        return saveCustomerPermissions(state.activeUserId, collected, reason);
      },
      onSuccess: () => openDrawer(state.activeUserId),
    });
  });

  $('#save-overrides-btn').addEventListener('click', () => {
    openConfirmModal({
      title: 'Save limit overrides',
      copy: "This changes this customer's transfer/transaction limits.",
      action: (reason) => {
        let parsed;
        try {
          parsed = JSON.parse($('#limit-overrides-json').value);
        } catch {
          return Promise.resolve({ error: 'Invalid JSON — check for a trailing comma or missing quote.' });
        }
        return saveCustomerLimitOverrides(state.activeUserId, parsed, reason);
      },
      onSuccess: () => openDrawer(state.activeUserId),
    });
  });
}

/* -----------------------------------------------------------
   Shared confirmation modal — reused by any destructive action
   on this page (currently freeze/unfreeze, save permissions, save
   limit overrides; admin-cards.html / admin-transactions.html can
   copy this same block).
   ----------------------------------------------------------- */
function wireConfirmModal() {
  const overlay = $('#confirm-modal');

  $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', () => closeConfirmModal()));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeConfirmModal();
  });

  $('#confirm-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.pendingAction) return;

    const reasonField = $('#confirm-modal-reason');
    const errorEl = $('#confirm-modal-error');
    const reason = reasonField.value.trim();

    if (!reason) {
      errorEl.textContent = 'A reason is required.';
      errorEl.style.display = 'block';
      return;
    }

    const submitBtn = $('#confirm-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Working…';

    const { error } = await state.pendingAction.action(reason);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm';

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      return;
    }

    showToast('Done.', 'success');
    const onSuccess = state.pendingAction.onSuccess;
    closeConfirmModal();
    if (onSuccess) onSuccess();
  });
}

function openConfirmModal({ title, copy, action, onSuccess }) {
  state.pendingAction = { action, onSuccess };
  $('#confirm-modal-title').textContent = title;
  $('#confirm-modal-copy').textContent = copy;
  $('#confirm-modal-reason').value = '';
  $('#confirm-modal-error').style.display = 'none';
  $('#confirm-modal').setAttribute('aria-hidden', 'false');
}

function closeConfirmModal() {
  $('#confirm-modal').setAttribute('aria-hidden', 'true');
  state.pendingAction = null;
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
