-- Lock down notification-emit internals + anon-callable maintenance sweeps.
--
-- These SECURITY DEFINER functions had EXECUTE for anon / authenticated / PUBLIC
-- with NO authorization check. In particular a RAW anonymous request (public anon
-- key, no session) could call emit_notification / emit_event / _nd_insert_delivery
-- with a caller-supplied recipient + fully attacker-controlled type/title/body/
-- payload and a SPOOFED actor_user_id — injecting phishing/spam into any user's
-- feed (they read it via their own RLS on notifications / notification_deliveries).
--
-- They are internal helpers: their only legitimate callers are other SECURITY
-- DEFINER functions (emit_mention, emit_self_notification) and triggers
-- (tg_room_joined, tg_sync_session_started, request_room_entry, …), which run as
-- the function OWNER and are unaffected by these revokes; and pg_cron /
-- service_role, which also retain EXECUTE. The client-facing scoped wrappers
-- emit_self_notification (self + a fixed type allowlist) and emit_mention
-- (shared-team check) are left untouched.

revoke execute on function public.emit_notification(
  uuid, text, text, text, jsonb, uuid, uuid, text, uuid, text, integer
) from anon, public;

revoke execute on function public.emit_event(
  uuid, text, text, text, jsonb, uuid, uuid, text, uuid, text, text, integer
) from anon, authenticated, public;

revoke execute on function public._nd_insert_delivery(
  uuid, uuid, text, text, text, text, jsonb, uuid, uuid, text, uuid, text[], text
) from anon, authenticated, public;

-- Maintenance sweeps — global state mutation, no authz. Not called by the client
-- (cron / service_role only), so lock them to those.
revoke execute on function public.purge_channel_retention() from anon, authenticated, public;
revoke execute on function public.reassign_stale_leaders()  from anon, authenticated, public;
revoke execute on function public.sweep_sync_sessions()     from anon, authenticated, public;
revoke execute on function public.sweep_presence()          from anon, authenticated, public;

-- sweep_expired_sync_sessions IS called by the client (authenticated members, from
-- QuickActionsPopover / MeetingCountdown). Drop only the raw-anon / PUBLIC reach.
revoke execute on function public.sweep_expired_sync_sessions() from anon, public;
grant  execute on function public.sweep_expired_sync_sessions() to authenticated;

notify pgrst, 'reload schema';
