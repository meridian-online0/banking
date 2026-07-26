/* =============================================================
   MERIDIAN — Admin panel
   supabase/admin.js

   CHANGE LOG (this revision)
   ---------------------------
   - Added getAuditLog() as a thin shim over listAdminAuditLog(),
     since admin-approvals.js imports a `getAuditLog` that was
     never actually added to this file — that's a static import,
     so the missing export threw a SyntaxError at parse time and
     admin-approvals.js's init() never ran at all, leaving the
     page stuck on its loading skeleton forever with no on-page
     error (only a console one). This shim adapts
     listAdminAuditLog()'s real { data: { rows, total } } shape
     into the flat { data: rows, error, count } shape
     admin-approvals.js already expects, WITHOUT fabricating the
     columns that don't actually exist on admin_audit_logs
     (customer, previous_value/new_value, ip_address/browser,
     approval_status) — those still render as "—" in
     admin-approvals.js's existing fallback logic. Reconciling
     admin-approvals.js's audit tab against the real schema
     (target_table/target_id/metadata) is a separate follow-up
     pass, not done here.
     Known limitations of the shim, flagging rather than silently
     hiding: the `action` filter is applied client-side after
     fetching a page (listAdminAuditLog has no server-side action
     filter), so pagination/count can be slightly off when that
     filter is active; the `from`/`to` date filters aren't applied
     at all (listAdminAuditLog doesn't support a date range yet).
   - Everything else is unchanged from the previous revision:
     merged policy/permission/limit-override/restriction/approval
     engine; every audit-log write uses the real admin_audit_logs
     columns (target_table/target_id/metadata); savePolicyGroup,
     saveCustomerPermissions, saveCustomerLimitOverrides call
     SECURITY DEFINER RPCs from 009_admin_policy_engine.sql.

   PURPOSE
   -------
   The admin-side counterpart to supabase/database.js — every
   pages/admin/*.js page script imports from here instead of
   calling `supabase.from(...)` or `supabase.rpc(...)` directly.

   PATTERN
   -------
   Every export returns { data, error } — error is a friendly
   string or null, never a thrown exception. Mutating exports call
   SECURITY DEFINER RPCs from admin_schema.sql /
   009_admin_policy_engine.sql via wrap(supabase.rpc(...)) rather
   than `.update()`/`.delete()` directly — this file deliberately
   contains ZERO direct writes to accounts, transactions, cards,
   user_profiles.role, bank_policies, user_permissions, or
   user_limit_overrides. The one exception remains support ticket
   assignment/resolution (section 7), which admin_schema.sql calls
   out as a plain RLS-gated UPDATE rather than an RPC.

   ASSUMPTIONS FLAGGED BELOW (verify before relying on these in
   production):

     - support_tickets.status values assumed to be
       'open' | 'assigned' | 'resolved' | 'closed'.
     - KYC "pending" is read as user_profiles.account_status =
       'Pending'. admin_approve_kyc()/admin_reject_kyc() move it to
       'active'/'rejected'.
     - getUserDetail()'s cards query uses `.eq('user_id', ...)` on
       the cards table, but database.js's getCardsForAccount()
       queries cards by account_id — cards has no known user_id
       column. This likely needs to become a query over the user's
       account ids instead; not fixed here since I haven't seen
       cards' actual schema.
     - user_permissions' 13 boolean columns (in migration
       009_admin_policy_engine.sql) are a STARTER GUESS — they must
       match whatever field names admin-policy.js's checkboxes
       actually send, or admin_save_customer_permissions() will
       reject unknown keys. Reconcile before wiring up that page.
     - approval_requests has no rows inserted anywhere yet — nothing
       currently requires maker-checker sign-off. decideApproval()
       below works once something starts creating requests.
     - admin-approvals.js's audit tab still renders columns
       (Affected customer, Previous → New, IP/browser, Approval
       status) that don't exist on admin_audit_logs — see the
       getAuditLog() shim note above. Those cells will show "—"
       until that page's rendering is reconciled against the real
       target_table/target_id/metadata columns.
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

/* -----------------------------------------------------------
   wrap() — normalizes a Supabase call into { data, error }.
   ----------------------------------------------------------- */
