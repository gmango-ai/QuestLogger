-- Stop anonymous (guest) callers from triggering the global session sweep.
--
-- 20260810130000 re-granted EXECUTE on sweep_expired_sync_sessions to
-- `authenticated` because real members call it from QuickActionsPopover /
-- MeetingCountdown. But anonymous guests carry the `authenticated` role too, so
-- they could invoke this SECURITY DEFINER function and globally delete every
-- expired sync session — a maintenance action a guest has no business running
-- (authenticated must NOT imply org membership).
--
-- Add a guard: the sweep is a no-op for anonymous callers (return 0 rather than
-- raise, so no guest code path errors), while members sweep exactly as before.
-- CREATE OR REPLACE of the live body with one added early-return.
create or replace function public.sweep_expired_sync_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  -- Anonymous guests are not members; they must not run global maintenance.
  if public.is_anonymous_auth() then
    return 0;
  end if;

  with deleted as (
    delete from public.sync_sessions
     where expires_at is not null
       and expires_at <= pg_catalog.now()
     returning 1
  )
  select count(*) into v_count from deleted;
  return v_count;
end;
$$;

notify pgrst, 'reload schema';
