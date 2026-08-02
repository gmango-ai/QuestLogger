-- Call-side resilience (WS7): lock down the internal sweep/reconcile RPCs.
--
-- sweep_abandoned_sync_sessions() and reconcile_room_session(uuid) are internal
-- maintenance functions that END / delete sessions as SECURITY DEFINER. Only the
-- cron job (via sweep_sync_sessions()) and the server should ever run them — no
-- client does today:
--   • The client calls sweep_expired_sync_sessions() (meeting auto-close) — left
--     granted — and start_or_join_room_session(), which inlines the reconcile
--     logic itself rather than calling reconcile_room_session().
--   • sweep_sync_sessions() (the cron entry point) is SECURITY DEFINER and calls
--     sweep_abandoned_sync_sessions() internally; that definer chain resolves
--     against the function owner's privileges, so it keeps working after this.
-- Left executable by any authenticated user, a stray client call could tear down
-- other people's live sessions — exactly the ejection this workstream fixes.
--
-- NOTE: Postgres grants EXECUTE to PUBLIC by default. Revoking only from
-- anon/authenticated would be a no-op while PUBLIC still permits it (EXECUTE is
-- allowed if ANY granted role permits it), so we revoke PUBLIC as well. The
-- service role keeps EXECUTE for cron / server-side use.

revoke execute on function public.sweep_abandoned_sync_sessions() from public, anon, authenticated;
revoke execute on function public.reconcile_room_session(uuid)    from public, anon, authenticated;

grant execute on function public.sweep_abandoned_sync_sessions() to service_role;
grant execute on function public.reconcile_room_session(uuid)    to service_role;