export async function wrap(promise) {
  try {
    const { data, error } = await promise;
    if (error) {
      return { data: null, error: friendlyAdminError(error) };
    }
    return { data, error: null };
  } catch (err) {
    return { data: null, error: friendlyAdminError(err) };
  }
}

function friendlyAdminError(error) {
  const message = error?.message || 'Something went wrong. Please try again.';
  if (message.toLowerCase().includes('failed to fetch')) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (message.toLowerCase().includes('jwt')) {
    return 'Your admin session has expired. Please sign in again.';
  }
  return message;
}

export async function resolveUserId(userId) {
  if (userId) return userId;
  const { data: user } = await getCurrentUser();
  return user?.id ?? null;
}

/**
 * Every write function below that isn't already its own RPC
 * (support ticket assignment/resolution) should end up going
 * through log_admin_action() server-side. This client-side helper
 * exists only for the couple of plain-UPDATE paths (section 7)
 * that aren't RPC-wrapped; everything else logs inside its own
 * SECURITY DEFINER function and never calls this directly.
 */
async function logAdminAction({ adminId, action, targetTable, targetId = null, reason = null, metadata = {} }) {
  const { error } = await supabase.rpc('log_admin_action', {
    p_action: action,
    p_target_table: targetTable,
    p_target_id: targetId,
    p_reason: reason,
    p_metadata: metadata,
  });
  if (error) console.error('[Meridian Admin] Failed to write audit log:', error.message);
}

/* -----------------------------------------------------------
   1. Dashboard KPIs
   ----------------------------------------------------------- */

export async function getDashboardStats() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [totalUsers, balances, txToday, pendingKyc, openTickets, activeRiskFlags] = await Promise.all([
    supabase.from('user_profiles').select('id', { count: 'exact', head: true }),
    supabase.from('accounts').select('balance, currency'),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).gte('created_at', startOfToday.toISOString()),
    supabase.from('user_profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'Pending'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['open', 'assigned']),
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'active'),
  ]);

  const firstError = [totalUsers, balances, txToday, pendingKyc, openTickets, activeRiskFlags].find((r) => r.error);
  if (firstError) {
    return { data: null, error: friendlyAdminError(firstError.error) };
  }

  const balanceByCurrency = (balances.data || []).reduce((acc, row) => {
    acc[row.currency] = (acc[row.currency] || 0) + Number(row.balance || 0);
    return acc;
  }, {});

  return {
    data: {
      totalUsers: totalUsers.count ?? 0,
      balanceByCurrency,
      transactionsToday: txToday.count ?? 0,
      pendingKyc: pendingKyc.count ?? 0,
      openTickets: openTickets.count ?? 0,
      activeRiskFlags: activeRiskFlags.count ?? 0,
    },
    error: null,
  };
}

/* -----------------------------------------------------------
   2. Users — admin-users.html / admin-user-detail.html
   ----------------------------------------------------------- */
