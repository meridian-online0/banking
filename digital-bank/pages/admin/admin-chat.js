/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-chat.js

   PURPOSE
   -------
   Powers admin-chat.html — the realtime live-chat inbox, separate
   from the ticket system on admin-support.html. Talks directly to
   chat_threads/chat_messages (supabase/chat_schema.sql) since there
   is no supabase/admin.js wrapper yet (still "planned" per the
   project's directory tree) — same direct-supabase-call pattern
   settings.js already uses for tables with no wrapper.

   KNOWN GAPS — flagging rather than silently faking:
   -----------------------------------------------------
   1. ATTACHMENTS: the file-attach button in admin-chat.html is
      wired to a stub. chat_schema.sql's chat_messages table only
      has a text `body` column — there's no attachment_url column,
      no chat_attachments table, and no Supabase Storage bucket or
      policy anywhere in the schema for this. Needs a real schema +
      storage decision before this can do anything but alert().
   2. OPEN-TAB COUNT: the badge next to the "Open" tab
      (data-thread-filter-count="open") only updates while you're
      ON the Open tab, since it's just threads.length for whatever
      filter is currently loaded — getting a live open-count while
      viewing Closed/All would need a second, separate count query.
      Minor, but not a real unread-style badge across tabs.
   3. MOBILE PANE SWITCH: admin-chat.css's ≤720px breakpoint expects
      an `is-conversation-open` class on .admin-chat-shell to swap
      from list view to conversation view. That's toggled below in
      selectThread()/backToThreadList() — see section 8.

   ROLE: any of support/admin/superadmin can access this page (the
   requireAdmin() default), matching admin-support.html's own tier.
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { supabase } from '../../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const ONLINE_THRESHOLD_MS = 60 * 1000;

let admin = null;
let threads = [];              // threads for the CURRENT filter only
let activeThreadId = null;
let activeFilter = 'open';     // 'open' | 'closed' | 'all'
let searchTerm = '';
let realtimeChannel = null;
let presenceTickInterval = null;

/* -----------------------------------------------------------
   1. Boot
   ----------------------------------------------------------- */
async function init() {
  admin = await requireAdmin();
  if (!admin) return;
  await initAdminLayout(admin, { pageTitle: 'Live chat' });

  wireTabs();
  wireSearch();
  wireRetry();
  wireThreadListClicks();
  wireReplyForm();
  wireStatusToggle();
  wireAttach();
  wireBackToList();

  await loadThreads();
  subscribeToRealtime();

  presenceTickInterval = setInterval(refreshPresenceOnly, 15000);

  window.addEventListener('beforeunload', () => {
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
    if (presenceTickInterval) clearInterval(presenceTickInterval);
  });
}

/* -----------------------------------------------------------
   2. Thread list — fetch
   ----------------------------------------------------------- */
async function loadThreads() {
  showListLoading();

  let query = supabase
    .from('chat_threads')
    .select('id, user_id, status, assigned_admin_id, last_seen_at, updated_at, created_at')
    .order('updated_at', { ascending: false });

  if (activeFilter !== 'all') query = query.eq('status', activeFilter);

  const { data: threadRows, error } = await query;
  if (error) {
    console.error('[Meridian Admin] Failed to load chat threads:', error.message);
    showListError();
    return;
  }

  if (!threadRows.length) {
    threads = [];
    applySearchAndRender();
    return;
  }

  const threadIds = threadRows.map((t) => t.id);
  const userIds = [...new Set(threadRows.map((t) => t.user_id))];

  const [{ data: profiles, error: profilesError }, { data: messages, error: messagesError }] = await Promise.all([
    supabase.from('user_profiles').select('id, first_name, last_name, email').in('id', userIds),
    supabase
      .from('chat_messages')
      .select('id, thread_id, sender_type, body, created_at, read_at')
      .in('thread_id', threadIds)
      .order('created_at', { ascending: true }),
  ]);

  if (profilesError) console.error('[Meridian Admin] Failed to load profiles for chat threads:', profilesError.message);
  if (messagesError) console.error('[Meridian Admin] Failed to load messages for chat threads:', messagesError.message);

  const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
  const messagesByThread = new Map();
  (messages || []).forEach((m) => {
    if (!messagesByThread.has(m.thread_id)) messagesByThread.set(m.thread_id, []);
    messagesByThread.get(m.thread_id).push(m);
  });

  threads = threadRows.map((t) => {
    const msgs = messagesByThread.get(t.id) || [];
    const last = msgs[msgs.length - 1] || null;
    const unreadCount = msgs.filter((m) => m.sender_type === 'user' && !m.read_at).length;
    const profile = profileMap.get(t.user_id) || null;

    return {
      ...t,
      profile,
      isVisitor: !profile,
      displayName: profile
        ? [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email || 'Customer'
        : 'Visitor',
      lastMessage: last,
      unreadCount,
      isOnline: isRecentlySeen(t.last_seen_at),
    };
  });

  applySearchAndRender();
}

function isRecentlySeen(lastSeenAt) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

/* -----------------------------------------------------------
   3. Thread list — filter/search/render
   ----------------------------------------------------------- */
function applySearchAndRender() {
  const term = searchTerm.trim().toLowerCase();
  const filtered = term
    ? threads.filter((t) => {
        const nameMatch = t.displayName.toLowerCase().includes(term);
        const bodyMatch = t.lastMessage && t.lastMessage.body.toLowerCase().includes(term);
        return nameMatch || bodyMatch;
      })
    : threads;

  renderThreadList(filtered);
  updateOpenTabCount();
}

function renderThreadList(list) {
  const ul = $('[data-thread-list]');
  const loading = $('[data-thread-list-loading]');
  const empty = $('[data-thread-list-empty]');
  const errorEl = $('[data-thread-list-error]');

  loading.hidden = true;
  errorEl.hidden = true;

  if (!list.length) {
    ul.hidden = true;
    ul.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  ul.hidden = false;
  ul.innerHTML = list.map(threadItemHtml).join('');
}

function threadItemHtml(t) {
  const preview = t.lastMessage ? escapeHtml(t.lastMessage.body) : 'No messages yet';
  const time = t.lastMessage ? formatRelativeTime(t.lastMessage.created_at) : '';

  return `
    <li class="admin-chat-thread-item${t.id === activeThreadId ? ' is-active' : ''}" data-thread-item data-thread-id="${t.id}">
      <button type="button" class="admin-chat-thread-btn">
        <span class="admin-chat-thread-avatar-wrap">
          <span class="avatar-initial avatar-initial--sm" data-thread-avatar>${getInitials(t.displayName)}</span>
          <span class="admin-chat-thread-presence" data-thread-presence data-state="${t.isOnline ? 'online' : 'offline'}"></span>
        </span>
        <span class="admin-chat-thread-info">
          <span class="admin-chat-thread-row">
            <span class="admin-chat-thread-name" data-thread-name>${escapeHtml(t.displayName)}</span>
            <span class="tag admin-chat-thread-visitor-tag" data-thread-visitor-tag${t.isVisitor ? '' : ' hidden'}>Visitor</span>
            <span class="admin-chat-thread-time" data-thread-time>${time}</span>
          </span>
          <span class="admin-chat-thread-preview" data-thread-preview>${preview}</span>
        </span>
        <span class="admin-nav-badge" data-thread-unread${t.unreadCount ? '' : ' hidden'}>${t.unreadCount}</span>
      </button>
    </li>`;
}

function updateOpenTabCount() {
  // Only meaningful while viewing the Open tab itself — see gap #2
  // in the file header comment.
  const el = $('[data-thread-filter-count="open"]');
  if (!el || activeFilter !== 'open') return;
  el.textContent = String(threads.length);
  el.hidden = threads.length === 0;
}

function showListLoading() {
  $('[data-thread-list-loading]').hidden = false;
  $('[data-thread-list]').hidden = true;
  $('[data-thread-list-empty]').hidden = true;
  $('[data-thread-list-error]').hidden = true;
}

function showListError() {
  $('[data-thread-list-loading]').hidden = true;
  $('[data-thread-list]').hidden = true;
  $('[data-thread-list-empty]').hidden = true;
  $('[data-thread-list-error]').hidden = false;
}

/* -----------------------------------------------------------
   4. Tabs / search / retry wiring
   ----------------------------------------------------------- */
function wireTabs() {
  $$('.admin-chat-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.admin-chat-tab').forEach((t) => {
        t.classList.remove('is-active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      activeFilter = tab.dataset.threadFilter;
      loadThreads();
    });
  });
}

function wireSearch() {
  const input = $('[data-thread-search]');
  if (!input) return;
  input.addEventListener('input', () => {
    searchTerm = input.value;
    applySearchAndRender();
  });
}

function wireRetry() {
  $('[data-thread-list-retry]')?.addEventListener('click', () => loadThreads());
}

function wireThreadListClicks() {
  $('[data-thread-list]')?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-thread-item]');
    if (item) selectThread(item.dataset.threadId);
  });
}

