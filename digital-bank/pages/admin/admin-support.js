/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-support.js
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import {
  getSupportTicketSummary,
  listSupportTickets,
  getTicketDetail,
  listAdminUsers,
  assignTicket,
  replyToTicket,
  resolveTicket,
  reopenTicket,
} from '../../supabase/admin.js';
import { showToast } from '../../assets/js/notifications.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let currentAdmin = null;
let currentTicketId = null;
let filters = { search: '', status: '', priority: '' };
let currentPage = 1;
const PAGE_SIZE = 25;

const STATUS_LABELS = { open: 'Open', assigned: 'Assigned', resolved: 'Resolved', closed: 'Closed' };
const STATUS_CLASSES = { open: 'admin-status-pill--warning', assigned: 'admin-status-pill--neutral', resolved: 'admin-status-pill--success', closed: 'admin-status-pill--neutral' };
const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

function customerName(customer) {
  if (!customer) return 'Unknown customer';
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email || 'Unknown customer';
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* -----------------------------------------------------------
   Stat row
   ----------------------------------------------------------- */
async function loadStats() {
  const { data, error } = await getSupportTicketSummary();
  if (error) return;
  const cards = $$('#ticket-stat-row .admin-stat-value');
  cards[0].textContent = data.open;
  cards[1].textContent = data.assigned;
  cards[2].textContent = data.resolved;
  cards[3].textContent = data.closed;
}

/* -----------------------------------------------------------
   Table
   ----------------------------------------------------------- */
function renderTicketRow(ticket) {
  const tr = document.createElement('tr');
  tr.dataset.ticketId = ticket.id;
  tr.style.cursor = 'pointer';
  tr.innerHTML = `
    <td>${escapeHtml(ticket.subject)}</td>
    <td>${escapeHtml(customerName(ticket.customer))}</td>
    <td><span class="admin-status-pill">${PRIORITY_LABELS[ticket.priority] || ticket.priority}</span></td>
    <td><span class="admin-status-pill ${STATUS_CLASSES[ticket.status] || ''}">${STATUS_LABELS[ticket.status] || ticket.status}</span></td>
    <td>${ticket.assigned_admin_id ? 'Assigned' : '\u2014'}</td>
    <td>${formatDate(ticket.created_at)}</td>
  `;
  tr.addEventListener('click', () => openDrawer(ticket.id));
  return tr;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function loadTickets() {
  const tbody = $('#ticket-table-body');
  tbody.innerHTML = '<tr class="admin-table-skeleton-row"><td colspan="6">Loading tickets…</td></tr>';

  const { data, error } = await listSupportTickets({
    search: filters.search || undefined,
    status: filters.status || undefined,
    priority: filters.priority || undefined,
    page: currentPage,
    pageSize: PAGE_SIZE,
  });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table-empty">${escapeHtml(error)}</td></tr>`;
    return;
  }

  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-table-empty">No tickets match these filters.</td></tr>';
  } else {
    tbody.innerHTML = '';
    data.rows.forEach((ticket) => tbody.appendChild(renderTicketRow(ticket)));
  }

  $('#ticket-count').textContent = `${data.total} ticket${data.total === 1 ? '' : 's'}`;
  renderPagination(data.total);
}

function renderPagination(total) {
  const wrap = $('#ticket-pagination');
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
  $('#prev-page')?.addEventListener('click', () => { currentPage -= 1; loadTickets(); });
  $('#next-page')?.addEventListener('click', () => { currentPage += 1; loadTickets(); });
}

/* -----------------------------------------------------------
   Filters
   ----------------------------------------------------------- */
let searchDebounce;
$('#ticket-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    filters.search = e.target.value.trim();
    currentPage = 1;
    loadTickets();
  }, 300);
});

$('#status-filter').addEventListener('change', (e) => {
  filters.status = e.target.value;
  currentPage = 1;
  loadTickets();
});

$('#priority-filter').addEventListener('change', (e) => {
  filters.priority = e.target.value;
  currentPage = 1;
  loadTickets();
});

/* -----------------------------------------------------------
   Drawer
   ----------------------------------------------------------- */
function openDrawerShell() {
  $('#ticket-drawer-overlay').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  $('#ticket-drawer-overlay').setAttribute('aria-hidden', 'true');
  currentTicketId = null;
}

$('#drawer-close').addEventListener('click', closeDrawer);
$('#ticket-drawer-overlay').addEventListener('click', (e) => {
  if (e.target === $('#ticket-drawer-overlay')) closeDrawer();
});

