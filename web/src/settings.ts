import { settingsRpc } from "./accounts";
export type AppSettings = {
  document_header: string;
  version: number;
  history: {
    id: string;
    recorded_at: string;
    actor_label: string;
    reason: string;
    before_header: string;
    after_header: string;
  }[];
};
export type DueSettings = {
  version: number;
  enabled: boolean;
  lead_days: number;
  local_time: string;
  mail_enabled: boolean;
};
export type DueSettingsInput = Pick<
  DueSettings,
  "enabled" | "lead_days" | "local_time"
> & { reason: string };
export type HeaderInput = { document_header: string; reason: string };
export async function getUnitSettings(): Promise<{
  header: AppSettings;
  due: DueSettings;
}> {
  // Both RPCs read one versioned settings row. Do not combine different revisions.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [header, due] = await Promise.all([
      getAppSettings(),
      settingsRpc("get_due_settings") as Promise<DueSettings>,
    ]);
    if (header.version === due.version) return { header, due };
  }
  throw new Error("settings_conflict");
}
export async function getAppSettings(): Promise<AppSettings> {
  return (await settingsRpc("get_app_settings")) as AppSettings;
}
