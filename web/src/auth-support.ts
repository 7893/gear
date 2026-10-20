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
export function clearGearAuthStorage() {
  for (const key of [
    "gear.auth.v1",
    "gear.auth.v1-code-verifier",
    "gear.auth.v1-user",
  ])
    window.localStorage.removeItem(key);
}
