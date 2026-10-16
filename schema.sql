-- Huntzz — base schema.
--
-- A fresh database is created by running, in order:
--   1. this file (schema.sql)
--   2. migrations/001_lock_down_rls.sql
--   3. migrations/002_chat_matchers.sql
--   4. migrations/003_pending_input.sql
--
-- Run each in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- All statements are idempotent, so re-running is safe.
--
-- NOTE: RLS is enabled and NO permissive policies are created here. The bot uses
-- the service_role key (which bypasses RLS); the anon/authenticated keys get
-- nothing. Do NOT add permissive policies.

create table if not exists users (
  user_id bigint primary key,
  username text,
  first_name text,
  created_at timestamptz not null default now()
);

create table if not exists groups (
  chat_id bigint primary key,
  title text not null,
  type text not null,
  added_by bigint references users(user_id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id bigserial primary key,
  user_id bigint not null references users(user_id),
  chat_id bigint not null references groups(chat_id),
  created_at timestamptz not null default now(),
  unique (user_id, chat_id)
);

create table if not exists keywords (
  id bigserial primary key,
  user_id bigint not null references users(user_id),
  chat_id bigint not null references groups(chat_id),
  keyword text not null,
  created_at timestamptz not null default now(),
  unique (user_id, chat_id, keyword)
);

alter table users enable row level security;
alter table groups enable row level security;
alter table subscriptions enable row level security;
alter table keywords enable row level security;
