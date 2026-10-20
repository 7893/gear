import { expect, test } from "@playwright/test";
import { parseInventoryCsv, importHeaders } from "../src/inventory-import.js";
import { recordCode } from "../src/references.js";
import { csvText } from "../src/csv.js";
import type { Party } from "../src/inventory-model.js";
const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const person: Party = {
  id: id(1),
  kind: "person",
  name: "同名人员",
  person_type: "staff",
  organization_name: null,
  default_responsible_id: null,
  note: null,
};
const twin = { ...person, id: id(2) };
const team: Party = {
  ...person,
  id: id(3),
  kind: "team",
  name: "示例团队",
  default_responsible_id: person.id,
};
function parse(
  cells: Record<string, string | undefined> = {},
  headers = importHeaders,
) {
  const defaults = {
    设备名称: '打印机,"甲"',
    设备分类: "打印机",
    状况: "正常",
    原资产编号: "00007/A",
    备注: "第一行\n第二行",
    ...cells,
  };
  return parseInventoryCsv(
    csvText({
      headers,
      rows: [headers.map((h) => defaults[h as keyof typeof defaults] || "")],
      businessOn: "2030-01-01",
    }),
    [person, twin, team],
    "2030-01-01",
  );
}
test("inventory CSV keeps old numbers, Chinese and multiline cells; unknown start dates remain blank", () => {
  const parsed = parse();
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows[0]).toMatchObject({
    details: {
      name: '打印机,"甲"',
      category: "printer",
      condition: "normal",
      legacy_code: "00007/A",
      note: "第一行\n第二行",
    },
    placement: { holder_party_id: null, known_on: null },
  });
  expect(
    parse({ 持有方编码: twin.id, 负责人编码: twin.id, 使用类型: "长期" })
      .errors,
  ).toEqual([]);
  expect(
    parse({
      持有方编码: team.id,
      负责人编码: person.id,
      具体使用人编码: twin.id,
      使用类型: "临时",
      预计归还日期: "2030-01-02",
    }).errors,
  ).toEqual([]);
});
test("CSV preview rejects bad headers, dates and ambiguous/invalid relationships before writes", () => {
  for (const cells of [
    { 设备分类: "unknown" },
    { 状况: "坏了" },
    { 已知起始日期: "2030-02-30" },
    { 已知起始日期: "2030-01-02" },
    { 持有方编码: person.id, 负责人编码: twin.id, 使用类型: "长期" },
    { 持有方编码: person.name, 负责人编码: person.id, 使用类型: "长期" },
    { 持有方编码: team.id, 负责人编码: person.id, 使用类型: "临时" },
    { 具体使用人编码: twin.id },
    { 预计归还日期: "2030-01-02" },
  ])
    expect(parse(cells).errors.length).toBeGreaterThan(0);
  expect(
    parse({}, [...importHeaders.slice(1), importHeaders[1]]).errors,
  ).toHaveLength(1);
  expect(
    parseInventoryCsv('"unfinished', [], "2030-01-01").errors,
  ).toHaveLength(1);
  const csv = csvText({
    headers: importHeaders,
    rows: Array.from({ length: 201 }, () => [
      "设备",
      "电脑",
      "正常",
      ...Array<string>(12).fill(""),
    ]),
    businessOn: "2030-01-01",
  });
  expect(parseInventoryCsv(csv, [], "2030-01-01").errors).toHaveLength(1);
});

test("readable party codes resolve to internal IDs before a CSV write; same names stay distinct", () => {
  const parsed = parse({
    持有方编码: recordCode("TM", team),
    负责人编码: recordCode("PE", person),
    具体使用人编码: recordCode("PE", twin),
    使用类型: "临时",
    预计归还日期: "2030-01-02",
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows[0].placement).toMatchObject({
    holder_party_id: team.id,
    responsible_person_id: person.id,
  });
  expect(parsed.rows[0].actual_user_id).toBe(twin.id);
});
