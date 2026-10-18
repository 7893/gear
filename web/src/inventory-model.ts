export const categories = {
  printer: "打印机",
  water_dispenser: "饮水机",
  computer: "台式电脑",
  laptop: "笔记本电脑",
  power_strip: "电插板",
  shredder: "碎纸机",
  smart_display: "智慧屏",
  other: "其他",
};
export const assetStates = {
  inventory_available: "在库可用",
  inventory_faulty: "在库故障",
  in_use: "使用中",
  returned_upstream: "已退上游",
  lost: "遗失",
  scrapped: "已报废",
};
export const personTypes = {
  staff: "本单位人员",
  seconded: "借调",
  attached: "挂职",
  temporary: "临时人员",
  other: "其他",
};
export type Category = keyof typeof categories;
export type AssetState = keyof typeof assetStates;
export type Party = {
  id: string;
  kind: "person" | "team";
  name: string;
  person_type: keyof typeof personTypes | null;
  organization_name: string | null;
  default_responsible_id: string | null;
  note: string | null;
};
export type Asset = {
  id: string;
  version?: number;
  asset_code: string;
  legacy_code: string | null;
  serial_number: string | null;
  name: string;
  category: string;
  condition: "normal" | "faulty";
  brand: string | null;
  model: string | null;
  location: string | null;
  note: string | null;
  management_status: string;
  display_status: AssetState;
  invalidated_at: string | null;
  holder_party_id: string | null;
  holder_kind: "person" | "team" | null;
  holder_name: string | null;
  responsible_person_id: string | null;
  responsible_name: string | null;
  usage_kind: "long_term" | "temporary" | null;
  started_on: string | null;
  due_on: string | null;
  followup_name: string | null;
  last_flow_on: string | null;
  created_at: string;
};
export type AssetDetails = {
  asset: Asset;
  history: {
    id: string;
    event_type: string;
    occurred_on: string | null;
    recorded_at: string;
    actor_label: string;
    reason: string | null;
    after_data: Partial<Asset> & {
      document_id?: string;
      document_no?: string;
      previous_due_on?: string;
    };
  }[];
};
export const dueStates = {
  overdue: "已逾期",
  today: "今天到期",
  upcoming: "即将到期",
  later: "尚未临近",
};
export type DueState = keyof typeof dueStates;
export type DueAssetList = {
  business_on: string;
  notice_days: number;
  items: (Asset & { due_state: DueState })[];
  summary: Record<DueState | "total", number>;
};
export type AssetList = {
  items: Asset[];
  matched: number;
  summary: Record<AssetState | "total" | "managed_faulty", number>;
};
export type AssetInput = {
  name: string;
  category: Category;
  condition: "normal" | "faulty";
  legacy_code: string;
  serial_number: string;
  brand: string;
  model: string;
  location: string;
  note: string;
};
export type Placement = {
  holder_party_id: string | null;
  responsible_person_id: string | null;
  usage_kind: "long_term" | "temporary" | null;
  known_on: string | null;
  due_on: string | null;
};
export type PartyInput = {
  kind: "person" | "team";
  name: string;
  person_type: keyof typeof personTypes | null;
  organization_name: string;
  default_responsible_id: string | null;
  note: string;
};
