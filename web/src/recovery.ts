import { createClient } from "@supabase/supabase-js";
import { configuration } from "./configuration";
import { signOut, type Profile } from "./accounts";

function makeRecoveryClient(apiUrl: string, publishableKey: string) {
  return createClient(apiUrl, publishableKey, {
    db: { schema: "gear" },
    auth: {
      storageKey: "gear.recovery.v1",
      flowType: "implicit",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// Each page owns its recovery client. Recovery tokens never enter persistent
// storage, the regular login client, URL parameters or the business RPC flow.
export function createRecoveryFlow() {
  let client: ReturnType<typeof makeRecoveryClient> | undefined;
  let requestedEmail = "";
  let verifiedEmail = "";
  let changed = false;
  const deadline = 15 * 60 * 1000;
  let verifiedAt = 0;
  async function service() {
    if (client) return client;
    const config = await configuration();
    if (!config.accountsEnabled || !config.recoveryEnabled)
      throw new Error("recovery_unavailable");
    client = makeRecoveryClient(config.apiUrl, config.publishableKey);
    return client;
  }
  async function eligible() {
    if (!client) throw new Error("recovery_required");
    const { data, error } = await client.rpc("get_my_membership");
    const profile = data as Profile | null;
    if (
      error ||
      !profile?.email_verified ||
      profile.email.toLowerCase() !== requestedEmail ||
      profile.membership?.status !== "active" ||
      !profile.membership.role
    )
      throw new Error("recovery_unavailable");
  }
  async function discard() {
    verifiedEmail = "";
    verifiedAt = 0;
    const old = client;
    client = undefined;
    if (old) await old.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
  return {
    async request(email: string) {
      await discard();
      requestedEmail = email.trim().toLowerCase();
      changed = false;
      const current = await service();
      const { error } = await current.auth.resetPasswordForEmail(
        requestedEmail,
        {
          redirectTo: window.location.origin + "/",
        },
      );
      if (error) throw error;
    },
    async verify(code: string) {
      if (!requestedEmail || !/^[0-9]{6}$/.test(code))
        throw new Error("invalid_verification_code");
      const current = await service();
      const { data, error } = await current.auth.verifyOtp({
        email: requestedEmail,
        token: code,
        type: "recovery",
      });
      if (error) throw error;
      if (!data.session || !data.user?.email_confirmed_at) {
        await discard();
        throw new Error("recovery_required");
      }
      try {
        await eligible();
        verifiedEmail = requestedEmail;
        verifiedAt = Date.now();
      } catch (error) {
        await discard();
        throw error;
      }
    },
    async update(
      password: string,
      confirmation: string,
      sharedImpactAccepted: boolean,
    ) {
      if (
        changed ||
        !client ||
        !verifiedEmail ||
        Date.now() - verifiedAt > deadline
      )
        throw new Error("recovery_required");
      if (password.length < 12 || password.length > 128)
        throw new Error("invalid_new_password");
      if (password !== confirmation) throw new Error("password_mismatch");
      if (!sharedImpactAccepted)
        throw new Error("shared_password_confirmation_required");
      await eligible();
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      changed = true;
      await discard();
      await signOut().catch(() => undefined);
      // The provider revokes other refresh sessions after a password update.
      // Clear only Gear's persistent session, then reload to drop its old client.
      for (const key of [
        "gear.auth.v1",
        "gear.auth.v1-code-verifier",
        "gear.auth.v1-user",
      ])
        window.localStorage.removeItem(key);
    },
    async cancel() {
      requestedEmail = "";
      await discard();
    },
  };
}
