/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-policy.js

   CHANGE LOG (this revision)
   ---------------------------
   - Customer permission toggles were completely disconnected from
     the database. 012_extend_customer_permissions.sql's own header
     documents a PERMISSION_KEY_MAP this file was supposed to have
     ("transfers -> can_transfer", etc.) but never actually
     contained — the toggles read and wrote the 13 UI names
     (transfers, international_transfers, ...) directly as JSON
     keys. Loading always showed every toggle unchecked, because
     permissions?.transfers never matched the real can_transfer
     column; saving always failed outright, because
     admin_save_customer_permissions()'s allow-list only recognizes
     can_* names and raises 'Unknown permission field: %' on
     anything else. Added the actual PERMISSION_KEY_MAP (13 entries,
     taken from the migration's documented mapping) and
     applyPermissionsToToggles(), used both when loading a customer
     and after a successful save — the latter reconciles the
     toggles against the row admin_save_customer_permissions()
     actually returns (it RETURNS the full row, not just success),
     rather than assuming the clicked state persisted as-is.
   - Account status was going stale after any restriction action.
     The "Freeze customer" / "Unfreeze customer" / "Suspend
     customer" / "Close account" chips call performRestrictionAction(),
     which posts to a single server-side dispatcher RPC
     (admin_restriction_action) — but the previous revision only
     re-fetched restriction *history* after a chip action succeeded,
     never the customer's actual account_status. So freezing a
     customer would work server-side and log correctly, but the
     status select at the top of the panel — and the customer's
     record in memory — kept showing whatever status was loaded
     before the click, until you re-searched them from scratch.
     Added syncCustomerStatus(), which re-fetches the customer via
     getUserDetail() (the same helper the deep-link flow already
     uses) and reapplies profile.account_status to both
     selectedCustomer and the UI. It's now called after every
     restriction action and after the manual "Save status" button,
     instead of trusting the value assumed going in.
   - Added a non-editable status badge next to the customer's name
     (admin-status-badge, data-customer-status-badge) so status is
     visible at a glance without opening the "Account status"
     dropdown — matches the status-pill shown per row in the
     customer search results, which the selected-customer panel
     didn't have before. Styling lives in admin-policy.css, keyed
     off a data-status attribute so it doesn't depend on guessing
     status-pill modifier classes from components.css.

   STILL OPEN — NOT FIXED HERE
   ---------------------------
   The "Access & sessions" and "Disable services" restriction chips
   (lock_online_banking, lock_mobile_banking, disable_transfers,
   disable_investments, disable_cards, disable_loans,
   disable_withdrawals, disable_deposits, disable_statements,
   disable_notifications, force_logout, require_password_reset,
   require_new_kyc, reset_failed_login_counter, clear_device_list)
   all route through the same admin_restriction_action RPC as the
   account-state actions, but I haven't seen that function's SQL —
   only that it's a single dispatcher keyed on the action string.
   I don't know what column(s) it writes for these (a boolean per
   service on user_permissions? a separate user_restrictions table?
   something on user_profiles?), so there's currently no way to
   show "online banking is locked" or "transfers are disabled" back
   in the UI, and I'm not willing to invent a schema to display
   against. Needed to finish this: the SQL definition of
   admin_restriction_action() (likely alongside admin_freeze_account/
   admin_unfreeze_account in admin_schema.sql or a migration file).

   CHANGE LOG (previous revision, kept for context)
   ---------------------------
   - Implemented the ?customer_id=<id> deep link from
     admin-users.html's drawer. The previous revision's header
     comment claimed this file "reads that query param on load,
     switches to its Customer tab, and loads the customer
     automatically" — but no such code existed anywhere in this
     file. That's why clicking "Manage permissions & limits" on a
     user just opened this page on the Global policies tab with
     nothing selected. Added loadCustomerFromQueryParam(), wired
     into init(), which:
       1. reads customer_id from the URL,
       2. programmatically activates the Customer tab,
       3. fetches the profile via getUserDetail() (the same admin.js
          helper admin-users.js already uses for its drawer), and
       4. hands it to the existing loadCustomerPanel() so the rest
          of the tab (permissions, overrides, restriction actions,
          restriction history) populates exactly as it does for a
          manually-searched customer.

   CHANGE LOG (two revisions ago, kept for context)
   ---------------------------
   - savePolicyGroup / saveCustomerPermissions / saveCustomerLimitOverrides
     were passing admin.user.id into the reason parameter — all
     three RPCs get the admin's identity server-side via auth.uid(),
     so that UUID was landing in the reason column instead of an
     actual explanation. Each now prompts for a real reason string
     (same window.prompt() pattern initAccountStatusSave already
     used correctly).
   - applyValuesToForm(form, data?.values) → data?.policy_values
     (the real column name on bank_policies).
   - overrides?.values?.[key] → overrides?.override_values?.[key]
     (the real column name on user_limit_overrides) in
     loadCustomerPanel().
   - Boot sequence now calls initAdminLayout() instead of manually
     poking [data-admin-name]/[data-admin-role] and relying on the
     page's bare components.js/admin-layout.js script tags to
     inject the navbar as a side effect — see admin-layout.js's own
     header comment for why that side-effect injection doesn't
     actually work at pages/admin/ depth.
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import {
  getPolicyGroup, savePolicyGroup, getPolicyChangeHistory,
  searchCustomers, getCustomerPermissions, saveCustomerPermissions,
  getCustomerLimitOverrides, saveCustomerLimitOverrides,
  updateAccountStatus, performRestrictionAction, getCustomerRestrictionHistory,
  getUserDetail,
} from '../../supabase/admin.js';
import { debounce, getInitials } from '../../assets/js/utils.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

