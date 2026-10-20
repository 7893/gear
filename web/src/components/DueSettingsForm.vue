<script setup lang="ts">
import FormField from "./FormField.vue";
import { ref, watch } from "vue";
import type { DueSettings, DueSettingsInput } from "../settings";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{
  settings: DueSettings;
  disabled: boolean;
  submitChanges: (input: DueSettingsInput) => Promise<boolean>;
}>();
const enabled = ref(props.settings.enabled),
  lead = ref(props.settings.lead_days),
  time = ref(props.settings.local_time),
  reason = ref("");
watch(
  () =>
    [
      props.settings.enabled,
      props.settings.lead_days,
      props.settings.local_time,
    ] as const,
  (value, old) => {
    if (value.some((part, index) => part !== old[index])) {
      enabled.value = value[0];
      lead.value = value[1];
      time.value = value[2];
      reason.value = "";
    }
  },
);
async function save() {
  if (props.disabled) return;
  const saved = await props.submitChanges({
    enabled: enabled.value,
    lead_days: lead.value,
    local_time: time.value,
    reason: reason.value,
  });
  if (saved) reason.value = "";
}
</script>
<template>
  <section aria-label="到期邮件提醒">
    <h2>到期邮件提醒</h2>
    <p>
      提前提醒一次，到期当天提醒一次；逾期仍未处理的，从逾期第 3 天起每隔 3
      天提醒一次。同一天需要提醒的设备合并为一封，发给当前跟进经办人；经办人已停用或无法接收时转给有效管理员。
    </p>
    <form class="stack" @submit.prevent="save">
      <p v-if="!settings.mail_enabled" class="notice">
        通知发送总开关尚未开启，保存提醒规则不会自动开启发信通道。
      </p>
      <label class="check"
        ><input
          v-model="enabled"
          type="checkbox"
          :disabled="disabled"
        />启用到期提醒邮件</label
      ><label
        >提前提醒天数<input
          v-model.number="lead"
          type="number"
          min="0"
          max="30"
          required
          :disabled="disabled" /></label
      ><FormField
        label="发送时间"
        v-model="time"
        type="time"
        required
        :disabled="disabled"
      /><FormField
        label="调整原因"
        v-model="reason"
        required
        maxlength="1000"
        :disabled="disabled"
        type="textarea"
      /><ActionGroup
        ><button type="submit" :disabled="disabled">
          保存到期提醒规则
        </button></ActionGroup
      >
    </form>
  </section>
</template>
