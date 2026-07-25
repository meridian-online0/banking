/* =============================================================
   MERIDIAN — International Digital Banking
   assets/js/chat-widget.js

   Behavior for the floating live-support chat button + panel
   (components/chat-widget.html). Connects to a REAL human agent —
   there is no bot logic here. The "an agent is available 24/7"
   first message is written server-side by a DB trigger the
   moment a thread is created (see chat_thread_welcome_message()
   in supabase/chat_schema.sql); this file just renders whatever
   comes back from chat.js, it never invents or hardcodes that
   message itself.

   Supports sending pictures and documents as attachments (see
   the paperclip button in the input row), on top of plain text —
   see wireEvents()'s file-input handling and renderAttachment()
   below. The size/type limits shown to the user client-side
   mirror MAX_ATTACHMENT_BYTES / ALLOWED_ATTACHMENT_TYPES from
   chat.js, which the Storage bucket also enforces server-side —
   see migrations/008_chat_attachments.sql.

   BOOTING
   -------
   Not meant to be linked directly as a <script> on every page.
   Booted from components/components.js's bootChatWidget(), the
   same way notifications.js is booted after app-navbar loads —
   see the components.js patch for CHAT_WIDGET_EXCLUDED_PAGES and
   the "already signed in?" check, which happen there, before
   mountChatWidget() is ever called. That keeps the page-exclusion
   list in one place instead of duplicated across files.

     import { mountChatWidget } from '../assets/js/chat-widget.js';
     await mountChatWidget(componentsBase);

   `componentsBase` is the same base path components.js already
   computes for fetching partials (resolveComponentsBase()) — pass
   it through rather than recomputing it here.
   ============================================================= */

import {
  getOrCreateMyThread,
  getThreadMessages,
  sendMessage,
  sendAttachment,
  getAttachmentSignedUrl,
  subscribeToThreadMessages,
  unsubscribeFromThread,
  markAdminMessagesRead,
  getUnreadAdminMessageCount,
  MAX_ATTACHMENT_BYTES,
  ALLOWED_ATTACHMENT_TYPES,
} from '../../supabase/chat.js';
import { formatTimestamp } from './utils.js';

const SESSION_KEY = 'meridian-chat-open';

let state = {
  threadId: null,
  channel: null,
  panelOpen: false,
  mounted: false,
  pendingFile: null,
  previewObjectUrl: null,
};

/* -----------------------------------------------------------
   Mount
   ----------------------------------------------------------- */

/**
 * Fetches chat-widget.html, injects it at the end of <body>, and
 * wires up all interactivity. Safe to call once per page load —
 * a second call is a no-op if the widget is already in the DOM.
 */
export async function mountChatWidget(componentsBase) {
  if (state.mounted || document.getElementById('chat-widget-root')) return;

  const response = await fetch(`${componentsBase}chat-widget.html`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  document.body.appendChild(wrapper.firstElementChild);

  state.mounted = true;
  wireEvents();

  // Reopen the panel if the visitor navigated to a new page mid-chat.
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    await openPanel();
  }
}

/* -----------------------------------------------------------
   Event wiring
   ----------------------------------------------------------- */

function wireEvents() {
  const toggleBtn = document.querySelector('[data-chat-toggle]');
  const closeBtn = document.querySelector('[data-chat-close]');
  const form = document.querySelector('[data-chat-form]');
  const input = document.querySelector('[data-chat-input]');
  const sendBtn = document.querySelector('[data-chat-send]');
  const attachBtn = document.querySelector('[data-chat-attach]');
  const fileInput = document.querySelector('[data-chat-file-input]');
  const fileRemoveBtn = document.querySelector('[data-chat-file-remove]');

  toggleBtn.addEventListener('click', () => {
    state.panelOpen ? closePanel() : openPanel();
  });

  closeBtn.addEventListener('click', closePanel);

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim() && !state.pendingFile;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 90)}px`;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // allow re-selecting the same file later
    if (!file) return;

    if (file.size > MAX_ATTACHMENT_BYTES) {
      renderSystemNotice('That file is too large — attachments must be 10MB or smaller.');
      return;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
      renderSystemNotice("That file type isn't supported — try an image, PDF, or Word doc.");
      return;
    }

    setPendingFile(file);
    sendBtn.disabled = false;
  });

  fileRemoveBtn.addEventListener('click', () => {
    clearPendingFile();
    sendBtn.disabled = !input.value.trim();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    const file = state.pendingFile;
    if (!body && !file) return;
    if (!state.threadId) return;

    input.value = '';
    input.style.height = 'auto';
    clearPendingFile();
    sendBtn.disabled = true;

    const { data: message, error } = file
      ? await sendAttachment(state.threadId, file, { body })
      : await sendMessage(state.threadId, body);

    if (error) {
      renderSystemNotice(`Couldn't send that — ${error}`);
      return;
    }
    renderMessage(message);
    scrollToBottom();
  });
}

/* -----------------------------------------------------------
   Pending attachment preview (before sending)
   ----------------------------------------------------------- */

function setPendingFile(file) {
  clearPendingFile(); // release any previous preview URL first

  state.pendingFile = file;

  const preview = document.querySelector('[data-chat-file-preview]');
  const thumb = document.querySelector('[data-chat-file-preview-thumb]');
  const name = document.querySelector('[data-chat-file-preview-name]');

  name.textContent = file.name;
  preview.hidden = false;

  if (file.type.startsWith('image/')) {
    state.previewObjectUrl = URL.createObjectURL(file);
    thumb.style.backgroundImage = `url(${state.previewObjectUrl})`;
  } else {
    thumb.style.backgroundImage = '';
  }
}

