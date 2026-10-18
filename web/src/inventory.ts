import { computed } from "vue";
import { account, inventoryRpc } from "./accounts";
import type {
  Asset,
  AssetDetails,
  AssetList,
  Party,
  AssetInput,
  PartyInput,
  Placement,
  DueState,
  DueAssetList,
} from "./inventory-model";
export * from "./inventory-model";

export const inventoryAccess = computed(
  () =>
    account.enabled &&
    account.inventoryEnabled &&
    account.profile?.email_verified === true &&
    account.profile.membership?.status === "active" &&
    ["admin", "operator", "viewer"].includes(
      account.profile.membership.role || "",
    ),
);
export const inventoryWriteAccess = computed(
  () =>
    inventoryAccess.value &&
    ["admin", "operator"].includes(account.profile?.membership?.role || ""),
);
export function businessToday(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function timestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
export function holderLabel(asset: Asset): string {
  return (
    asset.holder_name ||
    (asset.management_status === "managed" ? "经办人库存" : "见历史记录")
  );
}
export function partyLabel(party: Party): string {
  return (
    party.name +
    (party.organization_name ? `（${party.organization_name}）` : "")
  );
}
export function dueLabel(asset: Asset): string {
  if (!asset.due_on) return asset.holder_party_id ? "长期使用" : "不适用";
  const date = businessToday();
  return (
    asset.due_on +
    (asset.management_status !== "managed"
      ? ""
      : asset.due_on < date
        ? "（已逾期）"
        : asset.due_on === date
          ? "（今日到期）"
          : "")
  );
}
export async function listAssets(filters: {
  search: string;
  category: string | null;
  state: string | null;
  holder_kind: string | null;
}): Promise<AssetList> {
  return (await inventoryRpc("list_assets", filters)) as AssetList;
}
export async function getAsset(id: string): Promise<AssetDetails> {
  return (await inventoryRpc("get_asset", { asset_id: id })) as AssetDetails;
}
export async function listDueAssets(
  state: DueState | null,
): Promise<DueAssetList> {
  return (await inventoryRpc("list_due_assets", { state })) as DueAssetList;
}
export async function extendAssignment(
  asset: Asset,
  newDueOn: string,
  reason: string,
  requestId: string,
): Promise<Asset> {
  return (await inventoryRpc("extend_assignment", {
    asset_id: asset.id,
    expected_version: asset.version,
    new_due_on: newDueOn,
    reason,
    request_id: requestId,
  })) as Asset;
}
export async function listParties(): Promise<Party[]> {
  return (await inventoryRpc("list_parties")) as Party[];
}
export async function createParty(
  details: PartyInput,
  requestId: string,
): Promise<Party> {
  return (await inventoryRpc("create_party", {
    details,
    request_id: requestId,
  })) as Party;
}
export async function initializeAsset(
  details: AssetInput,
  placement: Placement,
  requestId: string,
  allowDuplicate: boolean,
): Promise<Asset> {
  return (await inventoryRpc("initialize_asset", {
    details,
    placement,
    request_id: requestId,
    allow_legacy_duplicate: allowDuplicate,
  })) as Asset;
}
// One ID for the same form contents, including retry after a lost acknowledgement.
export function requestFor(
  cache: Map<string, string>,
  payload: unknown,
): string {
  const signature = JSON.stringify(payload);
  const id = cache.get(signature) || crypto.randomUUID();
  cache.set(signature, id);
  return id;
}
