-- Huntzz — complete schema, VERSION 6 (current).
--
-- This single file is safe to run on ANY database, fresh or pre-existing, and
-- brings it to version 6. It contains everything from migrations 001–006: RLS
-- lockdown, pending_input, cascade rules, alerts, stats, inbox RPCs and the
-- current chat_matchers. On a pre-existing database it adds any missing columns
-- and normalises foreign keys; on a fresh database it does the same, once.
--
-- You therefore have two equivalent upgrade paths:
--   * run THIS file, or
--   * run migrations 001 -> 002 -> 003 -> 004 -> 005 -> 006 in numeric order, once.
-- Do NOT mix-and-match in a way that re-runs 002/003 after 004: those two are
-- not re-runnable after 004 (004 replaces public.chat_matchers(bigint) with a
-- new return type, and CREATE OR REPLACE cannot change a return type).
--
-- RLS is ENABLED on every table with NO permissive policies. The bot uses the
-- service_role key (which bypasses RLS); the anon/authenticated keys get
-- nothing. Do NOT add permissive policies.
--
-- All statements are idempotent, so re-running this file is safe.

-- ===========================================================================
-- Tables
-- ===========================================================================

create table if not exists public.users (
  user_id          bigint primary key,
  username         text,
  first_name       text,
  created_at       timestamptz not null default now(),
  blocked          boolean  not null default false,
  paused_until     timestamptz,
  quiet_start      smallint,
  quiet_end        smallint,
  tz               text     not null default 'Africa/Lagos',
  setup_sound_done boolean  not null default false
);

create table if not exists public.groups (
  chat_id    bigint primary key,
  title      text not null,
  type       text not null,
  added_by   bigint references public.users(user_id) on update cascade on delete set null,
  active     boolean not null default true,
  notice_posted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id           bigserial primary key,
  user_id      bigint  not null references public.users(user_id) on update cascade on delete cascade,
  chat_id      bigint  not null references public.groups(chat_id) on update cascade,
  created_at   timestamptz not null default now(),
  active       boolean not null default true,
  alert_admins boolean not null default false,
  unique (user_id, chat_id)
);

create table if not exists public.keywords (
  id         bigserial primary key,
  user_id    bigint not null references public.users(user_id) on update cascade on delete cascade,
  chat_id    bigint not null references public.groups(chat_id) on update cascade,
  keyword    text   not null,
  created_at timestamptz not null default now(),
  unique (user_id, chat_id, keyword)
);