function clearPendingFile() {
  if (state.previewObjectUrl) {
    URL.revokeObjectURL(state.previewObjectUrl);
    state.previewObjectUrl = null;
  }
  state.pendingFile = null;

  const preview = document.querySelector('[data-chat-file-preview]');
  const thumb = document.querySelector('[data-chat-file-preview-thumb]');
  if (preview) preview.hidden = true;
  if (thumb) thumb.style.backgroundImage = '';
}

/* -----------------------------------------------------------
   Open / close
   ----------------------------------------------------------- */

async function openPanel() {
  const panel = document.getElementById('chat-widget-panel');
  const toggleBtn = document.querySelector('[data-chat-toggle]');

  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  toggleBtn.setAttribute('aria-expanded', 'true');
  toggleBtn.setAttribute('aria-label', 'Close support chat');
  state.panelOpen = true;
  sessionStorage.setItem(SESSION_KEY, '1');

  if (!state.threadId) {
    await initThread();
  } else {
    await markAdminMessagesRead(state.threadId);
    updateUnreadBadge(0);
  }

  document.querySelector('[data-chat-input]')?.focus();
  scrollToBottom();
}

function closePanel() {
  const panel = document.getElementById('chat-widget-panel');
  const toggleBtn = document.querySelector('[data-chat-toggle]');

  panel.hidden = true;
  panel.setAttribute('aria-hidden', 'true');
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-label', 'Open support chat');
  state.panelOpen = false;
  sessionStorage.removeItem(SESSION_KEY);
}

/* -----------------------------------------------------------
   Thread lifecycle
   ----------------------------------------------------------- */

async function initThread() {
  const messagesEl = document.querySelector('[data-chat-messages]');

  const { data: thread, error: threadError } = await getOrCreateMyThread();
  if (threadError || !thread) {
    messagesEl.innerHTML = '';
    renderSystemNotice(threadError || "Couldn't connect to support right now — please try again shortly.");
    return;
  }

  state.threadId = thread.id;

  const { data: messages, error: messagesError } = await getThreadMessages(thread.id);
  messagesEl.innerHTML = '';
  if (messagesError) {
    renderSystemNotice(messagesError);
  } else {
    messages.forEach(renderMessage);
  }
  scrollToBottom();

  await markAdminMessagesRead(thread.id);
  updateUnreadBadge(0);

  state.channel = subscribeToThreadMessages(thread.id, (message) => {
    // Ignore the echo of the user's own just-sent message — it's
    // already rendered optimistically by the submit handler above.
    if (message.sender_type === 'user') return;

    renderMessage(message);
    scrollToBottom();

    if (state.panelOpen) {
      markAdminMessagesRead(thread.id);
    } else {
      refreshUnreadBadge();
    }
  });
}

async function refreshUnreadBadge() {
  if (!state.threadId) return;
  const { data: count } = await getUnreadAdminMessageCount(state.threadId);
  updateUnreadBadge(count);
}

/* -----------------------------------------------------------
   Rendering
   ----------------------------------------------------------- */

function renderMessage(message) {
  const messagesEl = document.querySelector('[data-chat-messages]');
  const bubble = document.createElement('div');
  bubble.className = `chat-widget-msg chat-widget-msg--${message.sender_type}`;

  if (message.body) {
    const body = document.createElement('span');
    body.className = 'chat-widget-msg-text';
    body.textContent = message.body;
    bubble.appendChild(body);
  }

  if (message.attachment_path) {
    renderAttachment(bubble, message);
  }

  const time = document.createElement('span');
  time.className = 'chat-widget-msg-time';
  time.textContent = formatTimestamp(message.created_at);
  bubble.appendChild(time);

  messagesEl.appendChild(bubble);
}

/** Resolves a signed URL for the attachment, then fills in an image or a file chip. */
async function renderAttachment(bubble, message) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-widget-attachment';
  bubble.appendChild(wrap);

  const isImage = (message.attachment_type || '').startsWith('image/');
  const { data: url } = await getAttachmentSignedUrl(message.attachment_path);

  if (isImage) {
    const img = document.createElement('img');
    img.className = 'chat-widget-attachment-image';
    img.alt = message.attachment_name || 'Attachment';
    if (url) {
      img.src = url;
      img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    }
    wrap.appendChild(img);
    return;
  }

  const link = document.createElement('a');
  link.className = 'chat-widget-attachment-file';
  link.target = '_blank';
  link.rel = 'noopener';
  if (url) link.href = url;

  link.innerHTML =
    '<svg class="chat-widget-attachment-file-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M5 2.5h7l4 4v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '</svg>';

  const name = document.createElement('span');
  name.className = 'chat-widget-attachment-file-name';
  name.textContent = message.attachment_name || 'Document';
  link.appendChild(name);

  wrap.appendChild(link);
}

function renderSystemNotice(text) {
  const messagesEl = document.querySelector('[data-chat-messages]');
  const notice = document.createElement('div');
  notice.className = 'chat-widget-msg chat-widget-msg--system';
  notice.textContent = text;
  messagesEl.appendChild(notice);
  scrollToBottom();
}

function updateUnreadBadge(count) {
  const badge = document.querySelector('[data-chat-unread-badge]');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function scrollToBottom() {
  const messagesEl = document.querySelector('[data-chat-messages]');
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* -----------------------------------------------------------
   Cleanup (not currently called anywhere — pages are full
   reloads, not an SPA — but kept for completeness/future use)
   ----------------------------------------------------------- */
export function unmountChatWidget() {
  unsubscribeFromThread(state.channel);
  clearPendingFile();
  state = { threadId: null, channel: null, panelOpen: false, mounted: false, pendingFile: null, previewObjectUrl: null };
}
