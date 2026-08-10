-- Null-safe uniqueness for whiteboard goal nodes (defense-in-depth).
--
-- Bug: a whiteboard goal node maps to exactly one goal via the partial unique
-- index on (source_board, source_node). But when the board is embedded in a
-- room panel the route has no :whiteboardId, so the client passed a NULL board.
-- In a btree unique index NULL is DISTINCT, so set_goal's ON CONFLICT could not
-- dedupe and inserted a fresh duplicate goal on every save/remount — the user
-- saw one goal card per keystroke stage.
--
-- The client now always passes the real board id (via BoardIdContext). This
-- migration is the belt-and-suspenders DB guarantee: coalesce a NULL board to a
-- fixed sentinel in the uniqueness key so a degraded (null-board) write updates
-- the node's single row instead of piling up. Stored source_board stays NULL
-- (no fake FK value); only the index/upsert treat NULL as the sentinel.

-- Replace the NULL-distinct index with a NULL-safe one. (Duplicate node rows
-- were collapsed to the newest before this ran, so the build succeeds.)
drop index if exists public.goals_source_node_uniq;

create unique index if not exists goals_board_node_uniq
  on public.goals (coalesce(source_board, '00000000-0000-0000-0000-000000000000'::uuid), source_node)
  where source_node is not null;

-- set_goal: same signature + behaviour, but the upsert now targets the
-- null-safe index and a later real-board write "upgrades" a null-board row.
create or replace function public.set_goal(
  p_team_id uuid, p_owner_type text, p_owner_id uuid,
  p_owner_name text, p_owner_color text, p_body text,
  p_board uuid default null, p_node text default null,
  p_horizon text default 'none', p_week_start date default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sentinel uuid := '00000000-0000-0000-0000-000000000000';
  v_horizon text := coalesce(nullif(p_horizon, ''), 'none');
  v_week date := case when coalesce(nullif(p_horizon, ''), 'none') = 'week' then p_week_start else null end;
begin
  if not (p_team_id in (select public.get_my_team_ids())) then
    raise exception 'Not a member of this team';
  end if;
  if v_horizon not in ('none', 'week', 'month', 'quarter', 'year') then
    raise exception 'Invalid horizon';
  end if;
  -- Empty body clears this node's goal (null-safe board match).
  if coalesce(btrim(p_body), '') = '' then
    delete from public.goals
     where source_node = p_node and p_node is not null
       and coalesce(source_board, v_sentinel) = coalesce(p_board, v_sentinel);
    return;
  end if;
  insert into public.goals (team_id, owner_type, owner_id, owner_name, owner_color, body, horizon, week_start, set_by, set_at, source_board, source_node)
  values (p_team_id, p_owner_type, p_owner_id, coalesce(p_owner_name, ''), p_owner_color, btrim(p_body), v_horizon, v_week, auth.uid(), now(), p_board, p_node)
  on conflict (coalesce(source_board, '00000000-0000-0000-0000-000000000000'::uuid), source_node) where source_node is not null
  do update set team_id = excluded.team_id, owner_type = excluded.owner_type, owner_id = excluded.owner_id,
                owner_name = excluded.owner_name, owner_color = excluded.owner_color,
                body = excluded.body, horizon = excluded.horizon, week_start = excluded.week_start,
                source_board = coalesce(excluded.source_board, public.goals.source_board),
                set_by = excluded.set_by, set_at = now();
end; $$;
grant execute on function public.set_goal(uuid, text, uuid, text, text, text, uuid, text, text, date) to authenticated;
