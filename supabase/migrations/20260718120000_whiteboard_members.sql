-- Invite-only whiteboards. A personal board (scope='personal') stays private to
-- its owner; the owner can grant specific teammates access via whiteboard_members
-- (a board with members = "invite-only"). Invited members get read + edit — a
-- shared collaborative canvas — but only the owner manages sharing + delete.
--
-- Modeled on the messaging membership pattern (20260627140000_messaging.sql:
-- conversation_participants + is_conversation_participant + create_group_conversation).
-- Uses shares_team_with() + emit_notification() (type 'whiteboard_invite' falls
-- through to the notification layer's inapp+desktop default — no registry change).

create table if not exists public.whiteboard_members (
  whiteboard_id uuid not null references public.whiteboards(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  granted_by    uuid references auth.users(id) on delete set null,
  granted_at    timestamptz not null default now(),
  primary key (whiteboard_id, user_id)
);
create index if not exists whiteboard_members_user_idx on public.whiteboard_members (user_id);

alter table public.whiteboard_members enable row level security;

-- ── membership / ownership helpers (security definer → no RLS recursion) ──
create or replace function public.is_whiteboard_member(p_whiteboard_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.whiteboard_members
     where whiteboard_id = p_whiteboard_id and user_id = auth.uid()
  );
$$;
grant execute on function public.is_whiteboard_member(uuid) to authenticated;

create or replace function public.is_whiteboard_owner(p_whiteboard_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.whiteboards
     where id = p_whiteboard_id and owner_id = auth.uid()
  );
$$;
grant execute on function public.is_whiteboard_owner(uuid) to authenticated;

-- ── whiteboards: invited members read + edit (ADDITIVE to existing org/personal
--    /linked-session policies; policies are OR-ed) ──
drop policy if exists "members read invited whiteboards" on public.whiteboards;
create policy "members read invited whiteboards" on public.whiteboards
  for select using (public.is_whiteboard_member(id));

drop policy if exists "members update invited whiteboards" on public.whiteboards;
create policy "members update invited whiteboards" on public.whiteboards
  for update using (public.is_whiteboard_member(id))
  with check (public.is_whiteboard_member(id));
-- (No member DELETE policy — hard-delete stays owner/admin-only.)

-- ── whiteboard_members RLS: roster readable by members + the board owner; a
--    member may remove THEMSELVES (leave). All other writes go through the RPCs. ──
drop policy if exists "read whiteboard roster" on public.whiteboard_members;
create policy "read whiteboard roster" on public.whiteboard_members
  for select using (
    public.is_whiteboard_member(whiteboard_id) or public.is_whiteboard_owner(whiteboard_id)
  );

drop policy if exists "member leaves whiteboard" on public.whiteboard_members;
create policy "member leaves whiteboard" on public.whiteboard_members
  for delete using (user_id = auth.uid());

-- ── invite RPC (owner-only; the only way to add members) ──
create or replace function public.invite_to_whiteboard(p_whiteboard_id uuid, p_user_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_board public.whiteboards;
  u uuid;
  sender_name text;
begin
  if me is null then raise exception 'unauthenticated'; end if;
  select * into v_board from public.whiteboards where id = p_whiteboard_id;
  if v_board is null then raise exception 'Whiteboard not found'; end if;
  if v_board.scope <> 'personal' or v_board.owner_id <> me then
    raise exception 'Only the owner of a personal whiteboard can share it';
  end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then return; end if;

  -- Every target must be a teammate (no inviting strangers).
  foreach u in array p_user_ids loop
    if u <> me and not public.shares_team_with(u) then raise exception 'Not a teammate'; end if;
  end loop;

  select coalesce(nullif(btrim(us.name), ''), 'A teammate') into sender_name
    from public.user_settings us where us.user_id = me;

  -- Insert new members and notify ONLY the newly-added ones (re-invites are no-ops).
  for u in
    with ins as (
      insert into public.whiteboard_members (whiteboard_id, user_id, granted_by)
        select p_whiteboard_id, x, me
          from (select distinct unnest(p_user_ids) as x) s
         where x <> me
        on conflict do nothing
        returning user_id
    )
    select user_id from ins
  loop
    perform public.emit_notification(
      u,
      'whiteboard_invite',
      sender_name || ' shared a whiteboard with you',
      v_board.title,
      jsonb_build_object('whiteboard_id', p_whiteboard_id, 'route', '/whiteboards/' || p_whiteboard_id::text),
      me
    );
  end loop;
end; $$;
grant execute on function public.invite_to_whiteboard(uuid, uuid[]) to authenticated;

-- ── remove RPC (owner removes anyone; a member removes themselves) ──
create or replace function public.remove_whiteboard_member(p_whiteboard_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_owner uuid;
begin
  if me is null then raise exception 'unauthenticated'; end if;
  select owner_id into v_owner from public.whiteboards where id = p_whiteboard_id;
  if v_owner is null then raise exception 'Whiteboard not found'; end if;
  if me <> v_owner and me <> p_user_id then raise exception 'Not allowed'; end if;
  delete from public.whiteboard_members
   where whiteboard_id = p_whiteboard_id and user_id = p_user_id;
end; $$;
grant execute on function public.remove_whiteboard_member(uuid, uuid) to authenticated;

-- ── column guard: invited members can edit CONTENT (title/goal/snapshot) but the
--    member-update RLS policy can't restrict columns, so without this a member
--    could rewrite owner_id/scope/team_id and hijack the board. Only the current
--    owner (personal) or an org admin (org) may ever change those. ──
create or replace function public.whiteboard_guard_ownership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Ownership / scope / team are immutable except by the owner or an org admin.
  if new.scope is distinct from old.scope
     or new.owner_id is distinct from old.owner_id
     or new.team_id is distinct from old.team_id then
    if not (old.owner_id = auth.uid()
            or (old.team_id is not null and public.is_org_admin(old.team_id))) then
      raise exception 'Only the owner can change a whiteboard''s ownership or scope';
    end if;
  end if;
  -- Archiving (the everyday "delete") a PERSONAL / invite-only board is
  -- owner-only — an invited member must not be able to soft-delete a board they
  -- don't own. Org boards keep their existing "any team member can archive".
  if new.archived_at is distinct from old.archived_at
     and old.scope = 'personal' and old.owner_id <> auth.uid() then
    raise exception 'Only the owner can archive this whiteboard';
  end if;
  return new;
end; $$;

drop trigger if exists tr_whiteboard_guard_ownership on public.whiteboards;
create trigger tr_whiteboard_guard_ownership
  before update on public.whiteboards
  for each row execute function public.whiteboard_guard_ownership();

notify pgrst, 'reload schema';
