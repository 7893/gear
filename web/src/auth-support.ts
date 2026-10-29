import { createClient } from "@supabase/supabase-js";
export const passwordMinimum = 12;
export const passwordMaximum = 128;
export function validateNewPassword(
  password: string,
  confirmation: string,
  accepted: boolean,
) {
  if (password.length < passwordMinimum || password.length > passwordMaximum)
    throw new Error("invalid_new_password");
  if (password !== confirmation) throw new Error("password_mismatch");
  if (!accepted) throw new Error("shared_password_confirmation_required");
}
export function transientAuthClient(
  apiUrl: string,
  publishableKey: string,
  databaseSchema: string,
  storageKey: string,
) {
  return createClient(apiUrl, publishableKey, {
    db: { schema: databaseSchema },
    auth: {
      storageKey,
      flowType: "implicit",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
export const SESSION_STORAGE_KEY = "gear.auth.v1";
export const SESSION_ACTIVE_AT_KEY = "gear.auth.activeAt";
export const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function clearGearAuthStorage() {
  for (const key of [
    SESSION_STORAGE_KEY,
    "gear.auth.v1-code-verifier",
    "gear.auth.v1-user",
    SESSION_ACTIVE_AT_KEY,
  ])
    window.localStorage.removeItem(key);
}

export function touchSessionActivity(now = Date.now()) {
  try {
    window.localStorage.setItem(SESSION_ACTIVE_AT_KEY, String(now));
  } catch {
    /* Ignore storage quota errors. */
  }
}

export function hasValidStoredSession(now = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    } | null;
    if (
      !parsed ||
      typeof parsed.access_token !== "string" ||
      !parsed.access_token
    ) {
      clearGearAuthStorage();
      return false;
    }
    const activeAt = Number(window.localStorage.getItem(SESSION_ACTIVE_AT_KEY));
    if (!Number.isFinite(activeAt) || activeAt <= 0) {
      if (
        typeof parsed.expires_at === "number" &&
        parsed.expires_at * 1000 > now
      ) {
        touchSessionActivity(now);
        return true;
      }
      clearGearAuthStorage();
      return false;
    }
    if (now - activeAt > SESSION_IDLE_TIMEOUT_MS) {
      clearGearAuthStorage();
      return false;
    }
    return true;
  } catch {
    clearGearAuthStorage();
    return false;
  }
}

export function isSessionIdleExpired(now = Date.now()): boolean {
  try {
    const activeAt = Number(window.localStorage.getItem(SESSION_ACTIVE_AT_KEY));
    return (
      !Number.isFinite(activeAt) ||
      activeAt <= 0 ||
      now - activeAt > SESSION_IDLE_TIMEOUT_MS
    );
  } catch {
    return true;
  }
}
