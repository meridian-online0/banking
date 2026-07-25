/* =============================================================
   MERIDIAN — International Digital Banking
   Live support chat module: supabase/chat.js

   This is the customer-facing half of live chat support — a real
   human agent, not a bot. Wraps the chat_threads / chat_messages
   tables defined in chat_schema.sql. Same contract as auth.js /
   database.js: every exported function returns a plain
   { data, error } object, so callers never need try/catch for
   expected failures.

     import { getOrCreateMyThread, sendMessage } from '../supabase/chat.js';

   The admin-side half (viewing/replying to ALL open threads from
   pages/admin/admin-support.html) belongs in supabase/admin.js
   alongside the rest of the admin RPC callers, not here — this
   file is scoped to "the signed-in customer's own thread," the
   same way database.js's getMyAccounts() etc. are scoped to
   auth.uid() rather than taking arbitrary ids from the caller.

   WHY THE FIRST MESSAGE ISN'T SENT FROM HERE
   -------------------------------------------
   The "an agent is available 24/7 and may join at any time"
   welcome message is written by a Postgres trigger
   (chat_thread_welcome_message(), see chat_schema.sql) that fires
   the moment a new chat_threads row is inserted — not by a second
   client-side insert() after getOrCreateMyThread() succeeds. That
   keeps it atomic with thread creation (no window where a thread
   exists with zero messages) and guarantees every thread gets
   exactly one welcome message even if the client retries.
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

/* -----------------------------------------------------------
   Helpers — same shape as database.js
   ----------------------------------------------------------- */

function wrap(promise) {
  return promise.then(({ data, error }) => ({ data: data ?? null, error: error ? error.message : null }));
}

async function resolveUserId(userId) {
  if (userId) return userId;
  const { data: user } = await getCurrentUser();
  return user?.id ?? null;
}

/* -----------------------------------------------------------
   Threads
   ----------------------------------------------------------- */

/**
 * Returns the signed-in user's open support thread, creating one
 * (and, via the DB trigger, its welcome message) if none exists
 * yet. Safe to call every time the widget is opened — it won't
 * spawn a new thread for a user who already has an open one.
 */
export async function getOrCreateMyThread(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };

  const { data: existing, error: findError } = await supabase
    .from('chat_threads')
    .select('*')
    .eq('user_id', uid)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) return { data: null, error: findError.message };
  if (existing) return { data: existing, error: null };

  return wrap(
    supabase.from('chat_threads').insert({ user_id: uid, status: 'open' }).select().single()
  );
}

/* -----------------------------------------------------------
   Messages
   ----------------------------------------------------------- */

export async function getThreadMessages(threadId) {
  return wrap(
    supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
  );
}

/** Sends a message as the signed-in user into their own thread. */
export async function sendMessage(threadId, body, userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };

  const trimmed = String(body || '').trim();
  if (!trimmed) return { data: null, error: 'Message cannot be empty.' };
  if (!threadId) return { data: null, error: 'No active conversation.' };

  return wrap(
    supabase
      .from('chat_messages')
      .insert({ thread_id: threadId, sender_type: 'user', sender_id: uid, body: trimmed })
      .select()
      .single()
  );
}

/**
 * Subscribes to new messages on a thread (agent replies, mainly —
 * see subscribeToThreadMessages()'s caller in chat-widget.js).
 * Returns the realtime channel; pass it to unsubscribeFromThread()
 * when the widget unmounts or the thread changes.
 */
export function subscribeToThreadMessages(threadId, onInsert) {
  return supabase
    .channel(`chat-thread-${threadId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `thread_id=eq.${threadId}` },
      (payload) => onInsert(payload.new)
    )
    .subscribe();
}

export function unsubscribeFromThread(channel) {
  if (channel) supabase.removeChannel(channel);
}

/* -----------------------------------------------------------
   Read state (drives the unread badge on the floating button)
   ----------------------------------------------------------- */

export async function markAdminMessagesRead(threadId) {
  return wrap(
    supabase
      .from('chat_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('thread_id', threadId)
      .eq('sender_type', 'admin')
      .is('read_at', null)
  );
}

export async function getUnreadAdminMessageCount(threadId) {
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId)
    .eq('sender_type', 'admin')
    .is('read_at', null);

  return { data: count ?? 0, error: error ? error.message : null };
}
