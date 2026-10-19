import {
  categories,
  assetStates,
  dueStates,
  type Asset,
  type AssetList,
  type DueAssetList,
} from "./inventory-model";
import { businessToday, holderLabel } from "./inventory";
import type { CsvFile } from "./csv";

const assetHeaders = [
  "设备编号",
  "原资产编号",
  "序列号",
  "设备名称",
  "分类",
  "品牌",
  "型号",
  "状态",
  "状况",
  "当前持有方",
  "负责人",
  "使用方式",
  "起始日期",
  "预计归还日期",
  "跟进经办人",
  "位置",
  "最近交接日期",
  "备注",
];
function assetRow(asset: Asset): string[] {
  return [
    asset.asset_code,
    asset.legacy_code || "",
    asset.serial_number || "",
    asset.name,
    categories[asset.category as keyof typeof categories] || asset.category,
    asset.brand || "",
    asset.model || "",
    assetStates[asset.display_status],
    asset.condition === "faulty" ? "故障" : "正常",
    holderLabel(asset),
    asset.responsible_name || "",
    asset.usage_kind === "temporary"
      ? "临时使用"
      : asset.usage_kind === "long_term"
        ? "长期使用"
        : "",
    asset.started_on || "",
    asset.due_on || "",
    asset.followup_name || "",
    asset.location || "",
    asset.last_flow_on || "",
    asset.note || "",
  ];
}
export function inventoryCsv(data: AssetList): CsvFile {
  return {
    headers: [...assetHeaders],
    rows: data.items.map(assetRow),
    businessOn: businessToday(),
  };
}
export function dueCsv(data: DueAssetList): CsvFile {
  return {
    headers: [...assetHeaders, "到期情况", "业务日期", "提前提示天数"],
    rows: data.items.map((asset) => [
      ...assetRow(asset),
      dueStates[asset.due_state],
      data.business_on,
      String(data.notice_days),
    ]),
    businessOn: data.business_on,
  };
}
