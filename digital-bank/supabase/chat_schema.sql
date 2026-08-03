-- =============================================================
-- MERIDIAN — International Digital Banking
-- Live support chat schema: supabase/chat_schema.sql
--
-- Two tables: one open thread per customer at a time, plus its
-- messages. Real human agents reply through the admin panel
-- (pages/admin/admin-support.html) — this schema has no bot/AI
-- concept, just 'user' / 'admin' / 'system' senders.
--
-- GUEST / VISITOR CHAT
-- ---------------------
-- Signed-out visitors on index.html get a Supabase Anonymous
-- Auth session (supabase.auth.signInAnonymously(), called from
-- chat-widget.js) rather than a hand-rolled guest_id column.
-- That means an anonymous visitor still has a real auth.uid(),
-- so chat_threads.user_id stays NOT NULL and every RLS policy
-- below is identical for registered customers and anonymous
-- visitors — no separate "guest" code path, no client-supplied
-- identity to trust.
--
-- The admin panel tells the two apart by whether a user_profiles
-- row exists for chat_threads.user_id: registered customers have
-- one (created at full signup), anonymous visitors don't. No
-- profile row -> render as "Visitor" in admin-support.js.
--
-- REQUIRES: Anonymous Sign-ins enabled in the Supabase dashboard
-- (Authentication -> Providers -> Anonymous Sign-ins). This
-- schema does not (and cannot) turn that on for you.
--
-- Run this after schema.sql. This file already fills in the
-- admin-side RLS policies using public.is_admin(), which
-- admin_schema.sql defines (referenced directly in
-- assets/js/admin/admin-layout.js's comments).
-- =============================================================

create table if not exists chat_threads (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  status             text not null default 'open' check (status in ('open', 'closed')),
  assigned_admin_id  uuid references auth.users(id),
  last_seen_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_chat_threads_user_id     on chat_threads(user_id);
create index if not exists idx_chat_threads_status      on chat_threads(status);
create index if not exists idx_chat_threads_last_seen   on chat_threads(last_seen_at desc);

create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references chat_threads(id) on delete cascade,
  sender_type text not null check (sender_type in ('user', 'admin', 'system')),
  sender_id   uuid references auth.users(id),
  body        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);

create index if not exists idx_chat_messages_thread_id  on chat_messages(thread_id);
create index if not exists idx_chat_messages_created_at on chat_messages(created_at);

-- -----------------------------------------------------------
-- Welcome message — fires the instant a thread is created, so
-- the customer never sees an empty panel and always learns that
-- a live agent is on call 24/7 and can join at any moment. Fires
-- identically for registered customers and anonymous visitors —
-- both are just rows in auth.users as far as this trigger cares.
-- -----------------------------------------------------------
create or replace function chat_thread_welcome_message()
returns trigger as $$
begin
  insert into chat_messages (thread_id, sender_type, sender_id, body)
  values (
    new.id,
    'system',
    null,
    'You''re connected to Meridian Support. A live agent is available 24/7 and may join this conversation at any time — go ahead and send your message and someone will be right with you.'
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_chat_thread_welcome on chat_threads;
create trigger trg_chat_thread_welcome
  after insert on chat_threads
  for each row execute function chat_thread_welcome_message();

-- -----------------------------------------------------------
-- updated_at / last_seen_at bookkeeping.
--
-- updated_at always bumps (used for "most recently active thread"
-- sorting in the admin inbox, admin replies included).
--
-- last_seen_at ONLY bumps when the message came from the
-- customer/visitor themselves (sender_type = 'user') — it's a
-- presence signal for "is this visitor still here", so an admin
-- typing a reply must not make the visitor look freshly active.
-- -----------------------------------------------------------
create or replace function touch_chat_thread()
returns trigger as $$
begin
  update chat_threads
  set updated_at   = now(),
      last_seen_at = case when new.sender_type = 'user' then now() else last_seen_at end
  where id = new.thread_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_touch_chat_thread on chat_messages;
create trigger trg_touch_chat_thread
  after insert on chat_messages
  for each row execute function touch_chat_thread();

-- -----------------------------------------------------------
-- Heartbeat — called periodically by chat-widget.js while the
-- chat panel is open, so a visitor who is present but not
-- actively sending messages still shows as "Online now" in the
-- admin inbox rather than going stale. Exposed as a SECURITY
-- DEFINER function (rather than a broad UPDATE policy on
-- chat_threads for regular users) so a customer/visitor can only
-- ever bump their own last_seen_at — never touch status or
-- assigned_admin_id, which stay admin-only via the policy below.
-- -----------------------------------------------------------
create or replace function chat_heartbeat(p_thread_id uuid)
returns void as $$
begin
  update chat_threads
  set last_seen_at = now()
  where id = p_thread_id
    and user_id = auth.uid();
end;
$$ language plpgsql security definer;

grant execute on function chat_heartbeat(uuid) to authenticated;

-- -----------------------------------------------------------
-- Row Level Security — customer / visitor side
-- (identical for registered customers and anonymous visitors —
-- both simply have a Supabase auth.uid())
-- -----------------------------------------------------------
alter table chat_threads  enable row level security;
alter table chat_messages enable row level security;

create policy "Users can view their own chat threads"
  on chat_threads for select
  using (auth.uid() = user_id);

create policy "Users can create their own chat threads"
  on chat_threads for insert
  with check (auth.uid() = user_id);

create policy "Users can view messages in their own threads"
  on chat_messages for select
  using (
    exists (
      select 1 from chat_threads
      where chat_threads.id = chat_messages.thread_id
      and chat_threads.user_id = auth.uid()
    )
  );

create policy "Users can send messages in their own threads"
  on chat_messages for insert
  with check (
    sender_type = 'user'
    and sender_id = auth.uid()
    and exists (
      select 1 from chat_threads
      where chat_threads.id = chat_messages.thread_id
      and chat_threads.user_id = auth.uid()
    )
  );

create policy "Users can mark admin messages read in their own threads"
  on chat_messages for update
  using (
    exists (
      select 1 from chat_threads
      where chat_threads.id = chat_messages.thread_id
      and chat_threads.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from chat_threads
      where chat_threads.id = chat_messages.thread_id
      and chat_threads.user_id = auth.uid()
    )
  );

-- -----------------------------------------------------------
-- Row Level Security — admin side
-- Uses public.is_admin(), defined in admin_schema.sql (see the
-- reference to it in assets/js/admin/admin-layout.js's comments).
-- If your actual function name/signature differs from
-- public.is_admin() with no arguments, these five policies are
-- the ones to adjust — everything else in this file is unaffected.
-- -----------------------------------------------------------
create policy "Admins can view all chat threads"
  on chat_threads for select
  using (public.is_admin());

create policy "Admins can update any chat thread"
  on chat_threads for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins can view all chat messages"
  on chat_messages for select
  using (public.is_admin());

create policy "Admins can send messages as admin"
  on chat_messages for insert
  with check (
    sender_type = 'admin'
    and sender_id = auth.uid()
    and public.is_admin()
  );

create policy "Admins can mark user messages read"
  on chat_messages for update
  using (public.is_admin())
  with check (public.is_admin());

-- Realtime — needed for admin replies to push to the widget, and
-- for new visitor messages to push to the admin inbox, without
-- polling. Skip if your project already has this table added to
-- the publication.
alter publication supabase_realtime add table chat_messages;
alter publication supabase_realtime add table chat_threads;



-- -----------------------------------------------------------
-- Lets a signed-in user (or anonymous visitor) close their own
-- thread — used by "Clear conversation" in the chat widget. Same
-- reasoning as chat_heartbeat(): SECURITY DEFINER + an explicit
-- user_id = auth.uid() check, rather than a broad UPDATE policy
-- on chat_threads that a customer could otherwise use to touch
-- assigned_admin_id or someone else's thread.
-- -----------------------------------------------------------
create or replace function chat_close_thread(p_thread_id uuid)
returns void as $$
begin
  update chat_threads
  set status = 'closed'
  where id = p_thread_id
    and user_id = auth.uid();
end;
$$ language plpgsql security definer;

grant execute on function chat_close_thread(uuid) to authenticated;




