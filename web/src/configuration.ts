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

let pending: Promise<RuntimeConfig> | undefined;

// Public, deployment-scoped settings only. Failures remain retryable.
export function configuration(): Promise<RuntimeConfig> {
  if (!pending)
    pending = readConfiguration().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

async function readConfiguration(): Promise<RuntimeConfig> {
  const embedded = document.getElementById("gear-runtime-config");
  let value: Record<string, unknown>;
  if (embedded) value = JSON.parse(embedded.textContent || "null");
  else {
    // Compatibility with development and deployments made before embedding.
    const response = await fetch("/runtime-config.json", {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("configuration_unavailable");
    value = (await response.json()) as Record<string, unknown>;
  }
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
