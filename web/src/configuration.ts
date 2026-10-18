export type RuntimeConfig = {
  apiUrl: string;
  databaseSchema: string;
  publishableKey: string;
  accountsEnabled: boolean;
  recoveryEnabled: boolean;
  inventoryEnabled: boolean;
  flowsEnabled: boolean;
  evidenceEnabled: boolean;
};

export async function configuration(): Promise<RuntimeConfig> {
  const response = await fetch("/runtime-config.json", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("configuration_unavailable");
  const value = (await response.json()) as Record<string, unknown>;
  if (
    !value ||
    typeof value.apiUrl !== "string" ||
    typeof value.databaseSchema !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(value.databaseSchema) ||
    typeof value.publishableKey !== "string" ||
    !value.publishableKey.startsWith("sb_publishable_")
  )
    throw new Error("configuration_invalid");
  const url = new URL(value.apiUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("configuration_invalid");
  return {
    apiUrl: url.origin,
    databaseSchema: value.databaseSchema,
    publishableKey: value.publishableKey,
    accountsEnabled: value.accountsEnabled === true,
    recoveryEnabled: value.recoveryEnabled === true,
    inventoryEnabled: value.inventoryEnabled === true,
    flowsEnabled: value.flowsEnabled === true,
    evidenceEnabled: value.evidenceEnabled === true,
  };
}
