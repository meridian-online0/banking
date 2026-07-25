-- =============================================================
-- MERIDIAN — International Digital Banking
-- Live support chat schema: supabase/chat_schema.sql
--
-- Two tables: one open thread per customer at a time, plus its
-- messages. Real human agents reply through the admin panel
-- (pages/admin/admin-support.html) — this schema has no bot/AI
-- concept, just 'user' / 'admin' / 'system' senders.
--
-- Run this after schema.sql. If admin_schema.sql's roles table
-- and its role-check helper (e.g. is_admin()) are already in
-- place, add the admin-side RLS policies noted at the bottom
-- once you can see that file's exact function name/signature —
-- everything below only covers the customer-facing widget.
-- =============================================================

create table if not exists chat_threads (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  status             text not null default 'open' check (status in ('open', 'closed')),
  assigned_admin_id  uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_chat_threads_user_id on chat_threads(user_id);
create index if not exists idx_chat_threads_status   on chat_threads(status);

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
-- a live agent is on call 24/7 and can join at any moment.
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
-- updated_at bookkeeping on the thread whenever a message lands
-- -----------------------------------------------------------
create or replace function touch_chat_thread()
returns trigger as $$
begin
  update chat_threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_touch_chat_thread on chat_messages;
create trigger trg_touch_chat_thread
  after insert on chat_messages
  for each row execute function touch_chat_thread();

-- -----------------------------------------------------------
-- Row Level Security — customer side
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
-- TODO — admin side (add once admin_schema.sql's role-check
-- helper is available to reference here):
--
--   create policy "Admins can view all chat threads"
--     on chat_threads for select using ( <is_admin() check> );
--
--   create policy "Admins can update any chat thread"
--     on chat_threads for update using ( <is_admin() check> );
--
--   create policy "Admins can view all chat messages"
--     on chat_messages for select using ( <is_admin() check> );
--
--   create policy "Admins can send messages as admin"
--     on chat_messages for insert with check (
--       sender_type = 'admin' and sender_id = auth.uid()
--       and <is_admin() check>
--     );
-- -----------------------------------------------------------

-- Realtime — needed for admin replies to push to the widget
-- without polling. Skip if your project already has this table
-- added to the publication.
alter publication supabase_realtime add table chat_messages;
