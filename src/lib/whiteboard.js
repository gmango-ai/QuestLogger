import { supabase } from "../supabase";

// ─── Templates ─────────────────────────────────────────────────────
//
// Each template returns the initial xyflow `{ nodes, edges }` payload.
// The whiteboard's snapshot column stores exactly this shape, plus the
// goal text on the row itself. Keep TEMPLATES in lockstep with the SQL
// check constraint on whiteboards.template_key.

// Built-in templates were removed in favour of user-saved templates (see
// whiteboard_templates + the functions below). `blank` stays as the implicit
// default: a board with no seeded snapshot is just an empty canvas.
export const TEMPLATES = {
  blank: { key: "blank", name: "Blank board", desc: "A clean infinite canvas", build: () => ({ nodes: [], edges: [] }) },
};

export const TEMPLATE_LIST = Object.values(TEMPLATES);

// Empty store check — used so we never overwrite a board that has work
// in it with a fresh template seed.
export function isEmptySnapshot(snap) {
  if (!snap) return true;
  const n = Array.isArray(snap.nodes) ? snap.nodes : [];
  const e = Array.isArray(snap.edges) ? snap.edges : [];
  return n.length === 0 && e.length === 0;
}

export function templateSnapshotFor(templateKey) {
  const tpl = TEMPLATES[templateKey] || TEMPLATES.blank;
  return tpl.build();
}

// Strip volatile per-session state before persisting a snapshot (as a template
// or a board seed) so saved templates don't carry selection/drag flags.
export function cleanSnapshot(snap) {
  const nodes = (Array.isArray(snap?.nodes) ? snap.nodes : []).map(
    ({ selected, dragging, resizing, ...rest }) => rest
  );
  const edges = (Array.isArray(snap?.edges) ? snap.edges : []).map(
    ({ selected, ...rest }) => rest
  );
  return { nodes, edges };
}

// ─── User templates (personal / org) ───────────────────────────────

// Personal templates (yours) + org templates for the active team. RLS already
// scopes visibility; we narrow org rows to the active team.
export async function listWhiteboardTemplates(teamId) {
  let q = supabase
    .from("whiteboard_templates")
    .select("id, name, scope, owner_id, team_id, created_at")
    .order("created_at", { ascending: false });
  q = teamId ? q.or(`scope.eq.personal,team_id.eq.${teamId}`) : q.eq("scope", "personal");
  const { data, error } = await q;
  return { data: data || [], error };
}

export async function fetchTemplateSnapshot(templateId) {
  if (!templateId) return { data: null, error: null };
  const { data, error } = await supabase
    .from("whiteboard_templates")
    .select("snapshot")
    .eq("id", templateId)
    .maybeSingle();
  return { data: data?.snapshot || null, error };
}

export async function saveWhiteboardTemplate({ name, scope, ownerId, teamId, snapshot }) {
  const trimmed = (name || "").trim() || "Untitled template";
  if (trimmed.length > 80) return { error: { message: "Name too long (max 80 chars)." } };
  const org = scope === "org";
  if (org && !teamId) return { error: { message: "Pick a team for an org template." } };
  const { data, error } = await supabase
    .from("whiteboard_templates")
    .insert({
      name: trimmed,
      scope: org ? "org" : "personal",
      owner_id: ownerId,
      team_id: org ? teamId : null,
      snapshot: cleanSnapshot(snapshot),
    })
    .select()
    .single();
  return { data, error };
}

export async function deleteWhiteboardTemplate(id) {
  const { error } = await supabase.from("whiteboard_templates").delete().eq("id", id);
  return { error };
}

// ─── CRUD ──────────────────────────────────────────────────────────

// Boards visible in the active team's list: the team's ORG boards plus the
// caller's own PERSONAL boards (pass ownerId). RLS already enforces this; the
// filters just narrow what we ask for.
//
// With `includeShared`, also returns boards SHARED WITH me (I'm an invited
// member) tagged `shared:true`, and annotates my own personal boards with
// `memberCount` (so the list can badge Private vs Invite-only). Off by default
// so other callers (e.g. the room WhiteboardPicker) are unchanged.
const WB_COLS = "id, team_id, scope, owner_id, title, template_key, goal, created_by, created_at, updated_at, archived_at";
export async function listTeamWhiteboards(teamId, { includeArchived = false, ownerId = null, includeShared = false } = {}) {
  if (!teamId && !ownerId) return { data: [], error: null };
  let q = supabase.from("whiteboards").select(WB_COLS).order("updated_at", { ascending: false });
  if (teamId && ownerId) {
    q = q.or(`and(scope.eq.org,team_id.eq.${teamId}),and(scope.eq.personal,owner_id.eq.${ownerId}),and(scope.eq.public,owner_id.eq.${ownerId})`);
  } else if (teamId) {
    q = q.eq("scope", "org").eq("team_id", teamId);
  } else {
    q = q.or(`and(scope.eq.personal,owner_id.eq.${ownerId}),and(scope.eq.public,owner_id.eq.${ownerId})`);
  }
  if (!includeArchived) q = q.is("archived_at", null);
  const { data, error } = await q;
  if (error) return { data: [], error };
  let boards = data || [];

  if (includeShared && ownerId) {
    // Boards shared with me (I'm a member, not the owner).
    const { data: memRows, error: memErr } = await supabase.from("whiteboard_members").select("whiteboard_id").eq("user_id", ownerId);
    if (memErr) console.warn("listTeamWhiteboards(shared):", memErr.message);
    const have = new Set(boards.map((b) => b.id));
    const memIds = [...new Set((memRows || []).map((r) => r.whiteboard_id))].filter((id) => !have.has(id));
    if (memIds.length) {
      let mq = supabase.from("whiteboards").select(WB_COLS).in("id", memIds).order("updated_at", { ascending: false });
      if (!includeArchived) mq = mq.is("archived_at", null);
      const { data: shared } = await mq;
      boards = boards.concat((shared || []).map((b) => ({ ...b, shared: true })));
    }
    // Member counts for the personal boards I own → "Invite-only" vs "Private".
    const ownedIds = boards.filter((b) => b.scope === "personal" && b.owner_id === ownerId).map((b) => b.id);
    if (ownedIds.length) {
      const { data: mc, error: mcErr } = await supabase.from("whiteboard_members").select("whiteboard_id").in("whiteboard_id", ownedIds);
      if (mcErr) console.warn("listTeamWhiteboards(counts):", mcErr.message);
      const counts = {};
      (mc || []).forEach((r) => { counts[r.whiteboard_id] = (counts[r.whiteboard_id] || 0) + 1; });
      boards = boards.map((b) => (counts[b.id] != null ? { ...b, memberCount: counts[b.id] } : b));
    }
  }
  return { data: boards, error: null };
}