export async function listUsers({ search, status, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('user_profiles').select('*', { count: 'exact' });

  if (status) query = query.eq('account_status', status);
  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function getUserDetail(userId) {
  const [profile, accounts, cards, sessions] = await Promise.all([
    supabase.from('user_profiles').select('*').eq('id', userId).single(),
    supabase.from('accounts').select('*').eq('user_id', userId),
    supabase.from('cards').select('*').eq('user_id', userId), // see file header flag
    supabase.from('login_sessions').select('*').eq('user_id', userId).order('login_time', { ascending: false }).limit(20),
  ]);

  if (profile.error) return { data: null, error: friendlyAdminError(profile.error) };

  const accountIds = (accounts.data || []).map((a) => a.id);
  let transactions = [];
  if (accountIds.length) {
    const { data: txData } = await supabase
      .from('transactions')
      .select('*')
      .or(accountIds.map((id) => `sender_account.eq.${id}`).concat(accountIds.map((id) => `receiver_account.eq.${id}`)).join(','))
      .order('created_at', { ascending: false })
      .limit(50);
    transactions = txData || [];
  }

  return {
    data: {
      profile: profile.data,
      accounts: accounts.data || [],
      cards: cards.data || [],
      recentTransactions: transactions,
      loginSessions: sessions.data || [],
      notes: [],
    },
    error: null,
  };
}

/**
 * Matches on name/email (user_profiles) or account number
 * (accounts) — for the customer picker on admin-user-detail.html
 * / admin-policy.html.
 */
export async function searchCustomers(query) {
  const clean = query.trim();
  if (!clean) return { data: [], error: null };

  const { data: byProfile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email, account_status, avatar_url, created_at')
    .or(`first_name.ilike.%${clean}%,last_name.ilike.%${clean}%,email.ilike.%${clean}%`)
    .limit(10);

  if (profileError) return { data: [], error: friendlyAdminError(profileError) };

  const { data: byAccount } = await supabase
    .from('accounts')
    .select('user_id, account_number, user_profiles:user_id(id, first_name, last_name, email, account_status, avatar_url, created_at)')
    .ilike('account_number', `%${clean}%`)
    .limit(10);

  const merged = new Map();
  (byProfile || []).forEach((row) => merged.set(row.id, row));
  (byAccount || []).forEach((row) => {
    if (row.user_profiles) merged.set(row.user_profiles.id, row.user_profiles);
  });

  return { data: Array.from(merged.values()), error: null };
}

/* -----------------------------------------------------------
   3. Transactions — admin-transactions.html
   ----------------------------------------------------------- */

const TX_SORT_FIELDS = new Set(['amount', 'created_at']);

export async function listTransactions({
  status,
  currency,
  search,
  from: dateFrom,
  to: dateTo,
  sortField = 'created_at',
  sortDir = 'desc',
  page = 1,
  pageSize = 25,
} = {}) {
  let query = supabase.from('transactions').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (currency) query = query.eq('currency', currency);
  if (search) query = query.ilike('transaction_reference', `%${search}%`);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo);

  const field = TX_SORT_FIELDS.has(sortField) ? sortField : 'created_at';
  query = query.order(field, { ascending: sortDir === 'asc' });

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function getTransactionSummary({ status, currency, search, from: dateFrom, to: dateTo } = {}) {
  let query = supabase.from('transactions').select('amount, currency, status');

  if (status) query = query.eq('status', status);
  if (currency) query = query.eq('currency', currency);
  if (search) query = query.ilike('transaction_reference', `%${search}%`);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo);

  const { data, error } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  const volumeByCurrency = {};
  let reversedCount = 0;
  let processingCount = 0;

  for (const tx of data) {
    if (tx.status === 'Reversed') {
      reversedCount += 1;
      continue;
    }
    if (tx.status === 'Processing') processingCount += 1;
    volumeByCurrency[tx.currency] = (volumeByCurrency[tx.currency] || 0) + Number(tx.amount || 0);
  }

  return {
    data: { volumeByCurrency, count: data.length, reversedCount, processingCount },
    error: null,
  };
}

export async function reverseTransaction(transactionId, reason) {
  return wrap(supabase.rpc('admin_reverse_transaction', {
    p_transaction_id: transactionId,
    p_reason: reason,
  }));
}

/* -----------------------------------------------------------
   4. KYC queue — admin-kyc.html
   ----------------------------------------------------------- */
export async function listKycQueue({ search, page = 1, pageSize = 25 } = {}) {
  let query = supabase
    .from('user_profiles')
    .select('*', { count: 'exact' })
    .eq('account_status', 'Pending');

  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: true }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function approveKyc(userId, reason) {
  return wrap(supabase.rpc('admin_approve_kyc', { p_user_id: userId, p_reason: reason ?? null }));
}

export async function rejectKyc(userId, reason) {
  return wrap(supabase.rpc('admin_reject_kyc', { p_user_id: userId, p_reason: reason }));
}

/* -----------------------------------------------------------
   5. Cards — admin-cards.html
   ----------------------------------------------------------- */
export async function listCards({ status, type, search, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('cards').select('*', { count: 'exact' });

  if (status) query = query.eq('card_status', status);
  if (type) query = query.eq('card_type', type);
  if (search) query = query.ilike('card_number', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function getCardDetail(cardId) {
  const { data: card, error: cardError } = await supabase.from('cards').select('*').eq('id', cardId).single();
  if (cardError) return { data: null, error: friendlyAdminError(cardError) };

  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', card.account_id)
    .single();
  if (accountError) return { data: { card, account: null, holder: null }, error: null };

  const { data: holder } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email')
    .eq('id', account.user_id)
    .maybeSingle();

  return { data: { card, account, holder: holder || null }, error: null };
}

export async function getCardStatusSummary() {
  const [active, frozen, pending, cancelled] = await Promise.all([
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Active'),
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Frozen'),
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Pending'),
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Cancelled'),
  ]);

  const firstError = [active, frozen, pending, cancelled].find((r) => r.error);
  if (firstError) return { data: null, error: friendlyAdminError(firstError.error) };

  return {
    data: {
      active: active.count ?? 0,
      frozen: frozen.count ?? 0,
      pending: pending.count ?? 0,
      cancelled: cancelled.count ?? 0,
    },
    error: null,
  };
}

export async function setCardStatus(cardId, status, reason) {
  return wrap(supabase.rpc('admin_set_card_status', {
    p_card_id: cardId,
    p_status: status,
    p_reason: reason,
  }));
}

/* -----------------------------------------------------------
   6. Accounts — freeze/unfreeze, account status, restrictions
   ----------------------------------------------------------- */
export async function freezeAccount(accountId, reason) {
  return wrap(supabase.rpc('admin_freeze_account', { p_account_id: accountId, p_reason: reason }));
}

export async function unfreezeAccount(accountId, reason) {
  return wrap(supabase.rpc('admin_unfreeze_account', { p_account_id: accountId, p_reason: reason }));
}

/**
 * Customer-level status (active/restricted/suspended/closed) —
 * distinct from freezeAccount()/unfreezeAccount() above, which
 * operate on a single account row. Backs the Account Status
 * control on admin-user-detail.html.
 */
export async function updateAccountStatus(userId, status, reason) {
  return wrap(supabase.rpc('admin_set_account_status', {
    p_user_id: userId,
    p_status: status,
    p_reason: reason,
  }));
}

export async function performRestrictionAction(action, userId, reason) {
  return wrap(supabase.rpc('admin_restriction_action', {
    p_action: action,
    p_user_id: userId,
    p_reason: reason,
  }));
}

export async function getCustomerRestrictionHistory(userId, { limit = 20 } = {}) {
  return wrap(
    supabase
      .from('restriction_history')
      .select('*, admin:performed_by(first_name,last_name)')
      .eq('user_id', userId)
      .order('performed_at', { ascending: false })
      .limit(limit)
  );
}

/* -----------------------------------------------------------
   7. Support tickets — admin-support.html
   ----------------------------------------------------------- */
export async function getSupportTicketSummary() {
  const [open, assigned, resolved, closed] = await Promise.all([
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'assigned'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'closed'),
  ]);
  const firstError = [open, assigned, resolved, closed].find((r) => r.error);
  if (firstError) return { data: null, error: friendlyAdminError(firstError.error) };
  return {
    data: {
      open: open.count ?? 0,
      assigned: assigned.count ?? 0,
      resolved: resolved.count ?? 0,
      closed: closed.count ?? 0,
    },
    error: null,
  };
}

export async function listSupportTickets({ status, priority, assignedTo, search, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('support_tickets').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (assignedTo) query = query.eq('assigned_admin_id', assignedTo);
  if (search) query = query.ilike('subject', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  const userIds = [...new Set((data || []).map((t) => t.user_id).filter(Boolean))];
  let usersById = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds);
    usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  }

  const rows = (data || []).map((t) => ({ ...t, customer: usersById[t.user_id] || null }));
  return { data: { rows, total: count ?? 0, page, pageSize }, error: null };
}

export async function getTicketDetail(ticketId) {
  const { data: ticket, error } = await supabase.from('support_tickets').select('*').eq('id', ticketId).single();
  if (error) return { data: null, error: friendlyAdminError(error) };

  const [{ data: customer }, { data: messages }] = await Promise.all([
    supabase.from('user_profiles').select('id, first_name, last_name, email').eq('id', ticket.user_id).maybeSingle(),
    supabase.from('support_ticket_messages').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true }),
  ]);

  return { data: { ticket, customer: customer || null, messages: messages || [] }, error: null };
}

export async function listAdminUsers() {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email, role')
    .in('role', ['support', 'admin', 'superadmin'])
    .order('first_name', { ascending: true });
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data, error: null };
}

export async function assignTicket(ticketId, adminId) {
  return wrap(
    supabase.from('support_tickets')
      .update({ assigned_admin_id: adminId, status: 'assigned', updated_at: new Date().toISOString() })
      .eq('id', ticketId)
  );
}

export async function replyToTicket(ticketId, adminId, body) {
  return wrap(
    supabase.from('support_ticket_messages')
      .insert({ ticket_id: ticketId, sender_id: adminId, is_admin: true, body })
  );
}

export async function resolveTicket(ticketId, resolutionNote) {
  return wrap(
    supabase.from('support_tickets')
      .update({ status: 'resolved', resolution_note: resolutionNote, updated_at: new Date().toISOString() })
      .eq('id', ticketId)
  );
}

export async function reopenTicket(ticketId) {
  return wrap(
    supabase.from('support_tickets')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', ticketId)
  );
}

/* -----------------------------------------------------------
   8. Risk / fraud — admin-risk.html
   ----------------------------------------------------------- */
export async function getRiskFlagSummary() {
  const [active, escalated, resolved] = await Promise.all([
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'escalated'),
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
  ]);
  const firstError = [active, escalated, resolved].find((r) => r.error);
  if (firstError) return { data: null, error: friendlyAdminError(firstError.error) };
  return {
    data: { active: active.count ?? 0, escalated: escalated.count ?? 0, resolved: resolved.count ?? 0 },
    error: null,
  };
}

