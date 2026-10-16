-- Migration 002: single-query matcher lookup
--
-- Stage 2 replaces the per-message two-query pattern (all keywords for a chat +
-- all subscriptions for a chat) with one join. PostgREST cannot embed keywords
-- under subscriptions (there is no direct foreign key between them), so we expose
-- a small function instead.
--
-- SECURITY: this function is *not* SECURITY DEFINER, so it runs with the caller's
-- rights. The bot's service_role key bypasses RLS and sees rows; the anon key is
-- filtered by RLS (which migration 001 left with no policies) and gets nothing.
--
-- Idempotent: create or replace.

create or replace function public.chat_matchers(p_chat_id bigint)
returns table (user_id bigint, keyword text)
language sql
stable
set search_path = public
as $$
  select s.user_id, k.keyword
  from subscriptions s
  join groups g on g.chat_id = s.chat_id
  join keywords k on k.user_id = s.user_id and k.chat_id = s.chat_id
  where s.chat_id = p_chat_id
    and g.active;
$$;

grant execute on function public.chat_matchers(bigint) to anon, authenticated, service_role;
