-- Make the message-attachments bucket PRIVATE.
--
-- It was public=true, so a public bucket serves any known object path via
-- /object/public/... WITHOUT consulting RLS. The prior migration scoped the
-- SELECT policy (killing enumeration), but a leaked/guessed path could still be
-- fetched. Flipping the bucket to private means every read requires a signed URL
-- minted by an authorized session. The app (src/lib/messageAttachments.js) now
-- renders attachments via short-lived signed URLs generated from storage_path;
-- read/insert/delete on storage.objects are already RLS-scoped to conversation
-- access / message sender.
update storage.buckets set public = false where id = 'message-attachments';

-- `url` used to hold a stable public URL; it's now a transient signed URL (or
-- null) generated at read time from the durable storage_path. Allow null.
alter table public.dm_message_attachments alter column url drop not null;

notify pgrst, 'reload schema';
