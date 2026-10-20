<script setup lang="ts">
import { csvText, type CsvFile } from "../csv";
import DownloadAction from "./DownloadAction.vue";
const props = defineProps<{
  allowed: boolean;
  disabled?: boolean;
  filename: string;
  label?: string;
  description?: string;
  query: (signal: AbortSignal) => Promise<CsvFile>;
}>();
async function queryFile(signal: AbortSignal) {
  const file = await props.query(signal);
  return {
    blob: new Blob([csvText(file)], { type: "text/csv;charset=utf-8" }),
    filename: `${props.filename}-${file.businessOn}.csv`,
    message: `已生成 ${file.rows.length} 条记录，已交由浏览器下载。`,
  };
}
</script>
<template>
  <DownloadAction
    :allowed="allowed"
    :disabled="disabled"
    :label="label || '导出 CSV'"
    :description="description || '按当前筛选条件导出全部结果，不限当前页。'"
    :query="queryFile"
  />
</template>
