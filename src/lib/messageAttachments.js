import { supabase } from "../supabase";

// Message attachment uploads. Mirrors src/lib/avatar.js (size/type guards +
// timeout race so a stuck upload can't lock the UI), against the
// `message-attachments` bucket. One row per file in dm_message_attachments,
// joined to its message.

const BUCKET = "message-attachments";
// The bucket is PRIVATE (see 20260810120000_message_attachments_private) so files
// are never world-readable. We render via short-lived SIGNED urls minted from the
// stored storage_path each time a thread is (re)listed; they only need to outlive
// a viewing session.
const SIGNED_TTL = 60 * 60 * 4; // 4h
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = [
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf", "text/plain",
];
const UPLOAD_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, label = "Upload") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

const isImage = (mime) => typeof mime === "string" && mime.startsWith("image/");

// Read intrinsic dimensions for images so the thread can reserve space and avoid
// layout jank. Resolves {width,height} or {} for non-images / failures.
function imageSize(file) {
  if (!isImage(file.type)) return Promise.resolve({});
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve({}); URL.revokeObjectURL(url); };
      img.src = url;
    } catch { resolve({}); }
  });
}

// Upload one file and insert its attachment row for an already-created message.
export async function attachToMessage(file, conversationId, messageId) {
  if (!file) return { error: { message: "No file selected" } };
  if (file.size > MAX_BYTES) return { error: { message: "File must be under 10 MB" } };
  if (file.type && !ALLOWED.includes(file.type)) return { error: { message: "Unsupported file type" } };

  const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
  const path = `${conversationId}/${messageId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    const { error: upErr } = await withTimeout(
      supabase.storage.from(BUCKET).upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type }),
      UPLOAD_TIMEOUT_MS, "Attachment upload",
    );
    if (upErr) return { error: upErr };
    // Private bucket → mint a signed URL for the just-uploaded file (optimistic
    // render). storage_path is the durable source of truth; url is transient.
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
    const { width, height } = await imageSize(file);
    const { data, error } = await supabase
      .from("dm_message_attachments")
      .insert({ message_id: messageId, storage_path: path, url: signed?.signedUrl ?? null, mime: file.type || null, bytes: file.size, width: width ?? null, height: height ?? null })
      .select()
      .single();
    return { data: data ? { ...data, url: signed?.signedUrl ?? data.url } : data, error };
  } catch (e) {
    return { error: { message: e?.message || "Upload failed" } };
  }
}

export async function listAttachments(messageIds) {
  if (!messageIds || messageIds.length === 0) return new Map();
  const { data } = await supabase
    .from("dm_message_attachments")
    .select("id, message_id, storage_path, mime, bytes, width, height")
    .in("message_id", messageIds);
  const rows = data || [];
  // Private bucket → mint fresh signed URLs (batched) from each storage_path.
  const paths = [...new Set(rows.map((a) => a.storage_path).filter(Boolean))];
  const urlByPath = new Map();
  if (paths.length) {
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_TTL);
    for (const s of signed || []) if (s?.path && s?.signedUrl) urlByPath.set(s.path, s.signedUrl);
  }
  const byMessage = new Map();
  for (const a of rows) {
    const arr = byMessage.get(a.message_id) || [];
    arr.push({ ...a, url: urlByPath.get(a.storage_path) || null });
    byMessage.set(a.message_id, arr);
  }
  return byMessage;
}

export { isImage };