// Change a board's scope after creation (personal / org / public). Owner or org
// admin only (server-enforced). Returns the updated row.
export async function setWhiteboardScope(whiteboardId, scope, teamId = null) {
  const { data, error } = await supabase.rpc("set_whiteboard_scope", {
    p_whiteboard_id: whiteboardId,
    p_scope: scope,
    p_team_id: teamId,
  });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

// ─── Invite-only sharing (owner grants specific teammates access) ──────
export async function inviteToWhiteboard(whiteboardId, userIds) {
  if (!whiteboardId || !userIds?.length) return { error: null };
  const { error } = await supabase.rpc("invite_to_whiteboard", { p_whiteboard_id: whiteboardId, p_user_ids: userIds });
  return { error };
}
export async function removeWhiteboardMember(whiteboardId, userId) {
  const { error } = await supabase.rpc("remove_whiteboard_member", { p_whiteboard_id: whiteboardId, p_user_id: userId });
  return { error };
}
export async function listWhiteboardMembers(whiteboardId) {
  if (!whiteboardId) return { data: [], error: null };
  const { data, error } = await supabase
    .from("whiteboard_members")
    .select("user_id, granted_at")
    .eq("whiteboard_id", whiteboardId)
    .order("granted_at", { ascending: true });
  return { data: data || [], error };
}

export async function fetchWhiteboardById(whiteboardId) {
  if (!whiteboardId) return { data: null, error: null };
  const { data, error } = await supabase
    .from("whiteboards")
    .select("*")
    .eq("id", whiteboardId)
    .maybeSingle();
  return { data, error };
}

export async function createWhiteboard({ teamId, title, createdBy, snapshot, scope = "org" }) {
  const trimmedTitle = (title || "").trim() || "Untitled whiteboard";
  if (trimmedTitle.length > 120) return { error: { message: "Title too long (max 120 chars)." } };
  const personal = scope === "personal";
  if (!personal && !teamId) return { error: { message: "Pick a team for a team whiteboard." } };
  const row = {
    title: trimmedTitle,
    template_key: "blank",
    created_by: createdBy,
    scope: personal ? "personal" : "org",
    owner_id: createdBy,
    team_id: personal ? null : teamId,
  };
  // Seed from a saved template's snapshot when one was chosen.
  if (snapshot && !isEmptySnapshot(snapshot)) row.snapshot = cleanSnapshot(snapshot);
  const { data, error } = await supabase
    .from("whiteboards")
    .insert(row)
    .select()
    .single();
  return { data, error };
}

// Snapshot is the xyflow `{ nodes, edges }` payload. We save whole and
// re-load whole — fine for the size we expect (retro boards land well
// under 200KB; complex flowcharts at a few hundred). If real-time
// diffs land in Phase 2 we keep this as the snapshot-of-record and
// layer ops on top.
export async function saveSnapshot(whiteboardId, snapshot) {
  if (!whiteboardId) return { error: { message: "Missing whiteboardId." } };
  const { error } = await supabase
    .from("whiteboards")
    .update({ snapshot })
    .eq("id", whiteboardId);
  return { error };
}

export async function setWhiteboardGoal(whiteboardId, goal) {
  const { error } = await supabase
    .from("whiteboards")
    .update({ goal: (goal ?? "").trim() })
    .eq("id", whiteboardId);
  return { error };
}

export async function setWhiteboardTitle(whiteboardId, title) {
  const trimmed = (title || "").trim() || "Untitled whiteboard";
  if (trimmed.length > 120) return { error: { message: "Title too long (max 120 chars)." } };
  const { error } = await supabase
    .from("whiteboards")
    .update({ title: trimmed })
    .eq("id", whiteboardId);
  return { error };
}

export async function archiveWhiteboard(whiteboardId) {
  const { error } = await supabase
    .from("whiteboards")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", whiteboardId);
  return { error };
}

export async function unarchiveWhiteboard(whiteboardId) {
  const { error } = await supabase
    .from("whiteboards")
    .update({ archived_at: null })
    .eq("id", whiteboardId);
  return { error };
}

export async function deleteWhiteboard(whiteboardId) {
  const { error } = await supabase
    .from("whiteboards")
    .delete()
    .eq("id", whiteboardId);
  return { error };
}
