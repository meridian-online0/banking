/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-settings.js

   Superadmin-only — see requireAdmin({ roles: ['superadmin'] })
   below. admin_set_user_role() also enforces this server-side, so
   this client check is UX politeness, not the real boundary.
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { listAdminUsers, listUsers, setUserRole } from '../../supabase/admin.js';
import { showToast } from '../../assets/js/notifications.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let currentAdmin = null;
let pendingTarget = null; // { id, name }

const ROLE_LABELS = { customer: 'Customer', support: 'Support', admin: 'Admin', superadmin: 'Superadmin' };
const ROLE_BADGE_CLASSES = { support: 'admin-role-badge--support', admin: 'admin-role-badge--admin', superadmin: 'admin-role-badge--superadmin' };

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Unnamed';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* -----------------------------------------------------------
   Team members table
   ----------------------------------------------------------- */
async function loadTeam() {
  const tbody = $('#team-table-body');
  tbody.innerHTML = '<tr class="admin-table-skeleton-row"><td colspan="4">Loading team…</td></tr>';

  const { data, error } = await listAdminUsers();

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-table-empty">${escapeHtml(error)}</td></tr>`;
    return;
  }

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="admin-table-empty">No team members found.</td></tr>';
    $('#team-count').textContent = '';
    return;
  }

  $('#team-count').textContent = `${data.length} member${data.length === 1 ? '' : 's'}`;
  tbody.innerHTML = '';
  data.forEach((user) => tbody.appendChild(renderTeamRow(user)));
}

function renderTeamRow(user) {
  const tr = document.createElement('tr');
  const isSelf = currentAdmin && user.id === currentAdmin.user.id;

  tr.innerHTML = `
    <td>${escapeHtml(displayName(user))}${isSelf ? ' <span class="admin-card-chip">You</span>' : ''}</td>
    <td>${escapeHtml(user.email || '\u2014')}</td>
    <td><span class="admin-role-badge ${ROLE_BADGE_CLASSES[user.role] || ''}">${ROLE_LABELS[user.role] || user.role}</span></td>
    <td class="admin-table-actions">
      <button type="button" class="admin-btn admin-btn--ghost admin-btn-sm" data-change-role>Change role</button>
    </td>
  `;

  tr.querySelector('[data-change-role]').addEventListener('click', () => {
    openRoleModal({ id: user.id, name: displayName(user) }, user.role);
  });

  return tr;
}

/* -----------------------------------------------------------
   Promote — search any user, grant a role
   ----------------------------------------------------------- */
let searchDebounce;
$('#promote-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const query = e.target.value.trim();
  if (!query) {
    $('#promote-results').innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => runPromoteSearch(query), 300);
});

async function runPromoteSearch(query) {
  const wrap = $('#promote-results');
  wrap.innerHTML = '<p class="admin-table-empty">Searching…</p>';

  const { data, error } = await listUsers({ search: query, pageSize: 10 });

  if (error) {
    wrap.innerHTML = `<p class="admin-table-empty">${escapeHtml(error)}</p>`;
    return;
  }

  if (!data.rows.length) {
    wrap.innerHTML = '<p class="admin-table-empty">No matching users.</p>';
    return;
  }

  wrap.innerHTML = '';
  data.rows.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'admin-promote-row';
    row.innerHTML = `
      <div class="admin-promote-identity">
        <strong>${escapeHtml(displayName(user))}</strong>
        <span>${escapeHtml(user.email || '\u2014')} \u00b7 ${ROLE_LABELS[user.role] || user.role}</span>
      </div>
      <button type="button" class="admin-btn admin-btn--primary admin-btn-sm" data-grant>Change role</button>
    `;
    row.querySelector('[data-grant]').addEventListener('click', () => {
      openRoleModal({ id: user.id, name: displayName(user) }, user.role);
    });
    wrap.appendChild(row);
  });
}

/* -----------------------------------------------------------
   Role change modal — shared by both sections above
   ----------------------------------------------------------- */
function openRoleModal(target, currentRole) {
  pendingTarget = target;
  $('#role-modal-title').textContent = `Change role for ${target.name}`;
  $('#role-select').value = currentRole || 'customer';
  $('#role-reason').value = '';
  $('#role-reason-error').textContent = '';
  $('#role-modal').classList.add('is-open');
}

$$('[data-close-role-modal]').forEach((btn) => {
  btn.addEventListener('click', () => $('#role-modal').classList.remove('is-open'));
});

$('#role-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingTarget) return;

  const newRole = $('#role-select').value;
  const reason = $('#role-reason').value.trim();

  if (!reason) {
    $('#role-reason-error').textContent = 'A reason is required.';
    return;
  }

  if (pendingTarget.id === currentAdmin.user.id && newRole !== 'superadmin') {
    $('#role-reason-error').textContent = 'You cannot change your own role away from superadmin.';
    return;
  }

  const btn = $('#role-form button[type="submit"]');
  btn.disabled = true;

  const { error } = await setUserRole(pendingTarget.id, newRole, reason);

  btn.disabled = false;

  if (error) {
    showToast({ type: 'error', title: 'Could not change role', message: error });
    return;
  }

  $('#role-modal').classList.remove('is-open');
  showToast({ type: 'success', message: `Role updated to ${ROLE_LABELS[newRole] || newRole}.` });
  pendingTarget = null;

  loadTeam();
  $('#promote-search').value = '';
  $('#promote-results').innerHTML = '';
});

/* -----------------------------------------------------------
   Init — superadmin only
   ----------------------------------------------------------- */
(async function init() {
  const admin = await requireAdmin({ roles: ['superadmin'] });
  if (!admin) return;
  currentAdmin = admin;

  await initAdminLayout(admin, { pageTitle: 'Settings' });

  loadTeam();
})();
