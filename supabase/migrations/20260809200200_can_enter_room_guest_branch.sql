-- External room guests, Phase 3 — teach can_enter_room about guest grants.
--
-- CREATE OR REPLACE of the 20260630120000 (room_knock) definition, adding ONE
-- branch: a valid, unexpired room_guests grant admits the caller. It is placed
-- BEFORE the team_members check, because a guest is an anonymous user with no
-- team_members row (the original function returns 'denied' for non-members).
-- Contract unchanged ('allowed' | 'denied'), so neither join RPC needs editing —
-- start_or_join_room_session / join_sync_session keep calling it as-is.
create or replace function public.can_enter_room(
  p_room_id uuid,
  p_access_code text default null
)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_is_member boolean;
  v_code text;
  v_expires timestamptz;
  v_occupied boolean;
begin
  if p_room_id is null then
    return 'denied';
  end if;

  select * into v_room
    from public.rooms
    where id = p_room_id and archived_at is null;
  if v_room is null then
    return 'denied';
  end if;

  -- External guest with a live grant for this room → allowed. The tokenized
  -- link is the credential (validated + minted by resolve_room_by_guest_token);
  -- checked before org membership because a guest is not a team member.
  if exists (
    select 1 from public.room_guests g
    where g.room_id = p_room_id
      and g.user_id = auth.uid()
      and (g.expires_at is null or g.expires_at > now())
  ) then
    return 'allowed';
  end if;

  -- Must belong to the room's org at all (matches the rooms SELECT policy).
  select exists (
    select 1 from public.team_members
    where team_id = v_room.team_id and user_id = auth.uid()
  ) into v_is_member;
  if not v_is_member then
    return 'denied';
  end if;

  -- Managers (owner / org admin / gating-team lead) always get in.
  if v_room.created_by = auth.uid()
     or public.is_org_admin_of_room(p_room_id)
     or public.is_lead_of_any_gating_team(p_room_id) then
    return 'allowed';
  end if;

  -- Already an active participant of this room's live session → re-entry /
  -- cross-device rehydrate is always allowed (they were admitted already).
  if exists (
    select 1
    from public.sync_sessions s
    join public.sync_session_participants p on p.session_id = s.id
    where s.room_id = p_room_id
      and s.status = 'active'
      and p.user_id = auth.uid()
      and p.left_at is null
  ) then
    return 'allowed';
  end if;

  -- Policy gate.
  if v_room.entry_policy = 'open' then
    return 'allowed';
  elsif v_room.entry_policy = 'code' then
    -- Occupancy gate: an EMPTY private room is free to claim; the code is only
    -- required once someone is inside ("unlocked when empty, locked in use").
    select exists (
      select 1
      from public.sync_sessions s
      join public.sync_session_participants p on p.session_id = s.id
      where s.room_id = p_room_id
        and s.status = 'active'
        and p.left_at is null
    ) into v_occupied;
    if not v_occupied then
      return 'allowed';
    end if;

    -- A knock approved within the last 5 minutes admits them, code or no code.
    if exists (
      select 1 from public.room_knock_requests k
      where k.room_id = p_room_id
        and k.user_id = auth.uid()
        and k.status = 'approved'
        and k.decided_at > now() - interval '5 minutes'
    ) then
      return 'allowed';
    end if;

    select code, expires_at into v_code, v_expires
      from public.room_secrets where room_id = p_room_id;
    if v_code is null then
      -- Occupied, no PIN configured → managers only (handled above).
      return 'denied';
    end if;
    if v_expires is not null and v_expires <= now() then
      return 'denied'; -- code expired
    end if;
    if p_access_code is not null
       and upper(trim(p_access_code)) = upper(trim(v_code)) then
      return 'allowed';
    end if;
    return 'denied';
  end if;

  return 'denied';
end;
$$;

grant execute on function public.can_enter_room(uuid, text) to authenticated;

notify pgrst, 'reload schema';
