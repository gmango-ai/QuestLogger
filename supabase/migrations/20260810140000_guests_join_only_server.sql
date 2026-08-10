-- Enforce guest JOIN-ONLY on the server (not just in GuestRoomPage).
--
-- can_enter_room returns 'allowed' for a valid room_guests grant, and
-- start_or_join_room_session creates a session (leader_id = auth.uid()) when none
-- is live. The guest client only ever calls join_sync_session, but a malicious
-- guest could call start_or_join_room_session directly on an empty room, become
-- leader (moderation powers) and fire a team-wide 'session_started' notification.
-- Add a server guard: an anonymous (guest) caller may JOIN an existing live
-- session but never CREATE one. CREATE OR REPLACE of the 20260627120000 body with
-- one added branch before the INSERT; contract unchanged.
create or replace function public.start_or_join_room_session(
  p_room_id uuid,
  p_join_code text,
  p_team_id uuid default null,
  p_visibility text default 'team',
  p_control_mode text default 'leader',
  p_durations jsonb default null,
  p_auto_transition boolean default null,
  p_access_code text default null
)
returns public.sync_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sync_sessions;
  v_live int;
begin
  if p_room_id is null then
    raise exception 'room_id is required';
  end if;

  -- Enforce room privacy BEFORE any insert/lock side effects. Fails closed.
  if public.can_enter_room(p_room_id, p_access_code) <> 'allowed' then
    raise exception 'room_entry_denied' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_room_id::text, 0));

  select * into v_session
    from public.sync_sessions
    where room_id = p_room_id and status = 'active'
    limit 1;

  if found then
    select count(*) into v_live
      from public.sync_session_participants
      where session_id = v_session.id
        and left_at is null
        and last_seen_at > pg_catalog.now() - interval '120 seconds';
    if v_live > 0 then
      return v_session; -- live session — caller joins it
    end if;
    -- Ghost (everyone abandoned it): tear down so we reset to zero.
    delete from public.sync_sessions where id = v_session.id;
  end if;

  -- Guests (anonymous invitees) may only JOIN an existing live session, never
  -- CREATE one. Becoming leader_id would grant moderation powers + fire a
  -- team-wide 'session_started' notification. join_sync_session (the guest
  -- client's path) is unaffected — this only blocks a direct start.
  if public.is_anonymous_auth() then
    raise exception 'room_entry_denied' using errcode = '42501';
  end if;

  insert into public.sync_sessions
    (leader_id, controller_id, join_code, team_id, room_id, visibility, control_mode, durations, auto_transition)
  values
    (auth.uid(), auth.uid(), p_join_code, p_team_id, p_room_id,
     coalesce(p_visibility, 'team'),
     coalesce(p_control_mode, 'leader'),
     coalesce(p_durations, '{"work":1500,"shortBreak":300,"longBreak":900}'::jsonb),
     coalesce(p_auto_transition, true))
  returning * into v_session;

  return v_session;
end;
$$;

grant execute on function public.start_or_join_room_session(
  uuid, text, uuid, text, text, jsonb, boolean, text) to authenticated;

notify pgrst, 'reload schema';
