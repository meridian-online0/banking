/* =============================================================
   MERIDIAN — International Digital Banking
   Supabase client configuration: supabase/config.js
   This file creates a single, shared Supabase client used by
   every other module (auth.js, database.js) and by page scripts.
   SETUP
   -----
   1. Go to your Supabase project → Project Settings → API.
   2. Copy the "Project URL" into SUPABASE_URL below.
   3. Copy the "anon public" key into SUPABASE_ANON_KEY below.
   A NOTE ON THE ANON KEY
   -----------------------
   The anon key is designed to be public — it ships inside every
   browser bundle of every Supabase app. It is NOT a secret. What
   actually protects your data is Row Level Security (RLS) on
   each table in Postgres. Never put your `service_role` key in
   any file that reaches the browser; that key bypasses RLS
   entirely and must only ever be used from a trusted server
   environment (e.g. a Supabase Edge Function).
   ============================================================= */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://yuvhvmlgoawjoikmpbgp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Lz03FsI-z83uf7gqpcJhsQ_1oim5oED';

if (SUPABASE_URL.includes('YOUR_SUPABASE_PROJECT_URL')) {
  console.warn(
    '[Meridian] supabase/config.js still has placeholder credentials. ' +
    'Add your Project URL and anon key before testing auth or database calls.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'meridian-auth',
  },
});

/* Shared route map so auth.js / page scripts don't hard-code paths.
   All page scripts live under /pages/, one level below the site root. */
export const ROUTES = {
  login: 'login.html',
  register: 'register.html',
  dashboard: 'dashboard.html',
  home: '../index.html',
  resetPassword: 'reset-password.html',
};
