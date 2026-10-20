import { downloadBlob } from "./download.js";
export type CsvFile = {
  headers: string[];
  rows: string[][];
  businessOn: string;
};

// Quote every cell and neutralize spreadsheet formulas, including whitespace prefixes.
export function csvText(file: CsvFile): string {
  const cell = (value: string) => {
    const safe =
      /^[\s\u0000-\u001f\u007f]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value)
        ? "'" + value
        : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return (
    "\ufeff" +
    [file.headers, ...file.rows]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") +
    "\r\n"
  );
}

export function downloadCsv(file: CsvFile, prefix: string) {
  downloadBlob(
    new Blob([csvText(file)], { type: "text/csv;charset=utf-8" }),
    `${prefix}-${file.businessOn}.csv`,
  );
}
