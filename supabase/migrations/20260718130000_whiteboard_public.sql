-- Public whiteboards: a third scope 'public' that ANYONE with the link can VIEW
-- (read-only), including logged-out visitors. SELECT is granted to all roles
-- (incl. anon) but ONLY for scope='public' rows; every write path stays behind
-- auth.uid() (owner-only), so read-only is RLS-enforced, not UI-enforced.
-- Also adds set_whiteboard_scope() so an owner/admin can move a board between
-- personal / org / public after creation.
--
-- Stacks on 20260718120000_whiteboard_members.sql (guard trigger + helpers).

-- 1. Allow 'public' as a scope value + coupling shape (mirrors personal).
alter table public.whiteboards drop constraint if exists whiteboards_scope_check;
alter table public.whiteboards add constraint whiteboards_scope_check
  check (scope = any (array['personal', 'org', 'public']));

alter table public.whiteboards drop constraint if exists whiteboards_scope_team_check;
alter table public.whiteboards add constraint whiteboards_scope_team_check
  check (
    (scope = 'org' and team_id is not null)
    or (scope = 'personal' and team_id is null and owner_id is not null)
    or (scope = 'public' and team_id is null and owner_id is not null)
  );

-- 2. Anyone (incl. anon) may READ a public, non-archived board. Nothing else.
drop policy if exists "anyone reads public whiteboards" on public.whiteboards;
create policy "anyone reads public whiteboards" on public.whiteboards
  for select using (scope = 'public' and archived_at is null);

-- 3. The owner keeps write control over their public board (RLS restricts to the
--    owner; anon and other roles get NO write path).
drop policy if exists "owners update public whiteboards" on public.whiteboards;
create policy "owners update public whiteboards" on public.whiteboards
  for update using (scope = 'public' and owner_id = auth.uid())
  with check (scope = 'public' and owner_id = auth.uid());

drop policy if exists "owners delete public whiteboards" on public.whiteboards;
create policy "owners delete public whiteboards" on public.whiteboards
  for delete using (scope = 'public' and owner_id = auth.uid());

-- 4. Extend the ownership guard so archiving a PUBLIC board (not just personal)
--    is owner-only — a lingering invited member must not soft-delete it.
create or replace function public.whiteboard_guard_ownership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.scope is distinct from old.scope
     or new.owner_id is distinct from old.owner_id
     or new.team_id is distinct from old.team_id then
    if not (old.owner_id = auth.uid()
            or (old.team_id is not null and public.is_org_admin(old.team_id))) then
      raise exception 'Only the owner can change a whiteboard''s ownership or scope';
    end if;
  end if;
  if new.archived_at is distinct from old.archived_at
     and old.scope in ('personal', 'public') and old.owner_id <> auth.uid() then
    raise exception 'Only the owner can archive this whiteboard';
  end if;
  return new;
end; $$;

-- 5. Change a board's scope after creation. Owner (personal/public) or the org
--    board's admin only. SECURITY DEFINER bypasses the cross-scope RLS
--    with-check; the guard trigger still permits it (caller is owner/admin).
create or replace function public.set_whiteboard_scope(
  p_whiteboard_id uuid,
  p_scope text,
  p_team_id uuid default null
)
returns public.whiteboards
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v public.whiteboards;
  v_team uuid;
begin
  if me is null then raise exception 'unauthenticated'; end if;
  if p_scope not in ('personal', 'org', 'public') then raise exception 'Invalid scope'; end if;
  select * into v from public.whiteboards where id = p_whiteboard_id;
  if v is null then raise exception 'Whiteboard not found'; end if;

  if not (v.owner_id = me
          or (v.scope = 'org' and v.team_id is not null and public.is_org_admin(v.team_id))) then
    raise exception 'Only the owner can change this whiteboard''s scope';
  end if;
  -- Publishing to the public internet requires being the board's OWNER (not just
  -- an org admin), so an admin can't expose someone else's board publicly.
  if p_scope = 'public' and v.owner_id <> me then
    raise exception 'Only the owner can make a whiteboard public';
  end if;

  if p_scope = 'org' then
    v_team := coalesce(p_team_id, v.team_id);
    if v_team is null then
      select team_id into v_team from public.team_members where user_id = me limit 1;
    end if;
    if v_team is null or not public.is_team_member(v_team) then
      raise exception 'Pick a team you belong to';
    end if;
    update public.whiteboards
       set scope = 'org', team_id = v_team, owner_id = coalesce(owner_id, me), updated_at = pg_catalog.now()
     where id = p_whiteboard_id returning * into v;
  else
    -- personal or public: private / link-shared, no team.
    update public.whiteboards
       set scope = p_scope, team_id = null, owner_id = coalesce(owner_id, created_by, me), updated_at = pg_catalog.now()
     where id = p_whiteboard_id returning * into v;
  end if;

  -- Invited members are a PERSONAL invite-only concept; moving to team-wide (org)
  -- or link-shared (public) makes them meaningless and (for public) must not keep
  -- edit rights — clear the roster.
  if p_scope <> 'personal' then
    delete from public.whiteboard_members where whiteboard_id = p_whiteboard_id;
  end if;
  return v;
end; $$;
grant execute on function public.set_whiteboard_scope(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
