-- =============================================================
-- MERIDIAN — International Digital Banking
-- supabase/migrations/009_admin_chat_attachments_upload_policy.sql
--
-- Adds the missing half of admin attachment access. The existing
-- "Admins can view all chat attachments" SELECT policy on
-- storage.objects has no matching INSERT policy — admins can only
-- upload to a thread today if they happen to own it (the
-- customer-scoped "Users can upload attachments to their own
-- threads" policy), which is never true for an admin replying to
-- someone else's thread. This is why admin-side image sends have
-- been failing at the storage layer even independent of the
-- attachment_path/attachment_url column mismatch fixed in
-- admin-chat.js.
--
-- Unlike the customer policy, this does NOT scope by thread
-- ownership — an admin can legitimately attach a file to any
-- thread, the same way "Admins can send messages as admin" on
-- chat_messages (chat_schema.sql) has no thread-ownership check,
-- only is_admin().
-- =============================================================

create policy "Admins can upload chat attachments"
  on storage.objects for insert
  to public
  with check (
    bucket_id = 'chat-attachments'
    and is_admin()
  );