/* -----------------------------------------------------------
   5. Selecting a thread
   ----------------------------------------------------------- */
async function selectThread(threadId) {
  activeThreadId = threadId;

  $$('.admin-chat-thread-item').forEach((li) => {
    li.classList.toggle('is-active', li.dataset.threadId === threadId);
  });

  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return;

  $('[data-conversation-empty]').hidden = true;
  $('[data-conversation-active]').hidden = false;
  $('.admin-chat-shell')?.classList.add('is-conversation-open'); // mobile pane switch

  $('[data-conversation-avatar]').textContent = getInitials(thread.displayName);
  $('[data-conversation-name]').textContent = thread.displayName;
  $('[data-conversation-visitor-tag]').hidden = !thread.isVisitor;

  updatePresenceUI(thread);
  updateStatusUI(thread);

  await loadMessages(threadId);
  await markThreadMessagesRead(threadId);
}

/* -----------------------------------------------------------
   6. Messages — load / render / send
   ----------------------------------------------------------- */
async function loadMessages(threadId) {
  const container = $('[data-admin-messages]');
  container.innerHTML = '<p class="admin-chat-state">Loading messages…</p>';

  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, sender_type, body, created_at, read_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[Meridian Admin] Failed to load messages:', error.message);
    container.innerHTML = '<p class="admin-chat-state">Couldn\'t load this conversation.</p>';
    return;
  }

  renderMessages(data || []);
}

