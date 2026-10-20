<script setup lang="ts">
import { computed, ref } from "vue";
import { useAuthorizedAction } from "../useAuthorizedAction";
import { downloadBlob } from "../download";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{
  allowed: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  query: (
    signal: AbortSignal,
  ) => Promise<{ blob: Blob; filename: string; message: string }>;
}>();
const access = computed(() => props.allowed),
  message = ref("");
const { busy, error, run } = useAuthorizedAction(
  access,
  [],
  () => (message.value = ""),
);
function download() {
  if (props.disabled) return;
  message.value = "";
  void run(
    null,
    (_, signal) => props.query(signal),
    (file) => {
      downloadBlob(file.blob, file.filename);
      message.value = file.message;
    },
  );
}
</script>
<template>
  <div v-if="allowed" class="download-action" aria-label="清单导出">
    <ActionGroup
      ><button
        type="button"
        class="quiet"
        :disabled="disabled || busy"
        @click="download"
      >
        {{ busy ? "正在导出…" : label }}</button
      ><span class="muted">{{ description }}</span></ActionGroup
    >
    <p v-if="error" class="notice error" role="alert">导出失败：{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </div>
</template>
