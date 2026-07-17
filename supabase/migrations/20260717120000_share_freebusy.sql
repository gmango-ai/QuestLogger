-- Consent flag for the "Find a time" scheduler's Google free/busy layer.
--
-- When ON, the calendar-freebusy edge function may read this user's stored
-- Google refresh token (service role) and query their PRIMARY calendar's
-- free/busy so teammates can see when they're busy (times only — no event
-- details). Default OFF: a Google connection made for the user's own calendar
-- features must NOT silently expose their personal busy times to coworkers.
--
-- Read only by the edge function (service role) and by the owner via the
-- existing user_settings own-row RLS; no new teammate-readable exposure.

alter table public.user_settings
  add column if not exists share_freebusy_with_team boolean not null default false;
