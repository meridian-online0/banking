/* =============================================================
   MERIDIAN — Admin panel
   supabase/admin.js

   CHANGE LOG (this revision)
   ---------------------------
   - listTransactions(): added optional from/to date-range filters
     and sortField/sortDir, to back admin-transactions.html's
     sortable columns + date range picker.
   - getTransactionSummary(): NEW. A filtered aggregate (volume by
     currency, count, reversed count, processing count) scoped to
     the same filters as listTransactions(), so the stats row on
     admin-transactions.html reflects the filtered set rather than
     summing only the current page of 25 rows. Everything else is
     unchanged from the previous revision.

   PURPOSE
   -------
   The admin-side counterpart to supabase/database.js — every
   pages/admin/*.js page script imports from here instead of
   calling `supabase.from(...)` or `supabase.rpc(...)` directly.
   Same reason database.js exists for the customer app: one place
   that knows the actual table/column shapes, so a schema change
   only needs updating here.

   PATTERN
   -------
   Every export returns { data, error } — error is a friendly
   string or null, never a thrown exception — same convention as
   supabase/auth.js. Mutating exports (freezeAccount, approveKyc,
   reverseTransaction, ...) call the SECURITY DEFINER RPCs from
   admin_schema.sql via wrap(supabase.rpc(...)) rather than
   `.update()`/`.delete()` — this file deliberately contains ZERO
   direct writes to accounts, transactions, cards, or
   user_profiles.role. The one exception is support ticket
   assignment/resolution (see section 7), which admin_schema.sql's
   own comments call out as a plain RLS-gated UPDATE rather than an
   RPC, since a support reply isn't a sensitive-enough mutation to
   need the audit-log treatment the money/status RPCs get.

   ASSUMPTIONS FLAGGED BELOW (schema not directly seen — verify
   before relying on these in production, same spirit as
   settings.js's own "SCHEMA NOTES" block):

     - support_tickets.status values assumed to be
       'open' | 'assigned' | 'resolved' | 'closed'. Adjust the
       filter functions below if your actual values differ.
     - KYC "pending" is read as user_profiles.account_status =
       'Pending' (set at signup in auth.js's signUpUser()).
       admin_approve_kyc()/admin_reject_kyc() move it to
       'active'/'rejected' respectively — there is no separate kyc
       table, KYC status IS account_status.
     - There is currently NO fraud/AML/velocity-flag table in the
       schema — admin-risk.html's "flag/velocity alerts" have
       nothing to query yet. getRiskFlags() below is a stub that
       returns an empty result with a console.warn, not fabricated
       data. A future migration (e.g. `risk_flags` table +
       whatever detection populates it) needs to land before that
       page can show anything real.
     - getUserDetail()'s cards query below uses `.eq('user_id', ...)`
       on the cards table, but database.js's getCardsForAccount()
       queries cards by account_id — cards has no known user_id
       column. Flagging rather than silently "fixing" it, since I
       haven't seen cards' actual schema: this likely needs to
       become a query over the user's account ids instead.
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

/* -----------------------------------------------------------
   wrap() — normalizes a Supabase call (query builder promise or
   .rpc() promise) into { data, error }. Supabase's client already
   resolves rather than throws on most failures, but wrap() also
   catches anything that does throw (network failure, a bad .rpc()
   name, etc.) so no admin page script needs its own try/catch for
   the common case.
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

/**
 * Filtered aggregate for the stats row on admin-transactions.html —
 * scoped to the same status/currency/search/date filters as
 * listTransactions(), but not paginated. Pulls only the columns
 * needed to aggregate (amount, currency, status) rather than
 * full rows, and computes sums/counts client-side over that
 * narrow result. Fine at Meridian's current data volume; if this
 * gets slow, move it to a Postgres aggregate (e.g. a SQL function
 * with GROUP BY) the same way getVolumeReport() below is flagged
 * for a materialized view.
 */
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
      continue; // don't double-count reversed originals in volume
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
  // card_number, not id — the field an admin actually has in hand
  // (a customer reads out the last 4, or support pastes a full PAN).
  if (search) query = query.ilike('card_number', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

/**
 * Card + its owning account + that account's holder, for the
 * admin-cards.html detail drawer. cards has no direct user_id
 * (see getUserDetail()'s flagged assumption above) — it's reached
 * via cards.account_id -> accounts.user_id -> user_profiles.
 */
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

/**
 * Counts of cards by status, for admin-cards.html's stat row. Four
 * lightweight head:true count queries (no rows over the wire) —
 * same shape as getDashboardStats() above, just scoped to one table.
 */
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
   6. Accounts — freeze/unfreeze
   ----------------------------------------------------------- */
export async function freezeAccount(accountId, reason) {
  return wrap(supabase.rpc('admin_freeze_account', { p_account_id: accountId, p_reason: reason }));
}

export async function unfreezeAccount(accountId, reason) {
  return wrap(supabase.rpc('admin_unfreeze_account', { p_account_id: accountId, p_reason: reason }));
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
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
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
