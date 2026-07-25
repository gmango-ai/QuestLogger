import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../supabase", () => ({
  supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));

import { supabase } from "../supabase";
import { isTransientAuthError, recoverSession } from "./sessionRecovery";

const FAST = { baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 2000 };

describe("isTransientAuthError", () => {
  it("treats the observed incident errors as transient (retry, don't log out)", () => {
    // The exact GoTrue errors from the mangodoro incident logs.
    expect(isTransientAuthError({ status: 500, message: "500: error finding refresh token: context canceled" })).toBe(true);
    expect(isTransientAuthError({ status: 409, message: "409: Too many concurrent token refresh requests on the same session or refresh token" })).toBe(true);
  });

  it("treats gateway / rate-limit / network wobble as transient", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(isTransientAuthError({ status, message: "server error" })).toBe(true);
    }
    expect(isTransientAuthError({ status: 0, message: "Failed to fetch" })).toBe(true);
    expect(isTransientAuthError({ message: "network timeout" })).toBe(true);
  });

  it("treats a definitively-dead refresh token as NON-transient (real logout)", () => {
    expect(isTransientAuthError({ status: 400, message: "Invalid Refresh Token: Already Used" })).toBe(false);
    expect(isTransientAuthError({ status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" })).toBe(false);
    expect(isTransientAuthError({ status: 401, message: "refresh_token revoked" })).toBe(false);
  });

  it("a dead-token message wins even if the status looks transient", () => {
    // Defensive: message signalling a consumed token must not be retried forever.
    expect(isTransientAuthError({ status: 500, message: "invalid refresh token: already used" })).toBe(false);
  });

  it("is safe on null / unknown errors", () => {
    expect(isTransientAuthError(null)).toBe(false);
    expect(isTransientAuthError(undefined)).toBe(false);
    expect(isTransientAuthError({ status: 403, message: "forbidden" })).toBe(false);
  });
});

describe("recoverSession", () => {
  beforeEach(() => {
    supabase.auth.getSession.mockReset();
    supabase.auth.refreshSession.mockReset();
    // Default: no ambient session, so the loop drives refreshSession explicitly.
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
  });

  it("returns no-snapshot when there is no refresh token to recover from", async () => {
    const res = await recoverSession(null, FAST);
    expect(res).toEqual({ ok: false, reason: "no-snapshot" });
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
  });

  it("retries a transient failure and recovers when the refresh finally succeeds", async () => {
    supabase.auth.refreshSession
      .mockResolvedValueOnce({ data: null, error: { status: 500, message: "context canceled" } })
      .mockResolvedValueOnce({ data: null, error: { status: 409, message: "concurrent refresh" } })
      .mockResolvedValueOnce({ data: { session: { user: { id: "u1" } } }, error: null });

    const res = await recoverSession({ refresh_token: "good" }, FAST);
    expect(res.ok).toBe(true);
    expect(res.session).toEqual({ user: { id: "u1" } });
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(3);
  });

  it("bails out immediately (no wasted retries) on a definitively-dead token", async () => {
    supabase.auth.refreshSession.mockResolvedValue({
      data: null,
      error: { status: 400, message: "Invalid Refresh Token: Already Used" },
    });
    const res = await recoverSession({ refresh_token: "dead" }, FAST);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fatal");
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("adopts an ambient session if auth-js recovered on its own", async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "ambient" } } } });
    const res = await recoverSession({ refresh_token: "x" }, FAST);
    expect(res.ok).toBe(true);
    expect(res.session).toEqual({ user: { id: "ambient" } });
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
  });

  it("honors abort (a real session settled elsewhere) without refreshing", async () => {
    const res = await recoverSession({ refresh_token: "x" }, { ...FAST, isAborted: () => true });
    expect(res).toEqual({ ok: false, reason: "aborted" });
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
  });

  it("gives up with reason 'timeout' when the outage outlasts the budget", async () => {
    supabase.auth.refreshSession.mockResolvedValue({ data: null, error: { status: 503, message: "unavailable" } });
    const res = await recoverSession({ refresh_token: "x" }, { baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 30 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
  });
});
