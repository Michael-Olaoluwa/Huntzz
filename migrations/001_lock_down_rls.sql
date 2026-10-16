-- Migration 001: lock down Row Level Security
--
-- Goal: RLS stays ENABLED on every table and there are NO permissive policies.
-- The bot uses the Supabase service_role key, which has the BYPASSRLS attribute,
-- so it keeps full read/write access. The anon and authenticated keys get nothing.
--
-- How to verify (after running this):
--   1. In the Supabase dashboard -> Settings -> API, copy the *anon* public key.
--   2. Run a query with the anon key, e.g. in the SQL editor as the anon role,
--      or from a throwaway script using the anon key:
--        supabase.from('users').select('*').limit(1)
--      Each of users, groups, subscriptions, keywords must return an empty array
--      (RLS filters everything) or a permission error -- never rows.
--   3. With the service_role key the bot must keep working exactly as before.
--
-- This migration is idempotent: it is safe to run more than once.

-- 1. Make sure RLS is enabled on every table (no-op if already enabled).
alter table public.users enable row level security;
alter table public.groups enable row level security;
alter table public.subscriptions enable row level security;
alter table public.keywords enable row level security;

-- 2. Drop every existing policy on these tables. Looping over pg_policies means
--    we do not have to hard-code policy names (schema.sql created several named
--    "full access ..." policies that must disappear).
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('users', 'groups', 'subscriptions', 'keywords')
  loop
    execute format('drop policy if exists %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;
