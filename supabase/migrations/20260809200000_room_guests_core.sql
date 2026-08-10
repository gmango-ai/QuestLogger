-- External room guests, Phase 3 — core tables, helpers & least-privilege reads.
--
-- Lets an outside person (NOT a team member) join a room via a tokenized share
-- link. Modeled directly on the org-device account pattern
-- (20260623130000_org_device_accounts): a guest is a real anonymous-auth user
-- (supabase.auth.signInAnonymously), PINNED to one room by a `room_guests` grant,
-- with LEAST-PRIVILEGE read access to just that room's session + roster. A guest
-- is deliberately NOT a team_members row, so it can't see org member lists, other
-- rooms, chat, or time entries — access comes only from the guest-scoped policies
-- here plus the existing "Participants read/update linked whiteboard" policies
-- (whiteboard_in_my_active_session), which a guest satisfies by joining the
-- room's session.
--
-- Fresh timestamp: latest applied on the shared DB is 20260809172434; never
-- reuse a timestamp (db push silently skips collisions).

-- ── 1. Per-room gate ─────────────────────────────────────────────
-- Guest links can only be created / resolved when this is true. Auto-set true
-- when a link is created (see create_guest_link); a settings toggle can disable.
alter table public.rooms
  add column if not exists guests_allowed boolean not null default false;

-- ── 2. Guest links (the tokens) ──────────────────────────────────
-- Reusable, revocable, expiring share tokens. Writes go through the
-- security-definer RPCs (create_guest_link / revoke_guest_link) only — there are
-- NO client write policies, so a member can't forge or alter a link.
create table if not exists public.room_guest_links (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  token       text not null unique,
  label       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists room_guest_links_room_idx
  on public.room_guest_links (room_id) where revoked_at is null;

-- ── 3. Guest grants (the analog of org_devices) ──────────────────
-- One row per (room, anonymous user). Created by resolve_room_by_guest_token
-- when a guest redeems a link. Writes via RPC only.
create table if not exists public.room_guests (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  link_id      uuid references public.room_guest_links(id) on delete set null,
  display_name text,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_guests_user_idx on public.room_guests (user_id);

-- ── 4. helpers: the current guest's room / grant check ───────────
-- security definer so a guest can resolve its own scope without a broad SELECT
-- grant on room_guests. Returns null/false for a non-guest, which makes every
-- guest-scoped policy below evaluate to false for everyone else. Granted to
-- anon + authenticated (an anonymous session carries the authenticated role).
create or replace function public.is_room_guest(p_room_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_guests g
    where g.room_id = p_room_id
      and g.user_id = auth.uid()
      and (g.expires_at is null or g.expires_at > now())
  );
$$;
grant execute on function public.is_room_guest(uuid) to anon, authenticated;

create or replace function public.current_guest_room()
returns uuid language sql stable security definer set search_path = '' as $$
  select room_id from public.room_guests
   where user_id = auth.uid()
     and (expires_at is null or expires_at > now())
   order by created_at desc
   limit 1
$$;
grant execute on function public.current_guest_room() to anon, authenticated;

-- ── 5. RLS on the new tables ─────────────────────────────────────
alter table public.room_guest_links enable row level security;
alter table public.room_guests enable row level security;

-- Room managers (owner / org admin / gating-team lead) read their room's links
-- for the management UI. Writes are RPC-only.
drop policy if exists "room managers read guest links" on public.room_guest_links;
create policy "room managers read guest links" on public.room_guest_links for select
  using (
    public.is_org_admin_of_room(room_id)
    or public.is_lead_of_any_gating_team(room_id)
    or exists (select 1 from public.rooms r where r.id = room_id and r.created_by = auth.uid())
  );

-- A guest reads its own grant row; managers read their room's grants (roster).
drop policy if exists "guest reads own grant" on public.room_guests;
create policy "guest reads own grant" on public.room_guests for select
  using (user_id = auth.uid());

drop policy if exists "room managers read guests" on public.room_guests;
create policy "room managers read guests" on public.room_guests for select
  using (
    public.is_org_admin_of_room(room_id)
    or public.is_lead_of_any_gating_team(room_id)
    or exists (select 1 from public.rooms r where r.id = room_id and r.created_by = auth.uid())
  );

-- ── 6. guest-scoped read access (additive; least privilege) ──────
-- Permissive SELECT policies that grant a guest read access to EXACTLY its
-- room's row + that room's active session + roster — nothing else. OR'd with the
-- existing member/device policies, so they never widen anyone else's access.
drop policy if exists "guest reads its room" on public.rooms;
create policy "guest reads its room" on public.rooms for select
  using (public.is_room_guest(id));

drop policy if exists "guest reads its room sessions" on public.sync_sessions;
create policy "guest reads its room sessions" on public.sync_sessions for select
  using (public.is_room_guest(room_id));

drop policy if exists "guest reads its room participants" on public.sync_session_participants;
create policy "guest reads its room participants" on public.sync_session_participants for select
  using (
    exists (
      select 1 from public.sync_sessions s
      where s.id = sync_session_participants.session_id
        and public.is_room_guest(s.room_id)
    )
  );

notify pgrst, 'reload schema';
