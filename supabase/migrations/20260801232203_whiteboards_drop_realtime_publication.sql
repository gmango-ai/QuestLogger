-- Whiteboard write-cost reduction (retro-brownout fix).
--
-- `whiteboards` was created with `replica identity full` AND added to the
-- `supabase_realtime` publication (see 20260617000000_whiteboards.sql), but
-- NOTHING subscribes to it via postgres_changes — live collaboration rides a
-- board-scoped Realtime BROADCAST channel (`wb:<id>`, see useWhiteboardSync.js),
-- which never touches Postgres. So every UPDATE to a whiteboard row was paying:
--   • replica-identity-full: the FULL old row image + full new row image to WAL,
--   • logical decoding of that whole row (snapshot JSON + thumbnail) for the
--     realtime publication,
-- entirely for dead weight. During the weekly retro (many editors, frequent
-- full-snapshot writes) this 2-3x per-write tax was a major contributor to the
-- statement-timeout brownout.
--
-- Remove both. Reads/writes are unaffected; only the (unused) realtime WAL/decode
-- cost goes away. If a postgres_changes subscriber on whiteboards is ever added,
-- reverse this (see the rollback block).

-- Idempotent: `alter publication ... drop table` errors if the table isn't in
-- the publication, so guard it (safe to re-run). `replica identity default` is a
-- no-op when already default.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'whiteboards'
  ) then
    execute 'alter publication supabase_realtime drop table public.whiteboards';
  end if;
end $$;
alter table public.whiteboards replica identity default;

-- Rollback (only if a postgres_changes subscriber on whiteboards is added):
--   alter publication supabase_realtime add table public.whiteboards;
--   alter table public.whiteboards replica identity full;
