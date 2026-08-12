/* =============================================================
   MERIDIAN — International Digital Banking
   Storage module: supabase/storage.js

   Wraps Supabase Storage for the things this app uploads files
   for: profile photos (profile.html → .profile-avatar-edit),
   support-ticket attachments, and identity documents (profile.html
   → Account limits > Upload documents). Same { data, error }
   contract as auth.js / database.js.

   BUCKET SETUP (do this once in the Supabase dashboard, or via SQL):
     - "avatars"               public bucket, 2MB file size limit,
                                image/* only. Path convention:
                                avatars/{user_id}/{filename}
     - "support-attachments"   private bucket. Path convention:
                                support-attachments/{user_id}/{ticket_id}/{filename}
                                Read access should be gated by an RLS
                                policy on storage.objects, not by the
                                bucket being public.
     - "identity-documents"    private bucket, 10MB file size limit.
                                Path convention:
                                identity-documents/{user_id}/{document_id}/{filename}
                                Created by migration 016's Part G,
                                with its own owner-scoped + admin-read
                                storage.objects RLS policies — same
                                private-bucket pattern as
                                support-attachments.
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

const AVATAR_BUCKET = 'avatars';
const ATTACHMENTS_BUCKET = 'support-attachments';
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB, matches the bucket's configured limit

/* -----------------------------------------------------------
   Generic helpers — usable against any bucket
   ----------------------------------------------------------- */

/** Uploads a file to `bucket/path`, overwriting anything already there. */
export async function uploadFile(bucket, path, file, { contentType } = {}) {
  const { data, error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: true,
    contentType: contentType || file.type || undefined,
    cacheControl: '3600',
  });
  return { data, error: error ? error.message : null };
}

/** Public URL for a file in a public bucket. Returns null if the bucket is private. */
export function getPublicUrl(bucket, path) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

/** Time-limited signed URL for a file in a private bucket (default: 1 hour). */
export async function getSignedUrl(bucket, path, expiresInSeconds = 3600) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  return { data: data?.signedUrl ?? null, error: error ? error.message : null };
}

export async function removeFile(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).remove([path]);
  return { data, error: error ? error.message : null };
}

export async function listFiles(bucket, folder = '') {
  const { data, error } = await supabase.storage.from(bucket).list(folder, {
    sortBy: { column: 'created_at', order: 'desc' },
  });
  return { data: data ?? [], error: error ? error.message : null };
}

/* -----------------------------------------------------------
   Avatars — used by profile.html's "change profile photo" button
   ----------------------------------------------------------- */

function fileExtension(file) {
  const fromName = file.name?.split('.').pop();
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  return (file.type || 'image/jpeg').split('/').pop();
}

/**
 * Uploads a new avatar for the current (or given) user, updates
 * user_profiles.profile_photo to the resulting public URL, and
 * returns that URL so the caller can update the <img>/initials
 * element immediately without a re-fetch.
 */
export async function uploadAvatar(file, userId) {
  if (!file) return { data: null, error: 'No file selected.' };
  if (!file.type.startsWith('image/')) return { data: null, error: 'Please choose an image file.' };
  if (file.size > MAX_AVATAR_BYTES) return { data: null, error: 'Image must be smaller than 2MB.' };

  let uid = userId;
  if (!uid) {
    const { data: user } = await getCurrentUser();
    uid = user?.id;
  }
  if (!uid) return { data: null, error: 'Not signed in.' };

  const path = `${uid}/avatar-${Date.now()}.${fileExtension(file)}`;
  const { error: uploadError } = await uploadFile(AVATAR_BUCKET, path, file);
  if (uploadError) return { data: null, error: uploadError };

  const publicUrl = getPublicUrl(AVATAR_BUCKET, path);

  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({ profile_photo: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', uid);

  if (profileError) return { data: { url: publicUrl, path }, error: `Uploaded, but profile wasn't updated: ${profileError.message}` };

  return { data: { url: publicUrl, path }, error: null };
}

export async function removeAvatar(path) {
  return removeFile(AVATAR_BUCKET, path);
}

/* -----------------------------------------------------------
   Support-ticket attachments
   ----------------------------------------------------------- */

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

/** Uploads one attachment for a support ticket and returns its storage path (not a public URL — bucket is private). */
export async function uploadTicketAttachment(ticketId, file, userId) {
  if (!file) return { data: null, error: 'No file selected.' };
  if (file.size > MAX_ATTACHMENT_BYTES) return { data: null, error: 'File must be smaller than 10MB.' };

  let uid = userId;
  if (!uid) {
    const { data: user } = await getCurrentUser();
    uid = user?.id;
  }
  if (!uid) return { data: null, error: 'Not signed in.' };

  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${uid}/${ticketId}/${Date.now()}-${safeName}`;
  const { error } = await uploadFile(ATTACHMENTS_BUCKET, path, file);
  if (error) return { data: null, error };

  return { data: { path }, error: null };
}

export async function getTicketAttachmentUrl(path) {
  return getSignedUrl(ATTACHMENTS_BUCKET, path);
}

export async function listTicketAttachments(userId, ticketId) {
  return listFiles(ATTACHMENTS_BUCKET, `${userId}/${ticketId}`);
}

/* -----------------------------------------------------------
   Identity documents — used by the Account limits > Upload
   documents flow (submitIdentityDocument() in database.js)
   -----------------------------------------------------------
   Mirrors uploadTicketAttachment()'s shape: this only uploads the
   file and returns its path — the caller (submitIdentityDocument()
   in database.js) is responsible for inserting the tracking row
   into identity_documents, same division of labor as ticket
   attachments/support_tickets above.
   ----------------------------------------------------------- */

const IDENTITY_DOCS_BUCKET = 'identity-documents';
const MAX_IDENTITY_DOC_BYTES = 10 * 1024 * 1024; // matches the bucket's configured limit

/**
 * Uploads one identity/proof-of-address file for a pending
 * identity_documents row. documentId should be the same UUID the
 * caller is about to insert as that row's primary key, so the
 * storage path and the DB row line up.
 */
export async function uploadIdentityDocument(documentId, file, userId) {
  if (!file) return { data: null, error: 'No file selected.' };
  if (file.size > MAX_IDENTITY_DOC_BYTES) return { data: null, error: 'That file is too large — the limit is 10MB.' };

  let uid = userId;
  if (!uid) {
    const { data: user } = await getCurrentUser();
    uid = user?.id;
  }
  if (!uid) return { data: null, error: 'Not signed in.' };

  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${uid}/${documentId}/${safeName}`;
  const { error } = await uploadFile(IDENTITY_DOCS_BUCKET, path, file);
  if (error) return { data: null, error };

  return { data: { path }, error: null };
}