export async function listRiskFlags({ status, severity, search, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('risk_flags').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (severity) query = query.eq('severity', severity);
  if (search) query = query.ilike('description', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  const userIds = [...new Set((data || []).map((f) => f.user_id).filter(Boolean))];
  let usersById = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds);
    usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  }

  const rows = (data || []).map((f) => ({ ...f, customer: usersById[f.user_id] || null }));
  return { data: { rows, total: count ?? 0, page, pageSize }, error: null };
}

export async function getRiskFlagDetail(flagId) {
  const { data: flag, error } = await supabase.from('risk_flags').select('*').eq('id', flagId).single();
  if (error) return { data: null, error: friendlyAdminError(error) };

  const { data: customer } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email')
    .eq('id', flag.user_id)
    .maybeSingle();

  let transaction = null;
  if (flag.transaction_id) {
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', flag.transaction_id).maybeSingle();
    transaction = tx || null;
  }

  return { data: { flag, customer: customer || null, transaction }, error: null };
}

export async function dismissRiskFlag(flagId, reason) {
  return wrap(supabase.rpc('admin_dismiss_risk_flag', { p_flag_id: flagId, p_reason: reason }));
}

export async function escalateRiskFlag(flagId, reason) {
  return wrap(supabase.rpc('admin_escalate_risk_flag', { p_flag_id: flagId, p_reason: reason }));
}

