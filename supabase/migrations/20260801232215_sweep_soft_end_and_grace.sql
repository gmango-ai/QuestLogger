-- Call-side resilience (WS7): harden the abandoned-session sweep so a transient
-- DB/network hiccup can't eject a whole team from a live call.
--
-- Two changes to sweep_abandoned_sync_sessions():
--
--   1. GRACE WINDOW 120s → 5 minutes. Foreground clients heartbeat every ~20s,
--      so a live tab is never stale — but a brief DB brownout can drop several
--      beats in a row for EVERYONE at once. At 120s that was enough to trip the
--      sweep on a still-live room. 5 minutes comfortably outlasts a brownout
--      (and pairs with the new heartbeat-on-foreground in SyncSessionContext),
--      so only a genuinely-abandoned session (nobody present for >5 min) is
--      swept.
--
--   2. SOFT-END instead of hard DELETE. The old sweep DELETEd the row. That
--      fired the BEFORE-DELETE side effects (historically
--      unlock_private_room_on_session_delete, which nulled the room's
--      invite_code) and cascade-cleared participants — so a single false-
--      positive sweep didn't just end the session, it unlocked the private room
--      and wiped the roster. We now set status='ended' and KEEP the row for a
--      short retention window. No DELETE ⇒ no delete-time trigger fires
--      (the invite_code / private-room lock is left intact), and the row lingers
--      for diagnostics + the app's re-establish path (PersistentVideoCall).
--
--      (Note: the unlock_private_room_on_session_delete trigger was already
--      retired in 20260627120000_room_entry_policy.sql — privacy moved to a
--      persistent PIN via rooms.entry_policy + can_enter_room, and no BEFORE/
--      AFTER DELETE trigger remains on sync_sessions. Soft-ending is still the
--      right call: it avoids the cascade delete of participants, keeps the row,
--      and is symmetric with the grace widen. The unique index
--      sync_sessions_one_active_per_room is partial on status='active', so an
--      'ended' row never blocks a fresh session.)
--
-- The partner migration (20260801120100) locks down EXECUTE so only cron / the
-- service role can run this.
--
-- TODO(livekit-presence): the truly correct abandonment signal is "no LiveKit
-- participant in the room", not "no fresh heartbeat". That needs a LiveKit
-- webhook (participant_joined / participant_left → a room-presence table) so the
-- sweep can consult real media presence before ending a session. That is OUT OF
-- SCOPE for this pass; the grace-widen + soft-end above is the interim fix.

create or replace function public.sweep_abandoned_sync_sessions()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  with abandoned as (
    select s.id
    from public.sync_sessions s
    where s.status = 'active'
      and not exists (
        select 1
        from public.sync_session_participants p
        where p.session_id = s.id
          and p.left_at is null
          -- GRACE WINDOW 5 minutes (was 120s). Widened so a DB brownout that
          -- drops a few heartbeats for everyone at once can't sweep a live room.
          and p.last_seen_at > pg_catalog.now() - interval '5 minutes'
      )
  ),
  ended as (
    -- SOFT-end: keep the row (no DELETE ⇒ no delete-time side effects, no
    -- participant cascade). status='ended' takes it out of active discovery /
    -- the unique-active index; a later retention pass can hard-delete old ended
    -- rows if desired.
    update public.sync_sessions
       set status = 'ended'
     where id in (select id from abandoned)
       and status = 'active'
    returning 1
  )
  select count(*) into v_count from ended;
  return v_count;
end;
$$;

-- ── Rollback reference — original hard-DELETE / 120s body ──────────────────
-- To revert, restore this definition:
--
-- create or replace function public.sweep_abandoned_sync_sessions()
-- returns int
-- language plpgsql
-- security definer
-- set search_path = ''
-- as $$
-- declare
--   v_count int;
-- begin
--   with abandoned as (
--     select s.id
--     from public.sync_sessions s
--     where s.status = 'active'
--       and not exists (
--         select 1
--         from public.sync_session_participants p
--         where p.session_id = s.id
--           and p.left_at is null
--           and p.last_seen_at > pg_catalog.now() - interval '120 seconds'
--       )
--   ),
--   deleted as (
--     delete from public.sync_sessions
--     where id in (select id from abandoned)
--     returning 1
--   )
--   select count(*) into v_count from deleted;
--   return v_count;
-- end;
-- $$;
