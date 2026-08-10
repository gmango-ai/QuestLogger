-- External room guests, Phase 3 — link management + redemption RPCs.
--
-- create_guest_link / revoke_guest_link: manager-only (same permission predicate
--   as the other room-mutation RPCs — owner / org admin / gating-team lead).
-- resolve_room_by_guest_token: anon-callable (the caller has an anonymous session
--   from signInAnonymously). Validates the link + rooms.guests_allowed and mints
--   a room_guests grant for auth.uid(). No edge function needed.

-- ── create_guest_link ────────────────────────────────────────────
create or replace function public.create_guest_link(
  p_room_id uuid,
  p_expires_at timestamptz default null,
  p_label text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_token   text;
  v_id      uuid;
  v_expires timestamptz;
begin
  select created_by into v_creator from public.rooms where id = p_room_id;
  if v_creator is null then
    raise exception 'Room not found';
  end if;
  if not (
    public.is_org_admin_of_room(p_room_id)
    or public.is_lead_of_any_gating_team(p_room_id)
    or v_creator = auth.uid()
  ) then
    raise exception 'You do not have permission to invite guests to this room';
  end if;

  -- 122-bit unguessable, URL-safe token (uuid hex, hyphens stripped).
  v_token := replace(pg_catalog.gen_random_uuid()::text, '-', '');
  -- Default 7-day expiry; caller may override (null = never, but the UI always
  -- passes a value).
  v_expires := coalesce(p_expires_at, pg_catalog.now() + interval '7 days');

  insert into public.room_guest_links (room_id, token, label, created_by, expires_at)
  values (p_room_id, v_token, nullif(trim(coalesce(p_label, '')), ''), auth.uid(), v_expires)
  returning id into v_id;

  -- Creating a link implicitly enables guests for the room.
  update public.rooms set guests_allowed = true where id = p_room_id;

  return json_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

grant execute on function public.create_guest_link(uuid, timestamptz, text) to authenticated;

-- ── revoke_guest_link ────────────────────────────────────────────
-- Revokes the link AND expires any outstanding grants minted from it, so
-- revoking immediately locks out guests who already redeemed it (their next
-- can_enter_room check / guest RLS evaluation fails).
create or replace function public.revoke_guest_link(p_link_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room    uuid;
  v_creator uuid;
begin
  select room_id into v_room from public.room_guest_links where id = p_link_id;
  if v_room is null then
    raise exception 'Link not found';
  end if;
  select created_by into v_creator from public.rooms where id = v_room;
  if not (
    public.is_org_admin_of_room(v_room)
    or public.is_lead_of_any_gating_team(v_room)
    or v_creator = auth.uid()
  ) then
    raise exception 'You do not have permission to revoke this link';
  end if;

  update public.room_guest_links
     set revoked_at = pg_catalog.now()
   where id = p_link_id and revoked_at is null;

  update public.room_guests
     set expires_at = pg_catalog.now()
   where link_id = p_link_id
     and (expires_at is null or expires_at > pg_catalog.now());
end;
$$;

grant execute on function public.revoke_guest_link(uuid) to authenticated;

-- ── resolve_room_by_guest_token ──────────────────────────────────
-- The guest has already done signInAnonymously (so auth.uid() is set). Validates
-- the token + guests_allowed and upserts a room_guests grant for this anon user,
-- inheriting the link's expiry. Returns the room so the client can enter it.
create or replace function public.resolve_room_by_guest_token(
  p_token text,
  p_display_name text default ''
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.room_guest_links;
  v_room public.rooms;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  if v_uid is null then
    return json_build_object('error', 'not_authenticated');
  end if;

  select * into v_link from public.room_guest_links where token = p_token;
  if v_link is null then
    return json_build_object('error', 'invalid');
  end if;
  if v_link.revoked_at is not null then
    return json_build_object('error', 'revoked');
  end if;
  if v_link.expires_at is not null and v_link.expires_at <= pg_catalog.now() then
    return json_build_object('error', 'expired');
  end if;

  select * into v_room from public.rooms where id = v_link.room_id and archived_at is null;
  if v_room is null then
    return json_build_object('error', 'invalid');
  end if;
  if v_room.guests_allowed is not true then
    return json_build_object('error', 'guests_disabled');
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_display_name, '')), ''), 'Guest');

  insert into public.room_guests (room_id, user_id, link_id, display_name, expires_at)
  values (v_room.id, v_uid, v_link.id, v_name, v_link.expires_at)
  on conflict (room_id, user_id) do update
    set link_id = excluded.link_id,
        display_name = excluded.display_name,
        expires_at = excluded.expires_at,
        created_at = pg_catalog.now();

  return json_build_object(
    'room_id', v_room.id,
    'room_name', v_room.name,
    'team_id', v_room.team_id
  );
end;
$$;

grant execute on function public.resolve_room_by_guest_token(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