function renderThread(ticket, messages) {
  const thread = $('#ticket-thread');
  const originalMsg = `
    <div class="admin-ticket-msg">
      <div class="admin-ticket-msg-meta"><span>Customer</span><span>${formatDateTime(ticket.created_at)}</span></div>
      <div>${escapeHtml(ticket.message)}</div>
    </div>
  `;
  const replyMsgs = messages.map((m) => `
    <div class="admin-ticket-msg${m.is_admin ? ' admin-ticket-msg--admin' : ''}">
      <div class="admin-ticket-msg-meta"><span>${m.is_admin ? 'Admin' : 'Customer'}</span><span>${formatDateTime(m.created_at)}</span></div>
      <div>${escapeHtml(m.body)}</div>
    </div>
  `).join('');

  thread.innerHTML = originalMsg + replyMsgs;
  thread.scrollTop = thread.scrollHeight;
}

async function populateAssignOptions(selectedId) {
  const select = $('#assign-select');
  const { data: admins, error } = await listAdminUsers();
  select.innerHTML = '<option value="">Unassigned</option>';
  if (error || !admins) return;
  admins.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Admin';
    if (a.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  });
}

async function openDrawer(ticketId) {
  currentTicketId = ticketId;
  openDrawerShell();

  $('#drawer-subject').textContent = 'Loading…';
  $('#drawer-customer').textContent = '';
  $('#ticket-thread').innerHTML = '<p class="admin-ticket-empty">Loading conversation…</p>';

  const { data, error } = await getTicketDetail(ticketId);
  if (error || !data) {
    showToast({ type: 'error', title: 'Could not load ticket', message: error || 'Try again.' });
    closeDrawer();
    return;
  }

  const { ticket, customer, messages } = data;

  $('#drawer-subject').textContent = ticket.subject;
  $('#drawer-customer').textContent = customerName(customer);
  $('#drawer-status-pill').textContent = STATUS_LABELS[ticket.status] || ticket.status;
  $('#drawer-status-pill').className = `admin-status-pill ${STATUS_CLASSES[ticket.status] || ''}`;
  $('#drawer-priority').textContent = PRIORITY_LABELS[ticket.priority] || ticket.priority;
  $('#drawer-category').textContent = ticket.category || '\u2014';

  $('#resolve-btn').hidden = ticket.status === 'resolved' || ticket.status === 'closed';
  $('#reopen-btn').hidden = !(ticket.status === 'resolved' || ticket.status === 'closed');

  renderThread(ticket, messages);
  await populateAssignOptions(ticket.assigned_admin_id);
}

/* -----------------------------------------------------------
   Assign
   ----------------------------------------------------------- */
$('#assign-btn').addEventListener('click', async () => {
  if (!currentTicketId) return;
  const adminId = $('#assign-select').value || null;
  const btn = $('#assign-btn');
  btn.disabled = true;

  const { error } = await assignTicket(currentTicketId, adminId);
  btn.disabled = false;

  if (error) {
    showToast({ type: 'error', title: 'Could not assign ticket', message: error });
    return;
  }

  showToast({ type: 'success', message: 'Ticket assigned.' });
  await openDrawer(currentTicketId);
  loadTickets();
});

/* -----------------------------------------------------------
   Reply
   ----------------------------------------------------------- */
$('#reply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentTicketId || !currentAdmin) return;

  const textarea = $('#reply-body');
  const body = textarea.value.trim();
  if (!body) return;

  const { error } = await replyToTicket(currentTicketId, currentAdmin.user.id, body);
  if (error) {
    showToast({ type: 'error', title: 'Reply failed', message: error });
    return;
  }

  textarea.value = '';
  await openDrawer(currentTicketId);
});

/* -----------------------------------------------------------
   Resolve
   ----------------------------------------------------------- */
$('#resolve-btn').addEventListener('click', () => {
  $('#resolve-modal').classList.add('is-open');
});

$$('[data-close-resolve-modal]').forEach((btn) => {
  btn.addEventListener('click', () => $('#resolve-modal').classList.remove('is-open'));
});

$('#resolve-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentTicketId) return;

  const note = $('#resolve-note').value.trim();
  const { error } = await resolveTicket(currentTicketId, note || null);

  $('#resolve-modal').classList.remove('is-open');
  $('#resolve-note').value = '';

  if (error) {
    showToast({ type: 'error', title: 'Could not resolve ticket', message: error });
    return;
  }

  showToast({ type: 'success', message: 'Ticket marked resolved.' });
  closeDrawer();
  loadTickets();
  loadStats();
});

/* -----------------------------------------------------------
   Reopen
   ----------------------------------------------------------- */
$('#reopen-btn').addEventListener('click', async () => {
  if (!currentTicketId) return;
  const { error } = await reopenTicket(currentTicketId);

  if (error) {
    showToast({ type: 'error', title: 'Could not reopen ticket', message: error });
    return;
  }

  showToast({ type: 'success', message: 'Ticket reopened.' });
  await openDrawer(currentTicketId);
  loadTickets();
  loadStats();
});

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const admin = await requireAdmin();
  if (!admin) return;
  currentAdmin = admin;

  await initAdminLayout(admin, { pageTitle: 'Support' });

  loadStats();
  loadTickets();
})();
