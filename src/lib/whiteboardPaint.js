import { supabase } from "../supabase";

// Durable persistence for the tiled raster paint layer. Each painted tile is a
// PNG at "paint/<board>/<tx>_<ty>.png" in the whiteboard-images bucket. We use
// Storage's own listing as the source of truth (no manifest to keep in sync):
// on open we list the board's tiles and draw each in; while painting we upsert
// dirty tiles. Collaborative writes need the 20260623120000 RLS policy.

const BUCKET = "whiteboard-images";
const prefix = (boardId) => `paint/${boardId || "board"}`;
const TILE_RE = /^(-?\d+)_(-?\d+)\.png$/;

// List a board's persisted tiles → [{ key, tx, ty, url }]. The public URL is
// cache-busted by the object's updated_at so a re-opened board sees fresh
// pixels rather than a stale CDN copy.
export async function listPaintTiles(boardId) {
  if (!boardId) return [];
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(prefix(boardId), { limit: 1000 });
  if (error || !data) return [];
  const out = [];
  for (const f of data) {
    const m = TILE_RE.exec(f.name);
    if (!m) continue;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(`${prefix(boardId)}/${f.name}`);
    const ver = f.updated_at || f.created_at || "";
    out.push({
      key: `${m[1]}_${m[2]}`,
      tx: Number(m[1]),
      ty: Number(m[2]),
      url: ver ? `${pub.publicUrl}?v=${encodeURIComponent(ver)}` : pub.publicUrl,
    });
  }
  return out;
}

// Upsert one tile's PNG. cacheControl is short so collaborators pick up edits
// on their next open; live edits already arrive over the realtime channel.
export async function uploadPaintTile(boardId, key, blob) {
  if (!boardId || !blob) return { error: { message: "missing args" } };
  const path = `${prefix(boardId)}/${key}.png`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { cacheControl: "60", upsert: true, contentType: "image/png" });
  return { error };
}

// Delete now-empty tiles' PNGs (after a Clear-all / region erase) so blank tiles
// don't linger in Storage and re-materialise on the next open. Best-effort +
// idempotent; uses the "wb-images: paint deletes" RLS policy.
export async function deletePaintTiles(boardId, keys) {
  if (!boardId || !keys || !keys.length) return { error: null };
  const paths = keys.map((k) => `${prefix(boardId)}/${k}.png`);
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  return { error };
}