create table if not exists public.pending_input (
  user_id    bigint primary key references public.users(user_id) on update cascade on delete cascade,
  action     text not null,
  chat_id    bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.alerts (
  id         bigserial primary key,
  user_id    bigint not null references public.users(user_id) on update cascade on delete cascade,
  chat_id    bigint not null references public.groups(chat_id) on update cascade,
  message_id bigint,
  chat_title text,
  keywords   text[] not null default '{}',
  preview    text check (preview is null or char_length(preview) <= 200),
  link       text,
  admin_post boolean not null default false,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.stats_daily (
  day    date    not null,
  metric text    not null,
  count  integer not null default 0,
  primary key (day, metric)
);

-- ===========================================================================
-- Upgrade pre-existing tables to v4 (no-ops on a fresh database).
-- CREATE TABLE IF NOT EXISTS does NOT add columns to a table that already
-- exists, so an older install needs these explicit column additions before the
-- functions below can reference them.
-- ===========================================================================

alter table public.users         add column if not exists blocked          boolean  not null default false;
alter table public.users         add column if not exists paused_until     timestamptz;
alter table public.users         add column if not exists quiet_start      smallint;
alter table public.users         add column if not exists quiet_end        smallint;
alter table public.users         add column if not exists tz               text     not null default 'Africa/Lagos';
alter table public.users         add column if not exists setup_sound_done boolean  not null default false;
alter table public.groups        add column if not exists notice_posted_at timestamptz;
alter table public.groups        add column if not exists active           boolean  not null default true;
alter table public.subscriptions add column if not exists active           boolean  not null default true;
alter table public.subscriptions add column if not exists alert_admins     boolean  not null default false;

-- alerts FKs (a pre-existing alerts table from a partial run may lack them).
alter table public.alerts drop constraint if exists alerts_user_id_fkey;
alter table public.alerts add constraint alerts_user_id_fkey
  foreign key (user_id) references public.users(user_id) on update cascade on delete cascade;
alter table public.alerts drop constraint if exists alerts_chat_id_fkey;
alter table public.alerts add constraint alerts_chat_id_fkey
  foreign key (chat_id) references public.groups(chat_id) on update cascade;

-- pending_input.user_id -> users (may be missing on old installs).
do $$
begin
  delete from public.pending_input p
    where not exists (select 1 from public.users u where u.user_id = p.user_id);
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pending_input'::regclass and contype = 'f'
      and confrelid = 'public.users'::regclass
  ) then
    alter table public.pending_input
      add constraint pending_input_user_id_fkey
      foreign key (user_id) references public.users(user_id) on update cascade on delete cascade;
  end if;
end $$;

-- Normalise every FK: chat_id columns -> ON UPDATE CASCADE; user_id columns ->
-- ON DELETE CASCADE, except groups.added_by -> SET NULL. Metadata is read from
-- pg_constraint (real names/columns), never guessed.
drop table if exists _huntzz_fk_fix;
create temporary table _huntzz_fk_fix as
select
  c.conname,
  c.conrelid::regclass  as tbl,
  c.confrelid::regclass as reftbl,
  (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
     from unnest(c.conkey) with ordinality as u(attnum, ord)
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum) as cols,
  (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
     from unnest(c.confkey) with ordinality as u(attnum, ord)
     join pg_attribute a on a.attrelid = c.confrelid and a.attnum = u.attnum) as refcols,
  case
    when c.confrelid = 'public.users'::regclass
         and c.conrelid = 'public.groups'::regclass then ' on delete set null'
    when c.confrelid = 'public.users'::regclass   then ' on delete cascade'
    else ''
  end as action
from pg_constraint c
where c.contype = 'f'
  and c.confrelid in ('public.users'::regclass, 'public.groups'::regclass)
  and c.conrelid in ('public.groups'::regclass, 'public.subscriptions'::regclass,
                     'public.keywords'::regclass, 'public.pending_input'::regclass,
                     'public.alerts'::regclass);

do $$
declare
  r record;
begin
  for r in select * from _huntzz_fk_fix loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format(
      'alter table %s add constraint %I foreign key (%s) references %s (%s)%s on update cascade',
      r.tbl, r.conname, r.cols, r.reftbl, r.refcols, r.action
    );
  end loop;
end $$;

drop table if exists _huntzz_fk_fix;

-- ===========================================================================
-- Row Level Security: enabled everywhere, no policies
-- ===========================================================================

alter table public.users         enable row level security;
alter table public.groups        enable row level security;
alter table public.subscriptions enable row level security;
alter table public.keywords      enable row level security;
alter table public.pending_input enable row level security;
alter table public.alerts        enable row level security;
alter table public.stats_daily   enable row level security;

-- ===========================================================================
-- Indexes
-- ===========================================================================

create index if not exists alerts_user_created_idx on public.alerts (user_id, created_at desc);
create index if not exists alerts_user_read_idx    on public.alerts (user_id, is_read);

-- One alert per recipient and Telegram message. Plain-group messages have a
-- message_id too; null is excluded only for legacy/manual rows.
with duplicates as (
  select id,
         row_number() over (
           partition by user_id, chat_id, message_id
           order by created_at desc, id desc
         ) as copy_number
  from public.alerts
  where message_id is not null
)
delete from public.alerts a
using duplicates d
where a.id = d.id
  and d.copy_number > 1;

create unique index if not exists alerts_user_chat_message_uidx
  on public.alerts (user_id, chat_id, message_id)
  where message_id is not null;

-- ===========================================================================
-- Functions / RPCs
-- ===========================================================================

-- Bump a daily counter (used by in-memory counters flushed once a minute).
create or replace function public.increment_stat(p_metric text, p_by int default 1)
returns void
language sql
as $$
  insert into public.stats_daily (day, metric, count)
  values (current_date, p_metric, greatest(coalesce(p_by, 0), 0))
  on conflict (day, metric)
  do update set count = public.stats_daily.count + greatest(coalesce(excluded.count, 0), 0);
$$;

-- Move a chat (and all its rows) to a new id. Idempotent and merge-safe.
create or replace function public.migrate_chat(p_old bigint, p_new bigint)
returns void
language plpgsql
as $$
declare
  v_exists boolean;
begin
  if p_old is null or p_new is null or p_old = p_new then
    return;
  end if;

  select exists(select 1 from public.groups where chat_id = p_new) into v_exists;

  if not v_exists then
    update public.subscriptions set chat_id = p_new where chat_id = p_old;
    update public.keywords      set chat_id = p_new where chat_id = p_old;
    update public.alerts        set chat_id = p_new where chat_id = p_old;
    update public.pending_input set chat_id = p_new where chat_id = p_old;
    update public.groups        set chat_id = p_new where chat_id = p_old;
  else
    delete from public.alerts a
      where a.chat_id = p_old
        and exists (
          select 1 from public.alerts n
          where n.chat_id = p_new
            and n.user_id = a.user_id
            and n.message_id is not distinct from a.message_id
        );
    update public.alerts set chat_id = p_new where chat_id = p_old;

    update public.subscriptions n
       set active = n.active or o.active,
           alert_admins = n.alert_admins or o.alert_admins
      from public.subscriptions o
     where n.chat_id = p_new
       and o.chat_id = p_old
       and n.user_id = o.user_id;
    delete from public.subscriptions o
      where o.chat_id = p_old
        and exists (
          select 1 from public.subscriptions n
          where n.chat_id = p_new and n.user_id = o.user_id
        );
    update public.subscriptions set chat_id = p_new where chat_id = p_old;

    delete from public.keywords o
      where o.chat_id = p_old
        and exists (
          select 1 from public.keywords n
          where n.chat_id = p_new
            and n.user_id = o.user_id
            and n.keyword = o.keyword
        );
    update public.keywords set chat_id = p_new where chat_id = p_old;

    update public.pending_input set chat_id = p_new where chat_id = p_old;

    delete from public.groups where chat_id = p_old;
  end if;
end $$;

comment on function public.migrate_chat(bigint, bigint) is 'v6';

-- One row per active subscriber of an active chat. keywords may be empty;
-- alert_admins subscribers are still returned. blocked users are excluded.
drop function if exists public.chat_matchers(bigint);

create function public.chat_matchers(p_chat_id bigint)
returns table (
  user_id      bigint,
  keywords     text[],
  alert_admins boolean,
  paused_until timestamptz,
  quiet_start  smallint,
  quiet_end    smallint,
  tz           text
)
language sql
stable
set search_path = public
as $$
  select
    s.user_id,
    coalesce(array_agg(k.keyword) filter (where k.keyword is not null), '{}') as keywords,
    s.alert_admins,
    u.paused_until,
    u.quiet_start,
    u.quiet_end,
    u.tz
  from public.subscriptions s
  join public.groups g on g.chat_id = s.chat_id
  join public.users  u on u.user_id = s.user_id
  left join public.keywords k on k.user_id = s.user_id and k.chat_id = s.chat_id
  where s.chat_id = p_chat_id
    and s.active
    and g.active
    and not u.blocked
  group by s.user_id, s.alert_admins, u.paused_until, u.quiet_start, u.quiet_end, u.tz;
$$;

-- Per-keyword total + unread for a user's inbox.
create or replace function public.inbox_counts(p_user_id bigint)
returns table (keyword text, total bigint, unread bigint)
language sql
stable
set search_path = public
as $$
  select t.keyword, t.total, t.unread
  from (
    select kw as keyword,
           count(*)                              as total,
           count(*) filter (where not a.is_read) as unread
    from public.alerts a
    cross join lateral unnest(a.keywords) as kw
    where a.user_id = p_user_id
    group by kw
  ) t
  order by t.unread desc, t.total desc, t.keyword;
$$;

-- Total + unread admin-post alerts for a user's inbox.
create or replace function public.inbox_admin_counts(p_user_id bigint)
returns table (total bigint, unread bigint)
language sql
stable
set search_path = public
as $$
  select count(*)                              as total,
         count(*) filter (where not a.is_read) as unread
  from public.alerts a
  where a.user_id = p_user_id and a.admin_post;
$$;

grant execute on function public.increment_stat(text, int)    to anon, authenticated, service_role;
grant execute on function public.migrate_chat(bigint, bigint) to anon, authenticated, service_role;
grant execute on function public.chat_matchers(bigint)        to anon, authenticated, service_role;
grant execute on function public.inbox_counts(bigint)         to anon, authenticated, service_role;
grant execute on function public.inbox_admin_counts(bigint)   to anon, authenticated, service_role;
