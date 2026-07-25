// Auth session resilience.
//
// Supabase's auth-js treats several *transient* refresh failures — an HTTP 500
// or 429 from GoTrue, a 409 "too many concurrent token refresh requests", a
// "context canceled" abort — as NON-retryable and immediately fires SIGNED_OUT
// with a null session. Our app shell mirrors that null straight into React
// state, which unmounts the whole authenticated tree (including the live video
// call). So one auth-server wobble mid-meeting ejected the user and blocked
// rejoining until auth fully recovered.
//
// This module lets the shell tell a *real* sign-out apart from a transient one
// and, for the transient case, retry a refresh with the last-good refresh token
// (which is usually still valid — a 409/"context canceled" means the refresh was
// raced/aborted, not that the token was consumed) before honoring the logout.

import { supabase } from "../supabase";

// ── Intentional sign-out flag ───────────────────────────────────────────────
// A user-initiated sign-out sets a short window; the auth listener consults it
// so it doesn't try to "recover" a logout the user asked for. A timestamp window
// (vs a bare boolean) self-clears, so a failed signOut() that never emits can't
// leave the flag stuck and swallow a later real transient logout.
let intentionalUntil = 0;
export function markIntentionalSignOut() { intentionalUntil = Date.now() + 5000; }
export function isIntentionalSignOut() { return Date.now() < intentionalUntil; }
export function clearIntentionalSignOut() { intentionalUntil = 0; }

// ── Error classification ─────────────────────────────────────────────────────
// TRANSIENT = worth retrying (server wobble / concurrency / network). A token
// that is DEFINITIVELY dead (reused, revoked, not found) is NOT transient — give
// up immediately and honor the logout.
export function isTransientAuthError(error) {
  if (!error) return false;
  const msg = String(error.message || "").toLowerCase();
  // Definitely-dead refresh token → real logout, don't retry.
  if (
    msg.includes("invalid refresh token") ||
    msg.includes("refresh token not found") ||
    msg.includes("already used") ||
    msg.includes("revoked")
  ) return false;
  const status = Number(error.status ?? error.code ?? 0);
  // GoTrue wobble / concurrency control / gateway → transient.
  if ([409, 429, 500, 502, 503, 504].includes(status)) return true;
  // fetch threw (network drop / timeout / abort) — often status 0 / no status.
  if (
    status === 0 ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("context canceled") ||
    msg.includes("concurrent") ||
    msg.includes("failed to fetch")
  ) return true;
  return false;
}

// ── Recovery loop ────────────────────────────────────────────────────────────
// Retry a refresh from the snapshot's refresh token with capped exponential
// backoff until we get a session back or the budget is spent. Returns
// { ok: true, session } on success, else { ok: false, reason }.
//
// Budget note: we hold the (now-stale) session in the UI while this runs, so the
// call/app stay mounted. ~90s covers the typical GoTrue blip; a genuinely-dead
// token bails out fast via isTransientAuthError, so this only spins for real
// transient outages.
export async function recoverSession(snapshot, {
  maxTotalMs = 90_000,
  baseDelayMs = 500,
  maxDelayMs = 8_000,
  isAborted = () => false,
} = {}) {
  const refreshToken = snapshot?.refresh_token;
  if (!refreshToken) return { ok: false, reason: "no-snapshot" };

  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < maxTotalMs) {
    if (isAborted()) return { ok: false, reason: "aborted" };

    // auth-js may have quietly recovered a session on its own — take it.
    try {
      const existing = (await supabase.auth.getSession()).data?.session;
      if (existing) return { ok: true, session: existing };
    } catch { /* fall through to an explicit refresh */ }

    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (data?.session) return { ok: true, session: data.session };
    if (error && !isTransientAuthError(error)) return { ok: false, reason: "fatal", error };

    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    attempt += 1;
    await new Promise((r) => setTimeout(r, delay));
  }
  return { ok: false, reason: "timeout" };
}
