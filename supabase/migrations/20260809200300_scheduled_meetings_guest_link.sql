-- External room guests, Phase 3 — remember a meeting's guest link.
--
-- When a meeting is scheduled with external attendee_emails and a bound room, the
-- client mints a room guest link and injects the join URL into the Google
-- Calendar event. Persist the link id + URL so edits reuse the SAME link (no
-- churn) and the in-app meeting detail can surface it.
alter table public.scheduled_meetings
  add column if not exists guest_link_id  uuid references public.room_guest_links(id) on delete set null,
  add column if not exists guest_join_url text;

notify pgrst, 'reload schema';
