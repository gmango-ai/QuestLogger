-- Extend a meeting room's auto-close time.
--
-- Meeting rooms stamp sync_sessions.expires_at = now() + max_duration_minutes
-- on session start (see sync_session_room_side_effects). When the countdown
-- runs out the room auto-closes and everyone is disconnected. This RPC lets a
-- running meeting buy more time so it doesn't drop mid-conversation.
--
-- Anyone actively in the meeting may extend it (not just the leader) — the
-- point is to keep the call alive, and the host may have stepped away. We do
-- our own participant check here, then flip the sanctioned `sync.internal_update`
-- flag so the leader-only metadata guard (sync_session_guard_participant_update)
-- lets this permission-checked write through. (expires_at is NOT one of the
-- guarded columns, but a plain participant is otherwise blocked from any
-- sync_sessions UPDATE, so the bypass is required.)

create or replace function public.extend_room_session(
  p_session_id uuid,
  p_minutes int
)
returns public.sync_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sync_sessions;
begin
  if p_session_id is null then
    raise exception 'session_id is required';
  end if;
  if p_minutes is null or p_minutes <= 0 or p_minutes > 480 then
    raise exception 'Extension must be between 1 and 480 minutes';
  end if;

  if not exists (
    select 1
    from public.sync_session_participants
    where session_id = p_session_id
      and user_id = auth.uid()
      and left_at is null
  ) then
    raise exception 'Only someone in the meeting can extend it';
  end if;

  -- Bypass the leader-only metadata guard for this internal write.
  perform set_config('sync.internal_update', '1', true);

  update public.sync_sessions
     set expires_at = greatest(expires_at, pg_catalog.now())
                      + (p_minutes * interval '1 minute')
   where id = p_session_id
     and status = 'active'
     and expires_at is not null   -- only meetings that actually auto-close
   returning * into v_session;

  if not found then
    raise exception 'This meeting has no time limit to extend, or has already ended';
  end if;

  return v_session;
end;
$$;

grant execute on function public.extend_room_session(uuid, int) to authenticated;

notify pgrst, 'reload schema';
