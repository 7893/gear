import { expect, test } from "@playwright/test";
import { csvText } from "../src/csv.js";

test("CSV preserves Chinese, zero prefixes, multiline text and quoted delimiters", () => {
  const csv = csvText({
    headers: ["原资产编号", "名称", "备注", "起始日期"],
    rows: [["00007/A", '打印机,"甲"', "第一行\r\n第二行", ""]],
    businessOn: "2030-01-01",
  });
  expect(csv).toBe(
    '\ufeff"原资产编号","名称","备注","起始日期"\r\n"00007/A","打印机,""甲""","第一行\r\n第二行",""\r\n',
  );
  expect(
    csvText({ headers: ["设备编号"], rows: [], businessOn: "2030-01-01" }),
  ).toBe('\ufeff"设备编号"\r\n');
});

test("spreadsheet commands remain text even behind whitespace and control prefixes", () => {
  const dangerous = [
    '=HYPERLINK("https://example.invalid")',
    "+1+1",
    "-1+1",
    "@SUM(1)",
    "  =1+1",
    "\t=1+1",
    "\r=1+1",
    "\n=1+1",
    "\u0001=1+1",
    "\u007f@SUM(1)",
    "\ufeff=1+1",
    "\tplain",
  ];
  const csv = csvText({
    headers: ["备注"],
    rows: dangerous.map((value) => [value]),
    businessOn: "2030-01-01",
  });
  for (const value of dangerous)
    expect(csv).toContain("\"'" + value.replaceAll('"', '""') + '"');
  const harmless = csvText({
    headers: ["编号"],
    rows: [["SB-000001"], ["00001"], ["普通文字"]],
    businessOn: "2030-01-01",
  });
  expect(harmless).not.toContain("'");
});