export async function resolveRiskFlag(flagId, reason) {
  return wrap(supabase.rpc('admin_resolve_risk_flag', { p_flag_id: flagId, p_reason: reason }));
}

/* -----------------------------------------------------------
   9. Reports — admin-reports.html
   ----------------------------------------------------------- */
export async function getVolumeReport({ from, to }) {
  const { data, error } = await supabase
    .from('transactions')
    .select('amount, fee, currency, created_at, status')
    .gte('created_at', from)
    .lte('created_at', to);

  if (error) return { data: null, error: friendlyAdminError(error) };

  const byCurrency = {};
  for (const tx of data) {
    if (tx.status === 'Reversed') continue;
    const bucket = (byCurrency[tx.currency] ||= { volume: 0, fees: 0, count: 0 });
    bucket.volume += Number(tx.amount || 0);
    bucket.fees += Number(tx.fee || 0);
    bucket.count += 1;
  }

  return { data: { byCurrency, rangeFrom: from, rangeTo: to }, error: null };
}

/* -----------------------------------------------------------
   10. Audit log — admin-audit-log.html
   ----------------------------------------------------------- */
export async function listAdminAuditLog({ adminId, targetTable, search, page = 1, pageSize = 50 } = {}) {
  let query = supabase.from('admin_audit_logs').select('*', { count: 'exact' });

  if (adminId) query = query.eq('admin_id', adminId);
  if (targetTable) query = query.eq('target_table', targetTable);
  if (search) query = query.ilike('reason', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  // admin_audit_logs.admin_id references auth.users, not
  // user_profiles, so it can't be embedded via Supabase's foreign-
  // table join syntax. Resolve admin names with a second lookup,
  // same pattern as listSupportTickets()/listRiskFlags() above.
  const adminIds = [...new Set((data || []).map((r) => r.admin_id).filter(Boolean))];
  let adminsById = {};
  if (adminIds.length) {
    const { data: admins } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .in('id', adminIds);
    adminsById = Object.fromEntries((admins || []).map((a) => [a.id, a]));
  }

  const rows = (data || []).map((r) => ({ ...r, admin: adminsById[r.admin_id] || null }));
  return { data: { rows, total: count ?? 0, page, pageSize }, error: null };
}

/**
 * Shim for admin-approvals.js's audit tab — see the CHANGE LOG at
 * the top of this file. Adapts listAdminAuditLog()'s real
 * { data: { rows, total } } shape into the flat
 * { data: rows, error, count } shape admin-approvals.js already
 * expects, without inventing columns that don't exist on
 * admin_audit_logs. `action` is filtered client-side (no
 * server-side support for it yet, so count/pagination can be
 * slightly off when it's active); `from`/`to` aren't applied at
 * all yet.
 */
export async function getAuditLog({ adminId, action, from, to, customerQuery, limit = 25, offset = 0 } = {}) {
  const page = Math.floor(offset / limit) + 1;

  const { data, error } = await listAdminAuditLog({
    adminId: adminId && adminId !== 'all' ? adminId : undefined,
    search: customerQuery,
    page,
    pageSize: limit,
  });

  if (error) return { data: [], error, count: 0 };

  let rows = data.rows;
  if (action && action !== 'all') {
    rows = rows.filter((r) => r.action === action);
  }

  return { data: rows, error: null, count: data.total };
}

export async function getAuditFilterOptions() {
  const [{ data: admins }, { data: actions }] = await Promise.all([
    supabase.from('user_profiles').select('id, first_name, last_name').in('role', ['support', 'admin', 'superadmin']),
    supabase.from('admin_audit_logs').select('action').limit(1000),
  ]);

  const uniqueActions = Array.from(new Set((actions || []).map((row) => row.action))).sort();
  return { data: { admins: admins || [], actions: uniqueActions }, error: null };
}

/* -----------------------------------------------------------
   11. Role management — admin-settings.html, superadmin only.
   ----------------------------------------------------------- */
export async function setUserRole(userId, role, reason) {
  return wrap(supabase.rpc('admin_set_user_role', {
    p_user_id: userId,
    p_role: role,
    p_reason: reason,
  }));
}

/* -----------------------------------------------------------
   12. Bank policies (global defaults) — admin-policy.html
   -----------------------------------------------------------
   Writes go through admin_save_policy_group() (SECURITY DEFINER)
   from 009_admin_policy_engine.sql — it does the upsert AND
   writes the field-level policy_change_history rows in one
   transaction, so the two can't desync the way two separate
   client calls could.
   ----------------------------------------------------------- */
export async function getPolicyGroup(group) {
  return wrap(supabase.from('bank_policies').select('*').eq('policy_group', group).maybeSingle());
}

export async function getAllPolicyGroups() {
  return wrap(supabase.from('bank_policies').select('*'));
}

export async function savePolicyGroup(group, values, reason) {
  return wrap(supabase.rpc('admin_save_policy_group', {
    p_policy_group: group,
    p_values: values,
    p_reason: reason ?? null,
  }));
}

export async function getPolicyChangeHistory({ limit = 50, offset = 0 } = {}) {
  return wrap(
    supabase
      .from('policy_change_history')
      .select('*, admin:changed_by(first_name,last_name)')
      .order('changed_at', { ascending: false })
      .range(offset, offset + limit - 1)
  );
}

/* -----------------------------------------------------------
   13. Customer permissions & limit overrides —
       admin-user-detail.html
   ----------------------------------------------------------- */
export async function getCustomerPermissions(userId) {
  return wrap(supabase.from('user_permissions').select('*').eq('user_id', userId).maybeSingle());
}

export async function saveCustomerPermissions(userId, permissions, reason) {
  return wrap(supabase.rpc('admin_save_customer_permissions', {
    p_user_id: userId,
    p_permissions: permissions,
    p_reason: reason ?? null,
  }));
}

export async function getCustomerLimitOverrides(userId) {
  return wrap(supabase.from('user_limit_overrides').select('*').eq('user_id', userId).maybeSingle());
}

export async function saveCustomerLimitOverrides(userId, overrides, reason) {
  return wrap(supabase.rpc('admin_save_customer_limit_overrides', {
    p_user_id: userId,
    p_overrides: overrides,
    p_reason: reason ?? null,
  }));
}

/* -----------------------------------------------------------
   14. Approval workflow (maker-checker) — admin-approvals.html
   ----------------------------------------------------------- */
export async function getApprovalStats() {
  return wrap(supabase.rpc('admin_get_approval_stats'));
}

export async function getApprovalQueue({ status = 'pending', type = 'all', limit = 25, offset = 0 } = {}) {
  let query = supabase
    .from('approval_requests')
    .select('*, requester:requested_by(first_name,last_name), customer:customer_id(first_name,last_name)', { count: 'exact' })
    .order('requested_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status !== 'all') query = query.eq('status', status);
  if (type !== 'all') query = query.eq('type', type);

  const { data, error, count } = await query;
  if (error) return { data: [], error: friendlyAdminError(error), count: 0 };
  return { data: data ?? [], error: null, count: count ?? 0 };
}

export async function getApprovalRequest(requestId) {
  return wrap(
    supabase
      .from('approval_requests')
      .select('*, requester:requested_by(first_name,last_name), customer:customer_id(first_name,last_name)')
      .eq('id', requestId)
      .single()
  );
}

/**
 * Approves or rejects a request. The maker-checker rule ("no
 * administrator approves their own request") is enforced inside
 * admin_decide_approval() server-side — any disabled-button check
 * in admin-approvals.js is UX only, not the real guard.
 */
export async function decideApproval(requestId, decision, reason) {
  return wrap(supabase.rpc('admin_decide_approval', {
    p_request_id: requestId,
    p_decision: decision,
    p_reason: reason,
  }));
}
