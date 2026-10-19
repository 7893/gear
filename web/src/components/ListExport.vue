<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import { downloadCsv, type CsvFile } from "../csv";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{
  allowed: boolean;
  disabled?: boolean;
  filename: string;
  label?: string;
  description?: string;
  query: (signal: AbortSignal) => Promise<CsvFile>;
}>();
const busy = ref(false);
const error = ref("");
const message = ref("");
let generation = 0;
let controller: AbortController | null = null;
function reset() {
  generation++;
  controller?.abort();
  controller = null;
  busy.value = false;
  error.value = "";
  message.value = "";
}
watch(
  [
    () => props.allowed,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
  ],
  reset,
  { flush: "sync" },
);
onBeforeUnmount(reset);
async function exportList() {
  if (!props.allowed || props.disabled || busy.value) return;
  const current = generation;
  controller = new AbortController();
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const file = await props.query(controller.signal);
    if (current !== generation || !props.allowed) return;
    downloadCsv(file, props.filename);
    message.value = `已生成 ${file.rows.length} 条记录，已交由浏览器下载。`;
  } catch (failure) {
    if (current === generation && props.allowed)
      error.value = "导出失败：" + safeError(failure);
  } finally {
    if (current === generation) {
      busy.value = false;
      controller = null;
    }
  }
}
</script>
<template>
  <div v-if="allowed" class="stack" aria-label="清单导出">
    <ActionGroup>
      <button
        type="button"
        class="quiet"
        :disabled="disabled || busy"
        @click="exportList"
      >
        {{ busy ? "正在导出…" : label || "导出 CSV" }}
      </button>
      <span class="muted">{{
        description || "按当前筛选条件导出全部结果，不限当前页。"
      }}</span>
    </ActionGroup>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </div>
</template>
