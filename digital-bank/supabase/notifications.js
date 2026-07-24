/* =============================================================
   MERIDIAN — International Digital Banking
   Notifications module (rich): supabase/notifications.js

   The richer counterpart to database.js's getNotifications() /
   getUnreadNotificationCount() / markNotificationRead() /
   markAllNotificationsRead(), which the navbar bell
   (assets/js/notifications.js) uses for a lightweight unread
   count + recent-list dropdown.

   This module powers pages/notifications.html via
   assets/js/notifications-center.js, and adds category filtering,
   search, archive/restore, delete, and realtime subscription on
   top of the same `notifications` table (see the "Notification
   Center upgrade" migration for the schema/RLS/trigger side).

   Same contract as database.js: every exported function returns
   a plain { data, error } object (list functions also return
   `count` for pagination), so callers never need try/catch for
   expected failures.

     import {
       getNotifications, markAsRead, markAllAsRead,
       archiveNotification, restoreNotification, deleteNotification,
       subscribeToNotifications, NOTIFICATION_CATEGORIES,
     } from '../../supabase/notifications.js';
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

/* -----------------------------------------------------------
   Helpers — identical pattern to database.js
   ----------------------------------------------------------- */

async function resolveUserId(userId) {
  if (userId) return userId;
  const { data: user } = await getCurrentUser();
  return user?.id ?? null;
}

function wrap(promise) {
  return promise.then(({ data, error }) => ({ data: data ?? null, error: error ? error.message : null }));
}

/* -----------------------------------------------------------
   Categories — matches the varchar values written by
   notify_user() / the trigger functions in the schema migration.
   notifications-center.js uses this to build the filter chips.
   ----------------------------------------------------------- */

export const NOTIFICATION_CATEGORIES = [
  { value: 'banking', label: 'Banking' },
  { value: 'account', label: 'Account' },
  { value: 'security', label: 'Security' },
  { value: 'cards', label: 'Cards' },
  { value: 'investments', label: 'Investments' },
  { value: 'loans', label: 'Loans' },
  { value: 'savings', label: 'Savings' },
  { value: 'rewards', label: 'Rewards' },
  { value: 'system', label: 'System' },
];

/* -----------------------------------------------------------
   List — paginated, filterable, searchable
   -----------------------------------------------------------
   Mirrors the filter bar on notifications.html: status
   (all/unread), category chips, and a debounced search box.
   `archived` is passed as its own flag by notifications-center.js
   (the "Archived" tab isn't a `status` value in the DB — it's a
   separate boolean column) so it's translated into the right
   `is_read` / `is_archived` predicates here.
   ----------------------------------------------------------- */
export async function getNotifications(userId, {
  status = 'all',       // 'all' | 'unread'
  category = 'all',
  archived = false,
  search = '',
  limit = 20,
  offset = 0,
} = {}) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: [], error: 'Not signed in.', count: 0 };

  let query = supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', uid)
    .eq('is_archived', archived)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status === 'unread') query = query.eq('is_read', false);
  if (category && category !== 'all') query = query.eq('category', category);
  if (search?.trim()) {
    // Escape ILIKE wildcards in the raw search term before building the filter.
    const term = search.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(`title.ilike.%${term}%,message.ilike.%${term}%`);
  }

  const { data, error, count } = await query;
  return { data: data ?? [], error: error ? error.message : null, count: count ?? 0 };
}

/* -----------------------------------------------------------
   Read state
   ----------------------------------------------------------- */

export async function markAsRead(notificationId) {
  return wrap(
    supabase.from('notifications').update({ is_read: true }).eq('id', notificationId).select().single()
  );
}

export async function markAllAsRead(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', uid)
      .eq('is_read', false)
      .eq('is_archived', false)
  );
}

/* -----------------------------------------------------------
   Archive / restore / delete
   ----------------------------------------------------------- */

export async function archiveNotification(notificationId) {
  return wrap(
    supabase.from('notifications').update({ is_archived: true }).eq('id', notificationId).select().single()
  );
}

export async function restoreNotification(notificationId) {
  return wrap(
    supabase.from('notifications').update({ is_archived: false }).eq('id', notificationId).select().single()
  );
}

export async function deleteNotification(notificationId) {
  return wrap(supabase.from('notifications').delete().eq('id', notificationId));
}

/* -----------------------------------------------------------
   Realtime subscription
   -----------------------------------------------------------
   The `notifications` table is already added to the
   supabase_realtime publication, and RLS scopes SELECT to
   auth.uid() = user_id, so the user-scoped filter below is a
   convenience, not a security boundary — same caveat database.js
   gives for its userId params.

   Returns the channel so callers can unsubscribe on teardown, if
   the page they're used from ever needs to (notifications-center.js
   currently doesn't, since it lives for the page's lifetime).
   ----------------------------------------------------------- */
export function subscribeToNotifications(userId, { onInsert, onUpdate, onDelete } = {}) {
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => onInsert?.(payload.new)
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => onUpdate?.(payload.new)
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => onDelete?.(payload.old)
    )
    .subscribe();

  return channel;
}