/**
 * Translates the 13 UI toggle names (admin-policy.html's
 * data-permission attributes) to the real user_permissions column
 * names admin_save_customer_permissions() actually accepts —
 * per the mapping documented in
 * 012_extend_customer_permissions.sql's header comment. Without
 * this, every toggle loaded unchecked (permissions?.[uiKey] never
 * matched a real column) and every save was rejected outright
 * ('Unknown permission field: %') since the RPC's allow-list only
 * knows the can_* names.
 */
const PERMISSION_KEY_MAP = {
  transfers: 'can_transfer',
  international_transfers: 'can_international_transfer',
  internal_transfers: 'can_internal_transfer',
  card_payments: 'can_card_payment',
  atm_withdrawals: 'can_atm_withdrawal',
  mobile_banking: 'can_mobile_banking',
  online_banking: 'can_online_banking',
  bill_payments: 'can_bill_payment',
  investments: 'can_invest',
  loans: 'can_apply_loan',
  statement_downloads: 'can_download_statement',
  profile_updates: 'can_update_profile',
  beneficiary_creation: 'can_add_beneficiary',
};

/**
 * Sets every permission toggle from a real user_permissions row
 * (real column names in, UI toggles out). Used both after loading
 * a customer and after a save, so the checkboxes always reflect
 * whatever Postgres actually has — not just what was clicked.
 */
function applyPermissionsToToggles(permissions) {
  $$('#customer-permission-list .admin-toggle-row').forEach((row) => {
    const column = PERMISSION_KEY_MAP[row.dataset.permission];
    const checkbox = $('input', row);
    checkbox.checked = column ? Boolean(permissions?.[column]) : false;
  });
}

let admin = null;
let selectedCustomer = null;
let pendingRestriction = null; // { action, label } while the confirm modal is open

/* -----------------------------------------------------------
   Toast (same small helper pattern as settings.js)
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
   Tab navigation
   ----------------------------------------------------------- */
function initTabs() {
  const links = $$('.admin-tab-link');
  const panels = $$('.admin-tab-panel');

  links.forEach((link) => {
    link.addEventListener('click', () => {
      const tab = link.dataset.tab;
      links.forEach((l) => l.classList.toggle('is-active', l === link));
      panels.forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
      if (tab === 'history' && !panels.find((p) => p.dataset.panel === 'history').dataset.loaded) {
        loadPolicyHistory();
      }
    });
  });
}

/* -----------------------------------------------------------
   Global policy cards
   ----------------------------------------------------------- */
function formToValues(form) {
  const values = {};
  $$('input, select, textarea', form).forEach((field) => {
    if (!field.name) return;
    if (field.type === 'checkbox') { values[field.name] = field.checked; return; }
    if (field.multiple) { values[field.name] = Array.from(field.selectedOptions).map((o) => o.value); return; }
    values[field.name] = field.value === '' ? null : field.value;
  });
  return values;
}

function applyValuesToForm(form, values) {
  if (!values) return;
  $$('input, select, textarea', form).forEach((field) => {
    if (!field.name || !(field.name in values)) return;
    const value = values[field.name];
    if (field.type === 'checkbox') { field.checked = Boolean(value); return; }
    if (field.multiple && Array.isArray(value)) {
      Array.from(field.options).forEach((o) => { o.selected = value.includes(o.value); });
      return;
    }
    field.value = value ?? '';
  });
}

