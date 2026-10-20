import { recordCode } from "./references.js";
import Papa from "papaparse";
import {
  categories,
  type AssetInput,
  type Placement,
  type Party,
} from "./inventory-model.js";
export const importHeaders = [
  "设备名称",
  "设备分类",
  "状况",
  "原资产编号",
  "出厂序列号",
  "品牌",
  "型号",
  "位置",
  "备注",
  "持有方编码",
  "负责人编码",
  "使用类型",
  "已知起始日期",
  "预计归还日期",
  "具体使用人编码",
];
export type ImportRow = {
  details: AssetInput;
  placement: Placement;
  actual_user_id: string | null;
};
export function parseInventoryCsv(
  text: string,
  parties: Party[],
  today: string,
): { rows: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ImportRow[] = [];
  const parsed = Papa.parse<string[]>(text.replace(/^\ufeff/, ""), {
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  if (parsed.errors.length)
    return { rows, errors: ["CSV 引号或列数不正确，请重新保存为 UTF-8 CSV。"] };
  const [rawHeaders, ...records] = parsed.data;
  const headerAliases: Record<string, string> = {
    持有方ID: "持有方编码",
    负责人ID: "负责人编码",
    具体使用人ID: "具体使用人编码",
  };
  const headers = rawHeaders?.map((h) => headerAliases[h] || h);
  if (
    !headers ||
    headers.length !== importHeaders.length ||
    new Set(headers).size !== headers.length ||
    importHeaders.some((h) => !headers.includes(h))
  )
    return {
      rows,
      errors: ["表头必须与导入模板一致，不得增加、遗漏或重复列。"],
    };
  if (records.length < 1 || records.length > 200)
    return { rows, errors: ["每批应有 1～200 行设备。"] };
  const index = (header: string) => headers.indexOf(header);
  const date = (value: string) =>
    !value ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value);
  for (const [position, cells] of records.entries()) {
    const problems: string[] = [];
    const get = (h: string) => cells[index(h)] || "";
    if (cells.length !== headers.length) problems.push("列数与模板不一致");
    const category = Object.entries(categories).find(([code, label]) =>
      [code, label].includes(get("设备分类").trim()),
    )?.[0] as AssetInput["category"] | undefined;
    const conditions: Record<string, "normal" | "faulty"> = {
      正常: "normal",
      故障: "faulty",
      normal: "normal",
      faulty: "faulty",
    };
    const conditionName = get("状况").trim();
    const condition = Object.hasOwn(conditions, conditionName)
      ? conditions[conditionName]
      : undefined;
    const details: AssetInput = {
      name: get("设备名称").trim(),
      category: category || "other",
      condition: condition || "normal",
      legacy_code: get("原资产编号"),
      serial_number: get("出厂序列号").trim(),
      brand: get("品牌").trim(),
      model: get("型号").trim(),
      location: get("位置").trim(),
      note: get("备注").trim(),
    };
    if (!details.name || !category || !condition)
      problems.push("名称、分类或状况无效");
    if (
      Object.entries(details).some(
        ([key, value]) => value.length > (key === "note" ? 2000 : 120),
      )
    )
      problems.push("文字长度超限");
    const holderRef = get("持有方编码").trim(),
      responsibleRef = get("负责人编码").trim(),
      actualRef = get("具体使用人编码").trim();
    const useText = get("使用类型").trim();
    const usageKinds: Record<string, "long_term" | "temporary"> = {
      长期: "long_term",
      临时: "temporary",
      long_term: "long_term",
      temporary: "temporary",
    };
    const use = Object.hasOwn(usageKinds, useText)
      ? usageKinds[useText]
      : undefined;
    const known = get("已知起始日期").trim(),
      due = get("预计归还日期").trim();
    const find = (value: string) => {
      const matches = parties.filter(
        (p) =>
          p.id === value ||
          recordCode(p.kind === "team" ? "TM" : "PE", p) ===
            value.toUpperCase(),
      );
      return matches.length === 1 ? matches[0] : undefined;
    };
    const holder = find(holderRef),
      responsible = find(responsibleRef),
      actualPerson = find(actualRef);
    const holderId = holder?.id || holderRef,
      responsibleId = responsible?.id || responsibleRef,
      actual = actualPerson?.id || actualRef;
    if (
      !date(known) ||
      !date(due) ||
      (known && known > today) ||
      (known && due && due < known)
    )
      problems.push("日期无效或先后次序错误");
    if (holderId) {
      if (
        !holder ||
        !responsible ||
        responsible.kind !== "person" ||
        (holder.kind === "person" && holderId !== responsibleId)
      )
        problems.push("持有方或负责人编码无效");
      if (
        !use ||
        (use === "temporary" && !due) ||
        (use === "long_term" && !!due)
      )
        problems.push("使用类型与归还日期不匹配");
    } else if (responsibleId || useText || due || actual)
      problems.push("库存设备不应填写持有关系和归还日期");
    if (
      actual &&
      (holder?.kind !== "team" ||
        !parties.some((p) => p.id === actual && p.kind === "person"))
    )
      problems.push("具体使用人只适用于团队，必须是有效个人编码");
    if (problems.length)
      errors.push(`第 ${position + 2} 行：${problems.join("；")}。`);
    rows.push({
      details,
      placement: {
        holder_party_id: holderId || null,
        responsible_person_id: responsibleId || null,
        usage_kind: use || null,
        known_on: known || null,
        due_on: due || null,
      },
      actual_user_id: actual || null,
    });
  }
  return { rows, errors };
}
