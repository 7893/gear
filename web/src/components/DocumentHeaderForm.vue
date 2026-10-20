<script setup lang="ts">
import FormField from "./FormField.vue";
import { ref, watch } from "vue";
import type { AppSettings, HeaderInput } from "../settings";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{
  settings: AppSettings;
  disabled: boolean;
  busy: boolean;
  submitChanges: (input: HeaderInput) => Promise<boolean>;
}>();
const title = ref(props.settings.document_header),
  reason = ref("");
watch(
  () => props.settings.document_header,
  (value) => {
    title.value = value;
    reason.value = "";
  },
);
async function save() {
  if (props.disabled) return;
  const saved = await props.submitChanges({
    document_header: title.value,
    reason: reason.value,
  });
  if (saved) reason.value = "";
}
</script>
<template>
  <form class="stack" @submit.prevent="save">
    <FormField
      label="单位抬头"
      v-model="title"
      required
      maxlength="120"
      :disabled="disabled"
    />
    <FormField
      label="修改原因"
      v-model="reason"
      required
      maxlength="2000"
      :disabled="disabled"
      type="textarea"
    />
    <p class="hint">
      新抬头用于以后确认的单据。已确认或已签字的原单及重新打印的原单保持原抬头；现有草稿在确认时使用当时的设置。
    </p>
    <ActionGroup
      ><button type="submit" :disabled="disabled">
        {{ busy ? "正在保存…" : "保存单位抬头" }}
      </button></ActionGroup
    >
  </form>
</template>