async function loadPolicyCards() {
  const forms = $$('.admin-policy-card');
  await Promise.all(forms.map(async (form) => {
    const group = form.dataset.policyGroup;
    const { data, error } = await getPolicyGroup(group);
    if (error) { console.warn(`[Meridian Admin] Could not load ${group}:`, error); return; }
    applyValuesToForm(form, data?.policy_values);
  }));
}

function initPolicyCardForms() {
  $$('.admin-policy-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const group = form.dataset.policyGroup;
      const groupLabel = form.querySelector('h2').textContent;
      const reason = window.prompt(`Reason for updating "${groupLabel}"?`);
      if (!reason) return;

      const values = formToValues(form);
      const submitBtn = $('button[type="submit"]', form);
      const errorEl = $('[data-group-error]', form);
      const statusEl = $('[data-group-status]', form);
      errorEl.textContent = '';
      setButtonLoading(submitBtn, true);

      const { error } = await savePolicyGroup(group, values, reason);

      setButtonLoading(submitBtn, false);

      if (error) {
        errorEl.textContent = error;
        return;
      }
      statusEl.hidden = false;
      setTimeout(() => { statusEl.hidden = true; }, 2500);
      showToast(`${groupLabel} saved.`);
    });
  });
}

/* -----------------------------------------------------------
   Policy change history tab
   ----------------------------------------------------------- */
async function loadPolicyHistory() {
  const body = $('#policy-history-body');
  const panel = $('.admin-tab-panel[data-panel="history"]');
  const { data, error } = await getPolicyChangeHistory({ limit: 50 });

  if (error || !data?.length) {
    body.innerHTML = '<tr><td colspan="6" class="statement-table-empty">No policy changes recorded yet.</td></tr>';
    panel.dataset.loaded = 'true';
    return;
  }

  body.innerHTML = data.map((row) => `
    <tr>
      <td>${new Date(row.changed_at).toLocaleString('en-US')}</td>
      <td>${row.admin ? `${row.admin.first_name} ${row.admin.last_name}` : '—'}</td>
      <td>${row.policy_group}</td>
      <td>${row.field}</td>
      <td class="mono">${row.previous_value ?? '—'}</td>
      <td class="mono">${row.new_value ?? '—'}</td>
    </tr>
  `).join('');
  panel.dataset.loaded = 'true';
}

/* -----------------------------------------------------------
   Customer search
   ----------------------------------------------------------- */
function initCustomerSearch() {
  const input = $('#customer-search-input');
  const results = $('#customer-search-results');
  if (!input) return;

  const runSearch = debounce(async () => {
    const query = input.value.trim();
    if (query.length < 2) { results.hidden = true; results.innerHTML = ''; return; }

    const { data, error } = await searchCustomers(query);
    if (error || !data.length) {
      results.innerHTML = '<li class="admin-search-empty">No matching customers.</li>';
      results.hidden = false;
      return;
    }

    results.innerHTML = data.map((c) => `
      <li data-customer-id="${c.id}">
        <span class="avatar-initial avatar-initial--sm">${getInitials(`${c.first_name} ${c.last_name}`)}</span>
        <div>
          <strong>${c.first_name} ${c.last_name}</strong>
          <span>${c.email}</span>
        </div>
        <span class="status-pill">${c.account_status || 'Active'}</span>
      </li>
    `).join('');
    results.hidden = false;

    $$('li[data-customer-id]', results).forEach((li) => {
      li.addEventListener('click', () => {
        const found = data.find((c) => c.id === li.dataset.customerId);
        results.hidden = true;
        input.value = `${found.first_name} ${found.last_name}`;
        loadCustomerPanel(found);
      });
    });
  }, 300);

  input.addEventListener('input', runSearch);
  document.addEventListener('click', (event) => {
    if (!results.contains(event.target) && event.target !== input) results.hidden = true;
  });
}

/* -----------------------------------------------------------
   Selected customer panel
   ----------------------------------------------------------- */

/**
 * Renders the account_status badge next to the customer's name.
 * Purely presentational — driven off a data-status attribute so
 * the coloring lives in admin-policy.css and doesn't depend on
 * guessing status-pill modifier classes from components.css,
 * which this file has no visibility into.
 */
function renderCustomerStatusBadge(status) {
  const badge = $('[data-customer-status-badge]');
  if (!badge) return;
  const value = status || 'Active';
  badge.textContent = value;
  badge.dataset.status = value;
}

