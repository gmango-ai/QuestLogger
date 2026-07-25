-- Seed person identity (name + avatar) from the OAuth provider (Google).
--
-- Problem: a Google display name lives ONLY in auth.users.raw_user_meta_data
-- (full_name / name / avatar_url / picture). Nothing ever copied it into the
-- app's identity tables, so a Google-signup member who never typed a name in
-- Settings had an empty user_settings.name AND an empty profiles.display_name.
-- The team roster (get_team_member_profiles RPC) and org chart then showed the
-- literal "Team member". (Sticky notes looked fine only because they capture
-- the AUTHOR'S OWN session name at creation time — no cross-person lookup.)
--
-- This migration:
--   1. Backfills profiles from Google metadata where identity is empty.
--   2. Adds a defensive trigger so future signups are seeded automatically.
--   3. Teaches get_team_member_profiles to fall back to profiles / metadata.
--
-- Guiding rule everywhere below: FILL ONLY WHEN EMPTY. A name/avatar a person
-- set manually (e.g. "Jordi" over Google's "Jordi Ramos") is never overwritten.

-- ── 1a. Create any missing profiles rows from metadata ──────────────────────
insert into public.profiles (user_id, display_name, avatar_url)
select
  au.id,
  coalesce(nullif(au.raw_user_meta_data->>'full_name', ''),
           nullif(au.raw_user_meta_data->>'name', ''), ''),
  coalesce(nullif(au.raw_user_meta_data->>'avatar_url', ''),
           nullif(au.raw_user_meta_data->>'picture', ''), '')
from auth.users au
where not exists (select 1 from public.profiles p where p.user_id = au.id)
on conflict (user_id) do nothing;

-- ── 1b. Fill empty display_name / avatar_url on existing profiles rows ───────
update public.profiles p
set
  display_name = case
    when p.display_name = '' then
      coalesce(nullif(au.raw_user_meta_data->>'full_name', ''),
               nullif(au.raw_user_meta_data->>'name', ''), '')
    else p.display_name end,
  avatar_url = case
    when p.avatar_url = '' then
      coalesce(nullif(au.raw_user_meta_data->>'avatar_url', ''),
               nullif(au.raw_user_meta_data->>'picture', ''), '')
    else p.avatar_url end,
  updated_at = now()
from auth.users au
where au.id = p.user_id
  and (p.display_name = '' or p.avatar_url = '')
  and (au.raw_user_meta_data ? 'full_name'
    or au.raw_user_meta_data ? 'name'
    or au.raw_user_meta_data ? 'avatar_url'
    or au.raw_user_meta_data ? 'picture');

-- ── 2. Seed identity on new signups (and on provider metadata refresh) ──────
-- Fires on auth.users. Wrapped so an identity-seed hiccup can NEVER roll back
-- (and thereby block) the signup itself.
create or replace function public.tg_seed_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name   text := coalesce(
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''));
  v_avatar text := coalesce(
    nullif(new.raw_user_meta_data->>'avatar_url', ''),
    nullif(new.raw_user_meta_data->>'picture', ''));
begin
  if v_name is null and v_avatar is null then
    return new;
  end if;

  insert into public.profiles (user_id, display_name, avatar_url, updated_at)
    values (new.id, coalesce(v_name, ''), coalesce(v_avatar, ''), now())
  on conflict (user_id) do update set
    -- Only fill blanks; never clobber a name/avatar the person set themselves.
    display_name = case when public.profiles.display_name = ''
                        then coalesce(v_name, '') else public.profiles.display_name end,
    avatar_url   = case when public.profiles.avatar_url = ''
                        then coalesce(v_avatar, '') else public.profiles.avatar_url end,
    updated_at   = now();

  return new;
exception when others then
  -- Identity is best-effort; auth must proceed regardless.
  return new;
end;
$$;

drop trigger if exists tr_seed_profile_from_auth_ins on auth.users;
create trigger tr_seed_profile_from_auth_ins
  after insert on auth.users
  for each row execute function public.tg_seed_profile_from_auth();

drop trigger if exists tr_seed_profile_from_auth_upd on auth.users;
create trigger tr_seed_profile_from_auth_upd
  after update on auth.users
  for each row
  when (old.raw_user_meta_data is distinct from new.raw_user_meta_data)
  execute function public.tg_seed_profile_from_auth();

-- ── 3. Teach the roster RPC to resolve names from every available source ────
-- Priority: manual user_settings.name  →  profiles.display_name  →  Google
-- metadata  →  'Team member'. Same cascade for the avatar. SECURITY DEFINER +
-- empty search_path lets it read auth.users (fully qualified) safely.
create or replace function public.get_team_member_profiles(p_team_id uuid)
returns table(
  user_id uuid, name text, avatar_url text, status text,
  status_updated_at timestamptz, role text, joined_at timestamptz,
  sticky_color text, classification text, hourly_rate numeric,
  weekly_target_hours numeric, manager_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select
    tm.user_id,
    coalesce(
      nullif(us.name, ''),
      nullif(p.display_name, ''),
      nullif(au.raw_user_meta_data->>'full_name', ''),
      nullif(au.raw_user_meta_data->>'name', ''),
      'Team member'
    )::text as name,
    coalesce(
      nullif(us.avatar_url, ''),
      nullif(p.avatar_url, ''),
      nullif(au.raw_user_meta_data->>'avatar_url', ''),
      nullif(au.raw_user_meta_data->>'picture', ''),
      ''
    )::text as avatar_url,
    coalesce(us.status, '')::text              as status,
    us.status_updated_at,
    tm.role,
    tm.joined_at,
    coalesce(us.sticky_color, '#fde68a')::text as sticky_color,
    tm.classification,
    tm.hourly_rate,
    tm.weekly_target_hours,
    tm.manager_id
  from public.team_members tm
  left join public.user_settings us on us.user_id = tm.user_id
  left join public.profiles p       on p.user_id  = tm.user_id
  left join auth.users au           on au.id      = tm.user_id
  where tm.team_id = p_team_id
    and exists (
      select 1 from public.team_members tm2
      where tm2.team_id = p_team_id and tm2.user_id = auth.uid()
    )
  order by tm.joined_at asc;
$$;

notify pgrst, 'reload schema';