function renderMessages(msgs) {
  const container = $('[data-admin-messages]');
  container.innerHTML = msgs.map(messageHtml).join('');
  container.scrollTop = container.scrollHeight;
}

function appendMessage(msg) {
  const container = $('[data-admin-messages]');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', messageHtml(msg));
  container.scrollTop = container.scrollHeight;
}

function messageHtml(m) {
  const cls =
    m.sender_type === 'admin' ? 'admin-chat-msg admin-chat-msg--admin' :
    m.sender_type === 'system' ? 'admin-chat-msg admin-chat-msg--system' :
    'admin-chat-msg';

  const label = m.sender_type === 'admin' ? 'You' : m.sender_type === 'system' ? 'System' : 'Visitor';

  return `
    <div class="${cls}" data-message-id="${m.id}">
      <div class="admin-chat-msg-meta"><span>${label}</span><span>${formatClockTime(m.created_at)}</span></div>
      <div class="admin-chat-msg-body">${escapeHtml(m.body)}</div>
    </div>`;
}

async function markThreadMessagesRead(threadId) {
  const { error } = await supabase
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('thread_id', threadId)
    .eq('sender_type', 'user')
    .is('read_at', null);

  if (error) {
    console.error('[Meridian Admin] Failed to mark messages read:', error.message);
    return;
  }

  const thread = threads.find((t) => t.id === threadId);
  if (thread) thread.unreadCount = 0;

  const badge = $(`[data-thread-item][data-thread-id="${threadId}"] [data-thread-unread]`);
  if (badge) badge.setAttribute('hidden', '');
}

function wireReplyForm() {
  const form = $('[data-admin-reply-form]');
  const input = $('[data-admin-reply-input]');
  const sendBtn = $('[data-admin-reply-send]');
  if (!form || !input || !sendBtn) return;

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body || !activeThreadId) return;

    sendBtn.disabled = true;

    const { error } = await supabase.from('chat_messages').insert({
      thread_id: activeThreadId,
      sender_type: 'admin',
      sender_id: admin.user.id,
      body,
    });

    if (error) {
      console.error('[Meridian Admin] Failed to send reply:', error.message);
      sendBtn.disabled = false;
      return;
    }

    // The realtime subscription (section 8) appends the message to
    // the log — no need to render it here too.
    input.value = '';
    input.style.height = 'auto';
  });
}

/* -----------------------------------------------------------
   7. Status toggle (open/closed) + presence display
   ----------------------------------------------------------- */
