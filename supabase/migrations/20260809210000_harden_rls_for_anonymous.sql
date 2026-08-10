-- Harden RLS now that anonymous sign-ins are enabled.
--
-- An anonymous-auth user has the `authenticated` Postgres role with a random
-- auth.uid() and NO membership rows. Every `{public}`/`{authenticated}` policy
-- applies to them, so any policy that only checks "auth.uid() = <self column>"
-- without scoping the shared target is now reachable by strangers. This migration
-- closes the real holes found in the audit. All the app's legitimate write paths
-- go through SECURITY DEFINER RPCs (which bypass RLS) or are self-scoped, so these
-- tightenings don't affect normal use. Guests' own writes (user_settings,
-- user_presence, room_guests via RPC) are deliberately left working.

-- ── #1 CRITICAL — team_members INSERT: org takeover ──────────────
-- Was WITH CHECK (auth.uid() = user_id) with NO team/role scope, so anyone could
-- insert themselves as admin/owner of ANY team (role is free-text; is_owner
-- unconstrained). Restrict the direct insert to the createTeam case — self-insert
-- into a team you just CREATED. Joining an existing team must go through
-- join_team_by_code() (security definer; blocks anon; forces role='member').
drop policy if exists "Users can join teams" on public.team_members;
create policy "Users can join teams" on public.team_members for insert
  with check (
    auth.uid() = user_id
    and public.is_anonymous_auth() is not true
    and exists (
      select 1 from public.teams t
      where t.id = team_members.team_id and t.created_by = auth.uid()
    )
  );

-- ── #2 HIGH — message-attachments read: private DM files enumerable ──
-- Was USING (bucket_id = 'message-attachments') with no scope, so any caller
-- could LIST every private DM attachment path and fetch it. Scope reads to
-- conversation access, mirroring the upload policy. (The app renders attachments
-- via stored public URLs, which don't consult this policy, so display is
-- unaffected — this only removes the enumeration/authenticated-download vector.)
drop policy if exists "message-attachments: read" on storage.objects;
create policy "message-attachments: read" on storage.objects for select
  using (
    bucket_id = 'message-attachments'
    and public.can_access_conversation(((storage.foldername(name))[1])::uuid)
  );

-- ── #3 MEDIUM — sync_session_participants INSERT: room-privacy bypass ──
-- Was missing any room/team/guest check, so a direct insert skipped
-- can_enter_room() (which join_sync_session / start_or_join_room_session enforce).
-- Add the room-privacy gate; ad-hoc (room_id null) sessions are unaffected.
drop policy if exists "Users join sessions" on public.sync_session_participants;
create policy "Users join sessions" on public.sync_session_participants for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.sync_sessions s
      where s.id = sync_session_participants.session_id
        and s.status = 'active'
        and (
          select count(*) from public.sync_session_participants p
          where p.session_id = s.id and p.left_at is null
        ) < s.max_participants
        and (s.room_id is null or public.can_enter_room(s.room_id, null) = 'allowed')
    )
  );

-- ── #4 MEDIUM — sync_sessions INSERT: spoof sessions in others' rooms ──
-- Was WITH CHECK (auth.uid() = leader_id) only, so a stranger could create a
-- fake "active" session in any team/room (spoofing the hallway + firing the
-- team-wide "started a focus session" notification). Room sessions must go
-- through start_or_join_room_session (which validates entry); direct inserts are
-- only the ad-hoc pomodoro path (room_id null), and must be in your own team.
drop policy if exists "Auth users create sessions" on public.sync_sessions;
create policy "Auth users create sessions" on public.sync_sessions for insert
  with check (
    auth.uid() = leader_id
    and room_id is null
    and (team_id is null or team_id in (select public.get_my_team_ids()))
  );

-- ── #5 MEDIUM — whiteboard paint tiles: unowned shared-prefix writes ──
-- The paint INSERT/UPDATE/DELETE policies scoped only to the 'paint/' prefix, so
-- any authenticated user could overwrite/delete anyone's paint tiles. Scope to
-- actual edit access on the board (team member / owner / invited member /
-- active-session participant incl. guests), mirroring the whiteboards UPDATE
-- policies. Board id is path segment [2]: paint/<board>/<tx>_<ty>.png.
create or replace function public.can_edit_whiteboard(p_board uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.whiteboards w
    where w.id = p_board and (
      public.whiteboard_in_my_active_session(w.id)
      or public.is_whiteboard_member(w.id)
      or (w.scope = 'org' and w.team_id in (select public.get_my_team_ids()))
      or (w.scope in ('personal', 'public') and w.owner_id = auth.uid())
    )
  );
$$;
grant execute on function public.can_edit_whiteboard(uuid) to anon, authenticated;

drop policy if exists "wb-images: paint writes"  on storage.objects;
drop policy if exists "wb-images: paint updates" on storage.objects;
drop policy if exists "wb-images: paint deletes" on storage.objects;

create policy "wb-images: paint writes" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'whiteboard-images'
    and (storage.foldername(name))[1] = 'paint'
    and (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
    and public.can_edit_whiteboard(((storage.foldername(name))[2])::uuid)
  );
create policy "wb-images: paint updates" on storage.objects for update to authenticated
  using (
    bucket_id = 'whiteboard-images'
    and (storage.foldername(name))[1] = 'paint'
    and (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
    and public.can_edit_whiteboard(((storage.foldername(name))[2])::uuid)
  );
create policy "wb-images: paint deletes" on storage.objects for delete to authenticated
  using (
    bucket_id = 'whiteboard-images'
    and (storage.foldername(name))[1] = 'paint'
    and (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
    and public.can_edit_whiteboard(((storage.foldername(name))[2])::uuid)
  );

-- ── #6 LOW — block anonymous users from creating teams (spam) ────
-- Anon can't join teams (#1) or spoof sessions (#4); also stop them minting empty
-- teams. Real users unaffected.
drop policy if exists "Authenticated users can create teams" on public.teams;
create policy "Authenticated users can create teams" on public.teams for insert
  with check (auth.uid() = created_by and public.is_anonymous_auth() is not true);

notify pgrst, 'reload schema';
