import { expect, test } from "@playwright/test";
import {
  recordCode,
  recordPath,
  returnPath,
  referencePattern,
} from "../src/references.js";
import { extractHints } from "../src/evidence-model.js";

test("grouped reference encoder is deterministic and uses the business year", () => {
  const record = {
    id: "12345678-1234-4234-8234-1234abcdefab",
    created_at: "2029-12-31T16:00:00Z",
  };
  const code = recordCode("EQ", record);
  expect(code).toMatch(referencePattern);
  expect(code).toMatch(/^EQ-30-/);
  expect(recordCode("EQ", record)).toBe(code);
  expect(code).not.toMatch(/[ILOU]/);
  expect(
    recordCode("EQ", { ...record, reference_code: "EQ-30-7K4M-9P2X" }),
  ).toBe("EQ-30-7K4M-9P2X");
  expect(recordPath("asset", { ...record, reference_code: code })).toBe(
    "/assets/" + code,
  );
});

test("scan links retain document-number recognition and narrowly allow login return paths", () => {
  const path = "/scan/document/FF-20300101-0001";
  expect(returnPath(path)).toBe(path);
  for (const invalid of [
    "https://example.invalid",
    "//example.invalid",
    "/scan/document/%2Fexample",
    "/scan/document/FF-20300101-0001?next=https://example.invalid",
    "/assets/new",
    [path],
  ])
    expect(returnPath(invalid)).toBeNull();
  expect(extractHints(["https://app.example.invalid/#" + path])).toEqual({
    document_ids: [],
    document_numbers: ["FF-20300101-0001"],
  });
  expect(
    extractHints(["gear:document:12345678-1234-4234-8234-1234abcdefab"]),
  ).toEqual({
    document_ids: ["12345678-1234-4234-8234-1234abcdefab"],
    document_numbers: [],
  });
});
