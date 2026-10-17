-- Migration 004: the "v4" upgrade.
--   * users: pause / quiet hours / timezone / sound-step columns
--   * subscriptions: alert_admins
--   * alerts: the inbox (7-day, capped) + indexes
--   * stats_daily + increment_stat()
--   * foreign-key hygiene (the /deleteme prerequisite)
--   * migrate_chat() for basic-group -> supergroup upgrades
--   * chat_matchers() replaced with a one-row-per-subscriber shape
--   * inbox_counts() / inbox_admin_counts()
--
-- Run order (existing installs): 001 -> 002 -> 003 -> 004.
-- Migrations run in order, ONCE. 002 and 003 are NOT re-runnable after 004,
-- because 004 replaces public.chat_matchers(bigint) with a different return type
-- and the earlier files use CREATE OR REPLACE, which cannot change a function's
-- return type. This file (004) *is* safe to re-run (it DROPs the function first).
--
-- Idempotent: safe to run more than once.
--
-- NOTE: RLS stays ENABLED with NO permissive policies on every table. Only the
-- service_role key (which bypasses RLS) may read or write. Do NOT add policies.

-- ---------------------------------------------------------------------------
-- 1. users: pause, quiet hours, timezone, sound-step flag
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists paused_until     timestamptz;
alter table public.users add column if not exists quiet_start      smallint;
alter table public.users add column if not exists quiet_end        smallint;
alter table public.users add column if not exists tz               text not null default 'Africa/Lagos';
alter table public.users add column if not exists setup_sound_done boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. subscriptions: per-follow "alert me about admin posts too" flag
-- ---------------------------------------------------------------------------
alter table public.subscriptions add column if not exists alert_admins boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. alerts: one row per (message, recipient) that the inbox shows
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id          bigserial primary key,
  user_id     bigint not null,
  chat_id     bigint not null,
  message_id  bigint,
  chat_title  text,
  keywords    text[] not null default '{}',
  preview     text check (preview is null or char_length(preview) <= 200),
  link        text,
  admin_post  boolean not null default false,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Inline FKs (see section 6 which normalises every FK consistently).
alter table public.alerts
  drop constraint if exists alerts_user_id_fkey;
alter table public.alerts
  add constraint alerts_user_id_fkey
  foreign key (user_id) references public.users(user_id)
  on update cascade on delete cascade;

alter table public.alerts
  drop constraint if exists alerts_chat_id_fkey;
alter table public.alerts
  add constraint alerts_chat_id_fkey
  foreign key (chat_id) references public.groups(chat_id)
  on update cascade;

create index if not exists alerts_user_created_idx on public.alerts (user_id, created_at desc);
create index if not exists alerts_user_read_idx    on public.alerts (user_id, is_read);

alter table public.alerts enable row level security;

-- ---------------------------------------------------------------------------
-- 4. stats_daily: tiny rollup table + increment RPC
-- ---------------------------------------------------------------------------
create table if not exists public.stats_daily (
  day    date    not null,
  metric text    not null,
  count  integer not null default 0,
  primary key (day, metric)
);

alter table public.stats_daily enable row level security;

create or replace function public.increment_stat(p_metric text, p_by int default 1)
returns void
language sql
as $$
  insert into public.stats_daily (day, metric, count)
  values (current_date, p_metric, greatest(coalesce(p_by, 0), 0))
  on conflict (day, metric)
  do update set count = public.stats_daily.count + greatest(coalesce(excluded.count, 0), 0);
$$;

-- ---------------------------------------------------------------------------
-- 5. pending_input.user_id -> users (ON DELETE CASCADE)
--    /deleteme deletes the user row; this FK makes that safe even if a stale
--    pending row exists. Orphaned pending rows (transient state) are cleared
--    first so the constraint can always be added.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pending_input' and column_name = 'user_id'
  ) then
    delete from public.pending_input p
      where not exists (select 1 from public.users u where u.user_id = p.user_id);

    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.pending_input'::regclass
        and contype = 'f'
        and confrelid = 'public.users'::regclass
    ) then
      alter table public.pending_input
        add constraint pending_input_user_id_fkey
        foreign key (user_id) references public.users(user_id)
        on update cascade on delete cascade;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Foreign-key hygiene.
--    * every FK whose columns point at groups(chat_id) -> ON UPDATE CASCADE
--    * every FK to users(user_id) -> ON DELETE CASCADE,
--      EXCEPT groups.added_by -> ON DELETE SET NULL (a chat can outlive its adder)
--    IMPORTANT: migrate_chat() already moves children explicitly, so this is
--    belt-and-braces for the ON UPDATE path.
--    The metadata is read from pg_constraint (real names/columns), not guessed.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7. migrate_chat(p_old, p_new): move a chat (and all its rows) to a new id.
--    Used when a basic group becomes a supergroup (Telegram sends a
--    migrate_to_chat_id service message). Idempotent and merge-safe: if the new
--    id already exists, rows are merged and unique collisions resolved.
-- ---------------------------------------------------------------------------
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
    -- No conflict: move children explicitly, then the group row itself.
    update public.subscriptions set chat_id = p_new where chat_id = p_old;
    update public.keywords      set chat_id = p_new where chat_id = p_old;
    update public.alerts        set chat_id = p_new where chat_id = p_old;
    update public.pending_input set chat_id = p_new where chat_id = p_old;
    update public.groups        set chat_id = p_new where chat_id = p_old;
  else
    -- Merge into the existing p_new row.

    -- subscriptions: drop rows that would collide on (user_id, chat_id)...
    delete from public.subscriptions s
      where s.chat_id = p_old
        and exists (
          select 1 from public.subscriptions t
          where t.chat_id = p_new and t.user_id = s.user_id
        );
    -- ...then move the rest.
    update public.subscriptions set chat_id = p_new where chat_id = p_old;

    -- keywords: same idea on (user_id, chat_id, keyword).
    delete from public.keywords k
      where k.chat_id = p_old
        and exists (
          select 1 from public.keywords t
          where t.chat_id = p_new and t.user_id = k.user_id and t.keyword = k.keyword
        );
    update public.keywords set chat_id = p_new where chat_id = p_old;

    -- alerts + pending_input have no natural key: just move them.
    update public.alerts        set chat_id = p_new where chat_id = p_old;
    update public.pending_input set chat_id = p_new where chat_id = p_old;

    -- Finally drop the now-empty old group row.
    delete from public.groups where chat_id = p_old;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. chat_matchers(p_chat_id): ONE row per active subscriber of an active chat.
--    keywords is a text[] (possibly empty). Subscribers with alert_admins = true
--    are returned even with zero keywords. blocked users are excluded. Pause /
--    quiet-hours / tz travel with the row so the bot needs no extra queries.
--    DROP first: the return type changed (CREATE OR REPLACE cannot do that).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 9. Inbox aggregation helpers.
--    inbox_counts: per-keyword total + unread for one user (unnests alerts.keywords).
--    inbox_admin_counts: total + unread admin-post alerts for one user.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 10. Grants (functions default to PUBLIC execute; keep it explicit).
-- ---------------------------------------------------------------------------
grant execute on function public.increment_stat(text, int)      to anon, authenticated, service_role;
grant execute on function public.migrate_chat(bigint, bigint)   to anon, authenticated, service_role;
grant execute on function public.chat_matchers(bigint)          to anon, authenticated, service_role;
grant execute on function public.inbox_counts(bigint)           to anon, authenticated, service_role;
grant execute on function public.inbox_admin_counts(bigint)     to anon, authenticated, service_role;
