import { configuration } from "./configuration";
import { signOut, type Profile } from "./accounts";
import {
  transientAuthClient,
  validateNewPassword,
  clearGearAuthStorage,
} from "./auth-support";

// Each page owns its recovery client. Recovery tokens never enter persistent
// storage, the regular login client, URL parameters or the business RPC flow.
export function createRecoveryFlow() {
  let client: ReturnType<typeof transientAuthClient> | undefined;
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
    client = transientAuthClient(
      config.apiUrl,
      config.publishableKey,
      config.databaseSchema,
      "gear.recovery.v1",
    );
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
    async useExistingCode(email: string) {
      await discard();
      requestedEmail = email.trim().toLowerCase();
      if (!requestedEmail) throw new Error("recovery_required");
      changed = false;
      await service();
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
      validateNewPassword(password, confirmation, sharedImpactAccepted);
      await eligible();
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      changed = true;
      await discard();
      await signOut().catch(() => undefined);
      // The provider revokes other refresh sessions after a password update.
      // Clear only Gear's persistent session, then reload to drop its old client.
      clearGearAuthStorage();
    },
    async cancel() {
      requestedEmail = "";
      await discard();
    },
  };
}
