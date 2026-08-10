-- Tighten the guest JOIN-ONLY guard: block CREATE for ANY non-member, not just
-- anonymous callers.
--
-- 20260810140000_guests_join_only_server only blocked CREATE when
-- is_anonymous_auth() is true. But a SIGNED-IN (non-anonymous) user who holds a
-- room_guests grant — e.g. someone from another org who opened the invite link
-- while logged in — has no team_members row for the room's org, yet still passes
-- can_enter_room via its guest branch. They could then call
-- start_or_join_room_session directly on an empty room, become leader_id
-- (moderation powers) and fire a team-wide 'session_started' notification.
--
-- The correct rule is membership, not anonymity: only a real member of the room's
-- org may CREATE a session. Every caller who reaches the INSERT via the non-guest
-- path of can_enter_room is, by construction, a team_member of the room's team
-- (can_enter_room returns 'denied' before its manager checks for anyone who is
-- not), so this locks out guests (anonymous OR signed-in) without affecting any
-- legitimate creator. CREATE OR REPLACE of the 20260810140000 body with the anon
-- check swapped for a membership check; contract unchanged.
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

  -- Only a real member of the room's org may CREATE (become leader_id, which
  -- grants moderation powers + fires a team-wide 'session_started' notification).
  -- A guest — anonymous OR a signed-in non-member holding a room_guests grant —
  -- reaches here via the guest branch of can_enter_room and has no team_members
  -- row. They may JOIN a live session (join_sync_session, the guest client's only
  -- path) but never start one. Derive the team from the room, not caller input.
  if not exists (
    select 1
    from public.rooms r
    join public.team_members tm on tm.team_id = r.team_id
    where r.id = p_room_id and tm.user_id = auth.uid()
  ) then
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
