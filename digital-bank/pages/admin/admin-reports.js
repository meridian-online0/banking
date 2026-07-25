/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-reports.js
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { getVolumeReport } from '../../supabase/admin.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const CURRENCY_SYMBOLS = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', SGD: 'S$', JPY: '\u00a5', NGN: '\u20a6', CAD: 'C$', AUD: 'A$', CHF: 'CHF' };
const currencySymbol = (code) => CURRENCY_SYMBOLS[code] || (code ? `${code} ` : '');

let lastReport = null;

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setPreset(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  $('#range-from').value = toISODate(from);
  $('#range-to').value = toISODate(to);

  $$('.admin-preset-btn').forEach((btn) => {
    btn.classList.toggle('is-active', Number(btn.dataset.days) === days);
  });
}

$$('.admin-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setPreset(Number(btn.dataset.days));
    runReport();
  });
});

$('#range-from').addEventListener('change', clearActivePreset);
$('#range-to').addEventListener('change', clearActivePreset);
function clearActivePreset() {
  $$('.admin-preset-btn').forEach((btn) => btn.classList.remove('is-active'));
}

$('#run-report-btn').addEventListener('click', runReport);

/* -----------------------------------------------------------
   Run report
   ----------------------------------------------------------- */
async function runReport() {
  const fromInput = $('#range-from').value;
  const toInput = $('#range-to').value;
  const errorEl = $('#report-error');
  errorEl.hidden = true;

  if (!fromInput || !toInput) {
    errorEl.textContent = 'Choose a start and end date.';
    errorEl.hidden = false;
    return;
  }

  const from = new Date(fromInput + 'T00:00:00').toISOString();
  const to = new Date(toInput + 'T23:59:59').toISOString();

  $('#volume-breakdown').innerHTML = '<p class="admin-table-empty">Loading…</p>';

  const { data, error } = await getVolumeReport({ from, to });

  if (error) {
    errorEl.textContent = error;
    errorEl.hidden = false;
    $('#volume-breakdown').innerHTML = '<p class="admin-table-empty">Could not load report.</p>';
    return;
  }

  lastReport = data;
  renderReport(data, fromInput, toInput);
}

function renderReport(data, fromInput, toInput) {
  const entries = Object.entries(data.byCurrency || {});
  $('#report-range-label').textContent = `${fromInput} \u2013 ${toInput}`;

  const totalVolume = entries.reduce((sum, [, v]) => sum + v.volume, 0);
  const totalFees = entries.reduce((sum, [, v]) => sum + v.fees, 0);
  const totalCount = entries.reduce((sum, [, v]) => sum + v.count, 0);

  const statCards = $$('#report-stat-row .admin-stat-value');
  statCards[0].textContent = formatAmount(totalVolume);
  statCards[1].textContent = formatAmount(totalFees);
  statCards[2].textContent = totalCount.toLocaleString('en-US');
  statCards[3].textContent = entries.length;

  const wrap = $('#volume-breakdown');
  if (!entries.length) {
    wrap.innerHTML = '<p class="admin-table-empty">No transactions in this range.</p>';
    return;
  }

  const maxVolume = Math.max(...entries.map(([, v]) => v.volume));
  const sorted = entries.sort(([, a], [, b]) => b.volume - a.volume);

  wrap.innerHTML = sorted.map(([currency, v]) => `
    <div class="admin-currency-row">
      <span class="admin-currency-code">${currency}</span>
      <span class="admin-currency-bar-track">
        <span class="admin-currency-bar-fill" style="width: ${maxVolume ? (v.volume / maxVolume) * 100 : 0}%"></span>
      </span>
      <span class="admin-currency-volume">${currencySymbol(currency)}${formatAmount(v.volume)}</span>
      <span class="admin-currency-meta">${v.count} tx \u00b7 ${currencySymbol(currency)}${formatAmount(v.fees)} fees</span>
    </div>
  `).join('');
}

/* -----------------------------------------------------------
   CSV export — same client-side pattern settings.js already uses
   for statement export: build rows, Blob, trigger download.
   ----------------------------------------------------------- */
$('#export-csv-btn').addEventListener('click', () => {
  if (!lastReport || !Object.keys(lastReport.byCurrency || {}).length) {
    return;
  }

  const rows = [['Currency', 'Volume', 'Fees', 'Transaction count']];
  Object.entries(lastReport.byCurrency).forEach(([currency, v]) => {
    rows.push([currency, v.volume.toFixed(2), v.fees.toFixed(2), v.count]);
  });

  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-volume-report-${$('#range-from').value}-to-${$('#range-to').value}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  await initAdminLayout(admin, { pageTitle: 'Reports' });

  setPreset(30);
  runReport();
})();
