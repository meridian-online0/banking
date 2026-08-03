/* =============================================================
   MERIDIAN — International Digital Banking
   Live support chat module: supabase/chat.js

   This is the customer-facing half of live chat support — a real
   human agent, not a bot. Wraps the chat_threads / chat_messages
   tables defined in chat_schema.sql, plus file/image attachments
   stored in the 'chat-attachments' Storage bucket (see
   migrations/008_chat_attachments.sql). Same contract as auth.js /
   database.js: every exported function returns a plain
   { data, error } object, so callers never need try/catch for
   expected failures.

     import { getOrCreateMyThread, sendMessage, sendAttachment } from '../supabase/chat.js';

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
   Messages — text
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

/** Sends a text message as the signed-in user into their own thread. */
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

/* -----------------------------------------------------------
   Messages — picture / document attachments
   -----------------------------------------------------------
   Files live in the private 'chat-attachments' Storage bucket,
   one folder per thread (thread_id/<uuid>-<filename>), so the
   bucket's own RLS policies (see migrations/008_chat_attachments.sql)
   can check "does this path's folder belong to a thread the
   caller owns?" the same way chat_messages' RLS does. Only the
   storage PATH is stored on the message row, never a public URL —
   getAttachmentSignedUrl() below mints a short-lived signed URL
   whenever one actually needs to be displayed or downloaded.
   ----------------------------------------------------------- */

const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

// Kept as exports so chat-widget.js can run the same checks
// client-side (for instant feedback) that the Storage bucket
// itself enforces server-side — see the bucket's file_size_limit
// and allowed_mime_types in the migration.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB
export const ALLOWED_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

/**
 * Uploads a picture/document to the signed-in user's thread and
 * inserts the message row that references it. `body` is optional —
 * a file can be sent with or without a caption.
 */
export async function sendAttachment(threadId, file, { body = '', userId } = {}) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  if (!threadId) return { data: null, error: 'No active conversation.' };
  if (!file) return { data: null, error: 'Choose a file to send.' };
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { data: null, error: 'Files must be 10MB or smaller.' };
  }
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
    return { data: null, error: "That file type isn't supported — try an image, PDF, or Word doc." };
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${threadId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(CHAT_ATTACHMENTS_BUCKET)
    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });

  if (uploadError) return { data: null, error: uploadError.message };

  return wrap(
    supabase
      .from('chat_messages')
      .insert({
        thread_id: threadId,
        sender_type: 'user',
        sender_id: uid,
        body: body.trim() || null,
        attachment_path: path,
        attachment_name: file.name,
        attachment_type: file.type,
        attachment_size: file.size,
      })
      .select()
      .single()
  );
}

/**
 * Mints a short-lived signed URL for a stored attachment. Called
 * lazily when a message with an attachment is rendered, not stored
 * anywhere — signed URLs expire, storage paths don't.
 */
export async function getAttachmentSignedUrl(path, expiresInSeconds = 3600) {
  const { data, error } = await supabase.storage
    .from(CHAT_ATTACHMENTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error) return { data: null, error: error.message };
  return { data: data.signedUrl, error: null };
}

/* -----------------------------------------------------------
   Realtime
   ----------------------------------------------------------- */

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



/* -----------------------------------------------------------
   Thread lifecycle — closing
   -----------------------------------------------------------
   Wraps chat_close_thread(), a SECURITY DEFINER RPC (see the
   addition to chat_schema.sql) rather than a direct table update,
   since chat_threads has no user-facing UPDATE policy — only
   admins can update it directly. Used by "Clear conversation" in
   chat-widget.js, which immediately calls getOrCreateMyThread()
   again afterward to spin up a fresh thread (and its own real
   welcome message).
   ----------------------------------------------------------- */
export async function closeMyThread(threadId) {
  if (!threadId) return { data: null, error: 'No active conversation.' };
  return wrap(supabase.rpc('chat_close_thread', { p_thread_id: threadId }));
}

/* -----------------------------------------------------------
   Presence — heartbeat
   -----------------------------------------------------------
   Thin wrapper around chat_heartbeat(), called on an interval by
   chat-widget.js while the panel is open, so a visitor reading
   silently doesn't go stale in the admin inbox's last-seen column.
   Deliberately fire-and-forget from the caller's side — a missed
   heartbeat just means slightly staler presence, not a broken UI,
   so callers aren't expected to surface its error to the user.
   ----------------------------------------------------------- */
export async function sendHeartbeat(threadId) {
  if (!threadId) return { data: null, error: 'No active conversation.' };
  return wrap(supabase.rpc('chat_heartbeat', { p_thread_id: threadId }));
}


