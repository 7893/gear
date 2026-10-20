import { configuration } from "./configuration";
import { freshAccountIdentity, type Profile } from "./accounts";
import { transientAuthClient, validateNewPassword } from "./auth-support";

// Reauthentication uses memory only and cannot replace the normal login session.
export function createPasswordChangeFlow() {
  let client: ReturnType<typeof transientAuthClient> | undefined;
  let generation = 0;
  let busy = false;
  async function discard() {
    const old = client;
    client = undefined;
    if (old) await old.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
  return {
    async update(
      currentPassword: string,
      password: string,
      confirmation: string,
      accepted: boolean,
    ) {
      if (busy) throw new Error("password_change_busy");
      validateNewPassword(password, confirmation, accepted);
      if (!currentPassword) throw new Error("invalid_current_password");
      const current = ++generation;
      const check = () => {
        if (current !== generation)
          throw new Error("password_change_cancelled");
      };
      busy = true;
      let temporary: ReturnType<typeof transientAuthClient> | undefined;
      try {
        const identity = await freshAccountIdentity();
        check();
        const config = await configuration();
        check();
        temporary = transientAuthClient(
          config.apiUrl,
          config.publishableKey,
          config.databaseSchema,
          "gear.password-change.v1",
        );
        client = temporary;
        const signed = await temporary.auth.signInWithPassword({
          email: identity.email,
          password: currentPassword,
        });
        check();
        if (signed.error) {
          if (signed.error.code === "invalid_credentials")
            throw new Error("invalid_current_password");
          throw signed.error;
        }
        if (
          !signed.data.session ||
          signed.data.user?.id !== identity.id ||
          signed.data.user?.email?.toLowerCase() !==
            identity.email.toLowerCase()
        )
          throw new Error("password_change_unavailable");
        const { data, error } = await temporary.rpc("get_my_membership");
        check();
        const profile = data as Profile | null;
        if (
          error ||
          !profile?.email_verified ||
          profile.membership?.status !== "active" ||
          profile.membership.id !== identity.memberId ||
          !profile.membership.role ||
          profile.email.toLowerCase() !== identity.email.toLowerCase()
        )
          throw new Error("password_change_unavailable");
        const latest = await freshAccountIdentity();
        check();
        if (
          latest.id !== identity.id ||
          latest.memberId !== identity.memberId ||
          latest.email.toLowerCase() !== identity.email.toLowerCase()
        )
          throw new Error("password_change_unavailable");
        const result = await temporary.auth.updateUser({ password });
        check();
        if (result.error) throw result.error;
        return identity.id;
      } finally {
        if (client === temporary) client = undefined;
        if (temporary)
          await temporary.auth
            .signOut({ scope: "local" })
            .catch(() => undefined);
        busy = false;
      }
    },
    async cancel() {
      generation++;
      await discard();
    },
  };
}
