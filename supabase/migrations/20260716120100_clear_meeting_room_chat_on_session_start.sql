-- Meeting rooms: clear the chat log for each new meeting.
--
-- Meeting rooms are ephemeral (they auto-close after a max duration), so a
-- meeting's chat shouldn't carry over into the next one. We wipe it when a new
-- session STARTS for the room (i.e. before the next meeting begins), which
-- covers every way the previous meeting could have ended — someone left, it
-- was swept for inactivity, or it hit its time limit (that path sets
-- status='ended' without deleting the row, so a delete-side hook would miss
-- it). General and private rooms keep their history.
--
-- Fires only on a fresh session INSERT. People who JOIN an in-progress meeting
-- don't create a new row (start_or_join_room_session returns the live session),
-- so an active meeting's chat is never touched. Soft-deletes propagate to any
-- open client via realtime, exactly like the manual clear_room_chat RPC.

create or replace function public.clear_meeting_room_chat_on_session_start()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.room_id is not null
     and exists (
       select 1 from public.rooms r
       where r.id = new.room_id and r.kind = 'meeting'
     )
  then
    -- Legacy per-room chat.
    update public.chat_messages
       set deleted_at = pg_catalog.now()
     where room_id = new.room_id
       and deleted_at is null;

    -- Unified chat (general rooms link a conversation channel; a meeting room
    -- may too). Mirror clear_room_chat so both stores end up empty.
    update public.dm_messages dm
       set deleted_at = pg_catalog.now()
      from public.conversations c
     where c.room_id = new.room_id
       and dm.conversation_id = c.id
       and dm.deleted_at is null;
  end if;
  return null; -- AFTER trigger — return value is ignored.
end;
$$;

drop trigger if exists tr_sync_session_clear_meeting_chat on public.sync_sessions;
create trigger tr_sync_session_clear_meeting_chat
  after insert on public.sync_sessions
  for each row execute function public.clear_meeting_room_chat_on_session_start();
