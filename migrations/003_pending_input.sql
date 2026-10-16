-- Migration 003: pending input, blocked users, soft subscriptions
--
-- NOTE: the brief named this file 002_pending_input.sql. Slot 002 was already
-- taken by the Stage 2 matcher RPC (already applied), so this is 003. Run the
-- migrations in numeric order: 001 -> 002 -> 003.
--
-- Idempotent: safe to run more than once.

-- 1. Persistent pending input (replaces the in-memory Map in bot.js).
--    RLS is on and there are deliberately NO policies: only the service_role key
--    (which bypasses RLS) may read or write this table.
create table if not exists public.pending_input (
  user_id bigint primary key,
  action text not null,
  chat_id bigint,
  created_at timestamptz not null default now()
);

alter table public.pending_input enable row level security;

-- 2. Users blocked the bot (Telegram 403). Alerts pause until they message again.
alter table public.users add column if not exists blocked boolean not null default false;

-- 3. Soft unsubscribe: unsubscribing keeps the row (and the keywords) but sets
--    active = false, so re-subscribing is instant and no alerts are sent.
alter table public.subscriptions add column if not exists active boolean not null default true;

-- 4. Matching must respect subscriptions.active and skip blocked users.
--    (Not SECURITY DEFINER: service_role bypasses RLS, anon is filtered.)
create or replace function public.chat_matchers(p_chat_id bigint)
returns table (user_id bigint, keyword text)
language sql
stable
set search_path = public
as $$
  select s.user_id, k.keyword
  from subscriptions s
  join groups g on g.chat_id = s.chat_id
  join users u on u.user_id = s.user_id
  join keywords k on k.user_id = s.user_id and k.chat_id = s.chat_id
  where s.chat_id = p_chat_id
    and s.active
    and g.active
    and not u.blocked;
$$;

grant execute on function public.chat_matchers(bigint) to anon, authenticated, service_role;