/**
 * Re-fetches the customer's real profile and reapplies
 * account_status to both selectedCustomer and the UI (the status
 * select + the badge). Called after every restriction action and
 * after the manual status save, instead of trusting whatever value
 * was true before the action ran — the account_status column is
 * the one thing about this customer we can currently verify, since
 * admin_set_account_status / the restriction dispatcher are RPCs
 * whose return values this file doesn't rely on.
 */
async function syncCustomerStatus(userId) {
  const { data, error } = await getUserDetail(userId);
  if (error || !data?.profile) return;

  const status = data.profile.account_status || 'Active';
  if (selectedCustomer && selectedCustomer.id === userId) {
    selectedCustomer.account_status = status;
  }
  const select = $('#customer-account-status');
  if (select) select.value = status;
  renderCustomerStatusBadge(status);
}

async function loadCustomerPanel(customer) {
  selectedCustomer = customer;

  $('#customer-panel-empty').hidden = true;
  const panel = $('#customer-panel');
  panel.hidden = false;

  $('[data-customer-avatar]').textContent = getInitials(`${customer.first_name} ${customer.last_name}`);
  $('[data-customer-name]').textContent = `${customer.first_name} ${customer.last_name}`;
  $('[data-customer-email]').textContent = customer.email;
  $('[data-customer-meta]').textContent = customer.created_at
    ? `Customer since ${new Date(customer.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
    : '';
  $('#customer-account-status').value = customer.account_status || 'Active';
  renderCustomerStatusBadge(customer.account_status);

  const [{ data: permissions }, { data: overrides }, { data: history }] = await Promise.all([
    getCustomerPermissions(customer.id),
    getCustomerLimitOverrides(customer.id),
    getCustomerRestrictionHistory(customer.id),
  ]);

  applyPermissionsToToggles(permissions);

  const panelScope = $('#customer-panel');
  $$('[name$="_override"]', panelScope).forEach((field) => {
    const key = field.name.replace('_override', '');
    field.value = overrides?.override_values?.[key] ?? '';
  });

  renderRestrictionHistory(history);

  // Belt-and-suspenders: reconcile against the live row in case the
  // customer object we were handed (from search results, or the
  // deep-link profile) is even slightly stale.
  syncCustomerStatus(customer.id);
}

function renderRestrictionHistory(rows) {
  const body = $('#customer-restriction-history tbody');
  if (!rows?.length) {
    body.innerHTML = '<tr><td colspan="4" class="statement-table-empty">No restriction history for this customer yet.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${new Date(row.performed_at).toLocaleString('en-US')}</td>
      <td>${row.action.replace(/_/g, ' ')}</td>
      <td>${row.admin ? `${row.admin.first_name} ${row.admin.last_name}` : '—'}</td>
      <td>${row.reason || '—'}</td>
    </tr>
  `).join('');
}

function initAccountStatusSave() {
  $('#save-account-status-btn').addEventListener('click', async () => {
    if (!selectedCustomer) return;
    const status = $('#customer-account-status').value;
    const reason = window.prompt(`Reason for changing status to "${status}"?`);
    if (!reason) return;

    const btn = $('#save-account-status-btn');
    setButtonLoading(btn, true);
    const { error } = await updateAccountStatus(selectedCustomer.id, status, reason);
    setButtonLoading(btn, false);

    if (error) { showToast(error, 'error'); return; }
    await syncCustomerStatus(selectedCustomer.id);
    showToast('Account status updated.');
  });
}

function initPermissionsSave() {
  $('#save-permissions-btn').addEventListener('click', async () => {
    if (!selectedCustomer) return;
    const reason = window.prompt('Reason for updating this customer\'s permissions?');
    if (!reason) return;

    const permissions = {};
    $$('#customer-permission-list .admin-toggle-row').forEach((row) => {
      const column = PERMISSION_KEY_MAP[row.dataset.permission];
      if (column) permissions[column] = $('input', row).checked;
    });

    const btn = $('#save-permissions-btn');
    const errorEl = $('#customer-permission-list').closest('.admin-card').querySelector('[data-group-error]');
    errorEl.textContent = '';
    setButtonLoading(btn, true);

    const { data, error } = await saveCustomerPermissions(selectedCustomer.id, permissions, reason);

    setButtonLoading(btn, false);
    if (error) { errorEl.textContent = error; return; }
    // admin_save_customer_permissions() returns the actual saved
    // row (real column names) — reconcile the toggles against it
    // rather than assuming the click state persisted as-is.
    if (data) applyPermissionsToToggles(data);
    showToast('Permissions saved.');
  });
}

