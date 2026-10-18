-- Migration 006: safe chat migration merges and group notice state
--
-- Run after 001 -> 002 -> 003 -> 004 -> 005.
-- Idempotent: the column and function may be recreated safely.

alter table public.groups
  add column if not exists notice_posted_at timestamptz;

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
    return;
  end if;

  -- Keep the existing new-chat alert when the same recipient already has the
  -- same Telegram message there; move all other old-chat alerts.
  delete from public.alerts a
    where a.chat_id = p_old
      and exists (
        select 1
        from public.alerts n
        where n.chat_id = p_new
          and n.user_id = a.user_id
          and n.message_id is not distinct from a.message_id
      );
  update public.alerts set chat_id = p_new where chat_id = p_old;

  -- Merge subscription flags before removing the old duplicate row.
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
        select 1
        from public.subscriptions n
        where n.chat_id = p_new
          and n.user_id = o.user_id
      );
  update public.subscriptions set chat_id = p_new where chat_id = p_old;

  -- Existing new-chat keywords win; non-duplicates are moved across.
  delete from public.keywords o
    where o.chat_id = p_old
      and exists (
        select 1
        from public.keywords n
        where n.chat_id = p_new
          and n.user_id = o.user_id
          and n.keyword = o.keyword
      );
  update public.keywords set chat_id = p_new where chat_id = p_old;

  -- There is one pending row per user, so moving its chat id cannot collide.
  update public.pending_input set chat_id = p_new where chat_id = p_old;

  delete from public.groups where chat_id = p_old;
end $$;

comment on function public.migrate_chat(bigint, bigint) is 'v6';

 grant execute on function public.migrate_chat(bigint, bigint)
   to anon, authenticated, service_role;
