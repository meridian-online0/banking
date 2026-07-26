/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-policy.js

   CHANGE LOG (this revision)
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

   STILL OPEN — NOT FIXED HERE
   ---------------------------
   The 13 permission keys used below (transfers,
   international_transfers, internal_transfers, card_payments,
   atm_withdrawals, mobile_banking, online_banking, bill_payments,
   investments, loans, statement_downloads, profile_updates,
   beneficiary_creation) do NOT match the real user_permissions
   columns (can_transfer, can_receive, can_withdraw, can_deposit,
   can_use_card, can_request_card, can_open_account,
   can_close_account, can_add_beneficiary,
   can_international_transfer, can_apply_loan, can_invest,
   can_contact_support). Submitting these as-is will make
   admin_save_customer_permissions() reject every key. This is a
   product decision (extend the schema vs. trim the UI to the real
   13), not a typo — left unchanged pending that decision.
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import {
  getPolicyGroup, savePolicyGroup, getPolicyChangeHistory,
  searchCustomers, getCustomerPermissions, saveCustomerPermissions,
  getCustomerLimitOverrides, saveCustomerLimitOverrides,
  updateAccountStatus, performRestrictionAction, getCustomerRestrictionHistory,
} from '../../supabase/admin.js';
import { debounce, getInitials } from '../../assets/js/utils.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

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

  const [{ data: permissions }, { data: overrides }, { data: history }] = await Promise.all([
    getCustomerPermissions(customer.id),
    getCustomerLimitOverrides(customer.id),
    getCustomerRestrictionHistory(customer.id),
  ]);

  $$('#customer-permission-list .admin-toggle-row').forEach((row) => {
    const key = row.dataset.permission;
    const checkbox = $('input', row);
    checkbox.checked = Boolean(permissions?.[key]);
  });

  const panelScope = $('#customer-panel');
  $$('[name$="_override"]', panelScope).forEach((field) => {
    const key = field.name.replace('_override', '');
    field.value = overrides?.override_values?.[key] ?? '';
  });

  renderRestrictionHistory(history);
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
    selectedCustomer.account_status = status;
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
      permissions[row.dataset.permission] = $('input', row).checked;
    });

    const btn = $('#save-permissions-btn');
    const errorEl = $('#customer-permission-list').closest('.admin-card').querySelector('[data-group-error]');
    errorEl.textContent = '';
    setButtonLoading(btn, true);

    const { error } = await saveCustomerPermissions(selectedCustomer.id, permissions, reason);

    setButtonLoading(btn, false);
    if (error) { errorEl.textContent = error; return; }
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
    const { data: history } = await getCustomerRestrictionHistory(selectedCustomer.id);
    renderRestrictionHistory(history);
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
})();
