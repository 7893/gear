export type RuntimeConfig = {
  apiUrl: string;
  publishableKey: string;
  accountsEnabled: boolean;
  recoveryEnabled: boolean;
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
    publishableKey: value.publishableKey,
    accountsEnabled: value.accountsEnabled === true,
    recoveryEnabled: value.recoveryEnabled === true,
  };
}
