/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-dashboard.js

   First page every admin sees, and the reference implementation
   for the requireAdmin() → initAdminLayout() boot sequence every
   other admin page script follows:

     const admin = await requireAdmin();
     if (!admin) return;
     await initAdminLayout(admin, { pageTitle: '...' });
     // ...page-specific data loading below

   KPI cards are real numbers from supabase/admin.js's
   getDashboardStats(), not decoration — each one links straight
   into the filtered view of the page it summarizes (per the
   architecture doc's dashboard section), e.g. clicking
   "Pending KYC" goes to admin-kyc.html?status=pending.
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { getDashboardStats, listAdminAuditLog } from '../../supabase/admin.js';

const $ = (selector) => document.querySelector(selector);

const CURRENCY_SYMBOLS = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', SGD: 'S$', JPY: '\u00a5', NGN: '\u20a6', CAD: 'C$', AUD: 'A$', CHF: 'CHF' };
const currencySymbol = (code) => CURRENCY_SYMBOLS[code] || (code ? `${code} ` : '');
const formatAmount = (value) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const formatCount = (value) => (value === null || value === undefined ? '\u2014' : Number(value).toLocaleString('en-US'));

/* -----------------------------------------------------------
   KPI card definitions
   -----------------------------------------------------------
   Each entry knows how to read its own value out of the stats
   object and where it links. Kept as data rather than six
   hand-written <div> blocks so adding a seventh KPI later is a
   one-line change, not a copy-paste.
   ----------------------------------------------------------- */
function buildKpiCards(stats) {
  const balanceLines = Object.entries(stats.balanceByCurrency || {})
    .sort(([, a], [, b]) => b - a)
    .map(([currency, amount]) => `${currencySymbol(currency)}${formatAmount(amount)}`)
    .join(' \u00b7 ') || '\u2014';

  return [
    {
      label: 'Total users',
      value: formatCount(stats.totalUsers),
      href: 'admin-users.html',
    },
    {
      label: 'Total balance',
      value: balanceLines,
      valueIsText: true,
      href: 'admin-reports.html',
    },
    {
      label: 'Transactions today',
      value: formatCount(stats.transactionsToday),
      href: 'admin-transactions.html?range=today',
    },
    {
      label: 'Pending KYC',
      value: formatCount(stats.pendingKyc),
      href: 'admin-kyc.html?status=pending',
      emphasize: stats.pendingKyc > 0,
    },
    {
      label: 'Open support tickets',
      value: formatCount(stats.openTickets),
      href: 'admin-support.html?status=open',
      emphasize: stats.openTickets > 0,
    },
    {
      label: 'Active risk flags',
      value: stats.activeRiskFlags === null ? 'No data source yet' : formatCount(stats.activeRiskFlags),
      valueIsText: stats.activeRiskFlags === null,
      href: stats.activeRiskFlags === null ? null : 'admin-risk.html',
      muted: stats.activeRiskFlags === null,
    },
  ];
}

function renderKpiCards(stats) {
  const grid = $('#kpi-grid');
  const cards = buildKpiCards(stats);

  grid.innerHTML = cards.map((card) => {
    const tag = card.href ? 'a' : 'div';
    const hrefAttr = card.href ? `href="${card.href}"` : '';
    return `
      <${tag} ${hrefAttr} class="admin-kpi-card${card.emphasize ? ' admin-kpi-card--emphasize' : ''}${card.muted ? ' admin-kpi-card--muted' : ''}">
        <span class="admin-kpi-label">${card.label}</span>
        <span class="admin-kpi-value${card.valueIsText ? ' admin-kpi-value--text' : ''}">${card.value}</span>
      </${tag}>
    `;
  }).join('');
}

function showKpiError(message) {
  const grid = $('#kpi-grid');
  const errorEl = $('#kpi-error');
  grid.innerHTML = '';
  errorEl.textContent = message;
  errorEl.hidden = false;
}

/* -----------------------------------------------------------
   Recent admin activity
   ----------------------------------------------------------- */
const ACTION_LABELS = {
  freeze_account: 'froze an account',
  unfreeze_account: 'unfroze an account',
  approve_kyc: 'approved KYC for',
  reject_kyc: 'rejected KYC for',
  reverse_transaction: 'reversed a transaction',
  set_card_status: 'updated a card\u2019s status',
  set_user_role: 'changed a user\u2019s role',
};

function describeAction(row) {
  return ACTION_LABELS[row.action] || row.action;
}

function renderRecentActivity(rows) {
  const list = $('#recent-activity-list');

  if (!rows.length) {
    list.innerHTML = '<li class="admin-activity-empty">No admin actions recorded yet.</li>';
    return;
  }

  list.innerHTML = rows.map((row) => `
    <li class="admin-activity-item">
      <span class="admin-activity-desc">${describeAction(row)}${row.reason ? ` \u2014 ${escapeHtml(row.reason)}` : ''}</span>
      <span class="admin-activity-meta">${new Date(row.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
    </li>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  await initAdminLayout(admin, { pageTitle: 'Overview' });

  const [statsResult, activityResult] = await Promise.all([
    getDashboardStats(),
    listAdminAuditLog({ page: 1, pageSize: 8 }),
  ]);

  if (statsResult.error) {
    showKpiError(statsResult.error);
  } else {
    renderKpiCards(statsResult.data);
  }

  if (!activityResult.error) {
    renderRecentActivity(activityResult.data.rows);
  }
})();