function wireStatusToggle() {
  $('[data-conversation-toggle-status]')?.addEventListener('click', async () => {
    const thread = threads.find((t) => t.id === activeThreadId);
    if (!thread) return;

    const newStatus = thread.status === 'open' ? 'closed' : 'open';
    const { error } = await supabase.from('chat_threads').update({ status: newStatus }).eq('id', thread.id);

    if (error) {
      console.error('[Meridian Admin] Failed to update thread status:', error.message);
      return;
    }

    thread.status = newStatus;
    updateStatusUI(thread);

    // If the current tab no longer includes this status, it should
    // drop out of the visible list.
    if (activeFilter !== 'all' && activeFilter !== newStatus) loadThreads();
  });
}

function updateStatusUI(thread) {
  const pill = $('[data-conversation-status-pill]');
  const btn = $('[data-conversation-toggle-status]');

  if (pill) {
    pill.textContent = thread.status === 'open' ? 'Open' : 'Closed';
    pill.classList.toggle('status-pill--verified', thread.status === 'open');
  }
  if (btn) {
    btn.textContent = thread.status === 'open' ? 'Mark as closed' : 'Reopen conversation';
  }
}

function updatePresenceUI(thread) {
  const wrap = $('[data-conversation-presence]');
  const text = $('[data-conversation-presence-text]');
  if (!wrap || !text) return;

  wrap.dataset.state = thread.isOnline ? 'online' : 'offline';
  text.textContent = thread.isOnline
    ? 'Online now'
    : thread.last_seen_at
      ? `Last seen ${formatRelativeTime(thread.last_seen_at)}`
      : 'Offline';
}

// Recomputes online/offline off data already in memory (no network
// call) every 15s, so a visitor going stale doesn't require a
// manual refresh to notice.
function refreshPresenceOnly() {
  let changed = false;
  threads.forEach((t) => {
    const nowOnline = isRecentlySeen(t.last_seen_at);
    if (nowOnline !== t.isOnline) {
      t.isOnline = nowOnline;
      changed = true;
    }
  });
  if (changed) applySearchAndRender();

  const active = threads.find((t) => t.id === activeThreadId);
  if (active) updatePresenceUI(active);
}

/* -----------------------------------------------------------
   8. Realtime — one shared channel for both tables
   ----------------------------------------------------------- */
function subscribeToRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);

  realtimeChannel = supabase
    .channel('admin-chat-inbox')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_threads' }, () => {
      // Simplest-correct approach: any thread row change (new
      // thread, status change, last_seen_at bump) just re-fetches
      // the current filter's list. Fine at this app's scale.
      loadThreads();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      handleIncomingMessage(payload.new);
    })
    .subscribe();
}

function handleIncomingMessage(message) {
  const thread = threads.find((t) => t.id === message.thread_id);

  if (!thread) {
    // Message belongs to a thread not in the current filtered view
    // (e.g. a new thread just opened) — let the chat_threads
    // listener's loadThreads() pick it up.
    return;
  }

  thread.lastMessage = message;
  if (message.sender_type === 'user' && message.thread_id !== activeThreadId) {
    thread.unreadCount = (thread.unreadCount || 0) + 1;
  }
  applySearchAndRender();

  if (message.thread_id === activeThreadId) {
    appendMessage(message);
    if (message.sender_type === 'user') markThreadMessagesRead(activeThreadId);
  }
}

/* -----------------------------------------------------------
   9. Attachments — stub (see gap #1 at top of file)
   ----------------------------------------------------------- */
function wireAttach() {
  const attachBtn = $('[data-admin-attach]');
  if (!attachBtn) return;

  attachBtn.addEventListener('click', () => {
    window.alert(
      "File attachments aren't wired up yet — chat_messages has no attachment column and there's no storage bucket for chat uploads in the schema yet."
    );
  });
}

/* -----------------------------------------------------------
   10. Mobile: back-to-list button
   -----------------------------------------------------------
   admin-chat.html doesn't currently have a dedicated "back" button
   in the conversation head — on mobile, tapping a thread swaps to
   the conversation pane (admin-chat.css's is-conversation-open),
   but there's no way back to the list without this. Wires up IF a
   [data-conversation-back] element exists; otherwise a no-op, so
   this doesn't error against the current markup. Flagging: add
   <button data-conversation-back> to admin-chat.html's conversation
   header for this to do anything on mobile.
   ----------------------------------------------------------- */
function wireBackToList() {
  $('[data-conversation-back]')?.addEventListener('click', () => {
    $('.admin-chat-shell')?.classList.remove('is-conversation-open');
  });
}

/* -----------------------------------------------------------
   11. Small helpers
   ----------------------------------------------------------- */
function getInitials(name) {
  return (
    (name || 'V')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || 'V'
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatClockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

init();
