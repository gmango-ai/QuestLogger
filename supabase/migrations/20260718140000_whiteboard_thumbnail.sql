-- Small preview thumbnail (a compact JPEG data URL) for the whiteboards list.
-- Generated client-side by the editor after edits settle, and stored ON THE ROW
-- so its visibility follows the board's existing RLS automatically: a private /
-- invite-only board's thumbnail is only readable by people who can read the
-- board, and a public board's thumbnail rides along in the anon-readable row.
-- Writing it goes through the same update policies as any board edit (owner /
-- team member / invited member), and the ownership guard ignores this column.
alter table public.whiteboards add column if not exists thumbnail text;

-- The list sorts by updated_at and shows "updated {ago}". A thumbnail refresh is
-- NOT user activity, so a thumbnail-only write must not bump updated_at (else the
-- board jumps to the top of the list ~5s after every edit settles, and the
-- "updated" label resets with no real change). Preserve updated_at when the only
-- column that changed is `thumbnail`; bump it for any real content change.
create or replace function public.tg_whiteboards_touch()
returns trigger
language plpgsql
as $$
begin
  if new.thumbnail is distinct from old.thumbnail
     and new.title is not distinct from old.title
     and new.goal is not distinct from old.goal
     and new.snapshot is not distinct from old.snapshot
     and new.scope is not distinct from old.scope
     and new.owner_id is not distinct from old.owner_id
     and new.team_id is not distinct from old.team_id
     and new.template_key is not distinct from old.template_key
     and new.archived_at is not distinct from old.archived_at
  then
    -- thumbnail-only write: keep the prior activity timestamp
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
