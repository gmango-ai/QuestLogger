// SPIKE ONLY — durability for the Yjs doc: a periodic snapshot to Storage.
//
// Validates "single-writer periodic snapshot" (reuse the isPersister election)
// + cold-load: when nobody's online to sync from, a returning client restores
// the board from this snapshot. Stored in the existing whiteboard-images bucket
// under the writer's own folder (covered by the existing "users write own" RLS —
// no migration for the spike). NOTE: per-user path here; a real SHARED-board
// snapshot needs the board-scoped RLS from the plan's open decisions.
import * as Y from "yjs";
import { supabase } from "../supabase";

const BUCKET = "whiteboard-images";
const pathFor = (uid, board) => `${uid}/crdt-spike/${board}.bin`;

// Persist the whole doc as a compacted v2 update. Returns bytes written.
export async function saveYjsSnapshot(uid, board, doc) {
  if (!uid) return { error: { message: "not signed in — snapshot skipped" }, bytes: 0 };
  const bytes = Y.encodeStateAsUpdateV2(doc);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(pathFor(uid, board), new Blob([bytes]), {
      upsert: true,
      contentType: "application/octet-stream",
      cacheControl: "0",
    });
  return { error, bytes: bytes.length };
}

// Cold-load: merge the stored snapshot into the doc. Idempotent (Yjs merges).
export async function loadYjsSnapshot(uid, board, doc) {
  if (!uid) return { loaded: false, bytes: 0 };
  const { data, error } = await supabase.storage.from(BUCKET).download(pathFor(uid, board));
  if (error || !data) return { loaded: false, bytes: 0 };
  const buf = new Uint8Array(await data.arrayBuffer());
  Y.applyUpdateV2(doc, buf);
  return { loaded: true, bytes: buf.length };
}
