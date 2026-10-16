-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)

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

alter table users enable row level security;
alter table groups enable row level security;
alter table subscriptions enable row level security;

create policy "full access users" on users for all using (true) with check (true);
create policy "full access groups" on groups for all using (true) with check (true);
create policy "full access subscriptions" on subscriptions for all using (true) with check (true);