function initOverridesSave() {
  $('#save-overrides-btn').addEventListener('click', async () => {
    if (!selectedCustomer) return;
    const reason = window.prompt('Reason for updating this customer\'s limit overrides?');
    if (!reason) return;

    const panel = $('#customer-panel');
    const overrides = {};
    $$('[name$="_override"]', panel).forEach((field) => {
      const key = field.name.replace('_override', '');
      if (field.value !== '') overrides[key] = field.value;
    });

    const btn = $('#save-overrides-btn');
    setButtonLoading(btn, true);
    const { error } = await saveCustomerLimitOverrides(selectedCustomer.id, overrides, reason);
    setButtonLoading(btn, false);

    if (error) { showToast(error, 'error'); return; }
    showToast('Limit overrides saved.');
  });
}

/* -----------------------------------------------------------
   Restriction action chips + confirm modal
   ----------------------------------------------------------- */

// Actions that plausibly touch user_profiles.account_status server
// side — worth an explicit note here since it's the only signal we
// have that syncCustomerStatus() is meaningful to call. It's called
// after EVERY action below regardless (cheap, and harmless for the
// lock/disable actions that don't touch status), rather than trying
// to guess which ones matter from the action name alone.
function initRestrictionActions() {
  const modal = $('#restriction-confirm-modal');
  const form = $('#restriction-confirm-form');
  const errorEl = $('#restriction-modal-error');

  function openModal(action, label) {
    if (!selectedCustomer) return;
    pendingRestriction = { action, label };
    $('#restriction-modal-title').textContent = label;
    $('#restriction-modal-body').textContent =
      `This will run "${label}" on ${selectedCustomer.first_name} ${selectedCustomer.last_name} immediately and log it to the audit trail.`;
    errorEl.textContent = '';
    form.reset();
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
  }

  function closeModal() {
    modal.classList.remove('is-open');
    setTimeout(() => { modal.hidden = true; }, 200);
    pendingRestriction = null;
  }

  $$('.admin-action-chip').forEach((chip) => {
    chip.addEventListener('click', () => openModal(chip.dataset.action, chip.textContent.trim()));
  });

  $('.modal-close', modal).addEventListener('click', closeModal);
  $('.modal-cancel', modal).addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingRestriction || !selectedCustomer) return;

    const reason = form.elements.reason.value.trim();
    const submitBtn = $('#restriction-confirm-submit');
    setButtonLoading(submitBtn, true);

    const { error } = await performRestrictionAction(pendingRestriction.action, selectedCustomer.id, reason);

    setButtonLoading(submitBtn, false);

    if (error) { errorEl.textContent = error; return; }

    showToast(`${pendingRestriction.label} applied.`);
    closeModal();

    const customerId = selectedCustomer.id;
    const { data: history } = await getCustomerRestrictionHistory(customerId);
    renderRestrictionHistory(history);
    await syncCustomerStatus(customerId);
  });
}

/* -----------------------------------------------------------
   Deep link from admin-users.html's drawer:
   admin-policy.html?customer_id=<id>

   Activates the Customer tab and loads that customer's panel
   automatically, so "Manage permissions & limits" on a user
   actually lands you where it says it will.
   ----------------------------------------------------------- */
async function loadCustomerFromQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const customerId = params.get('customer_id');
  if (!customerId) return;

  const customerTabBtn = $('.admin-tab-link[data-tab="customer"]');
  if (customerTabBtn) customerTabBtn.click();

  const { data, error } = await getUserDetail(customerId);
  if (error || !data?.profile) {
    showToast('Could not load that customer.', 'error');
    return;
  }

  const { profile } = data;

  const searchInput = $('#customer-search-input');
  if (searchInput) searchInput.value = `${profile.first_name || ''} ${profile.last_name || ''}`.trim();

  await loadCustomerPanel({
    id: profile.id,
    first_name: profile.first_name,
    last_name: profile.last_name,
    email: profile.email,
    account_status: profile.account_status,
    created_at: profile.created_at,
  });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  admin = await requireAdmin();
  if (!admin) return;

  initAdminLayout(admin, { pageTitle: 'Policy & Permissions' });

  initTabs();
  initPolicyCardForms();
  initCustomerSearch();
  initAccountStatusSave();
  initPermissionsSave();
  initOverridesSave();
  initRestrictionActions();

  loadPolicyCards();
  loadCustomerFromQueryParam();
})();
