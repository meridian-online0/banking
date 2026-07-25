-- =============================================================
-- MERIDIAN — International Digital Banking
-- Migration 008: picture/document attachments for live chat
-- supabase/migrations/008_chat_attachments.sql
--
-- Run AFTER chat_schema.sql (chat_threads / chat_messages must
-- already exist). Adds attachment columns to chat_messages and a
-- private Storage bucket + RLS policies scoped the same way
-- chat_messages' own policies are: "does this file's thread
-- belong to me?"
-- =============================================================

-- -----------------------------------------------------------
-- chat_messages: allow a message to carry an attachment instead
-- of (or alongside) text. body becomes optional, but at least one
-- of body / attachment_path must be present.
-- -----------------------------------------------------------
alter table chat_messages alter column body drop not null;

alter table chat_messages add column if not exists attachment_path text;
alter table chat_messages add column if not exists attachment_name text;
alter table chat_messages add column if not exists attachment_type text;
alter table chat_messages add column if not exists attachment_size integer;

alter table chat_messages
  add constraint chat_messages_body_or_attachment
  check (body is not null or attachment_path is not null);

-- -----------------------------------------------------------
-- Storage bucket — private; access goes through signed URLs
-- (see getAttachmentSignedUrl() in supabase/chat.js), never a
-- public URL. file_size_limit / allowed_mime_types enforce the
-- same 10MB / image-or-PDF-or-Word limits chat.js checks
-- client-side, so a modified client can't bypass them.
-- -----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760, -- 10MB
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Files are stored as '<thread_id>/<uuid>-<filename>' — the first
-- path segment is always the thread id, which is how these
-- policies tie a file back to its owning thread without a
-- separate lookup table.
create policy "Users can upload attachments to their own threads"
  on storage.objects for insert
  with check (
    bucket_id = 'chat-attachments'
    and exists (
      select 1 from chat_threads
      where chat_threads.id::text = (storage.foldername(name))[1]
      and chat_threads.user_id = auth.uid()
    )
  );

create policy "Users can view attachments in their own threads"
  on storage.objects for select
  using (
    bucket_id = 'chat-attachments'
    and exists (
      select 1 from chat_threads
      where chat_threads.id::text = (storage.foldername(name))[1]
      and chat_threads.user_id = auth.uid()
    )
  );

-- -----------------------------------------------------------
-- TODO — admin side, same caveat as chat_schema.sql: add once
-- admin_schema.sql's role-check helper is available to reference:
--
--   create policy "Admins can view all chat attachments"
--     on storage.objects for select
--     using ( bucket_id = 'chat-attachments' and <is_admin() check> );
--
--   create policy "Admins can upload attachments as admin"
--     on storage.objects for insert
--     with check ( bucket_id = 'chat-attachments' and <is_admin() check> );
-- -----------------------------------------------------------
