<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { safeError } from "../accounts";
import {
  businessToday,
  changeAssetCondition,
  inventoryWriteAccess,
  requestFor,
  type Asset,
} from "../inventory";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ asset: Asset; earliestOn: string }>();
const emit = defineEmits<{ updated: [condition: Asset["condition"]] }>();
const occurredOn = ref(businessToday());
const reason = ref("");
const error = ref("");
const saving = ref(false);
const requests = new Map<string, string>();
let active = true;
onBeforeUnmount(() => (active = false));
const eligible = computed(
  () =>
    inventoryWriteAccess.value &&
    props.asset.management_status === "managed" &&
    !props.asset.invalidated_at &&
    !!props.asset.version,
);
const fault = computed(() => props.asset.condition === "normal");
const action = computed(() => (fault.value ? "登记故障" : "恢复正常"));
async function submit() {
  if (!eligible.value || saving.value) return;
  if (
    !occurredOn.value ||
    occurredOn.value < props.earliestOn ||
    occurredOn.value > businessToday()
  ) {
    error.value = safeError(new Error("invalid_condition_date"));
    return;
  }
  if (!reason.value.trim()) {
    error.value = safeError(new Error("invalid_condition_change"));
    return;
  }
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    target_condition: fault.value ? ("faulty" as const) : ("normal" as const),
    occurred_on: occurredOn.value,
    reason: reason.value.trim(),
  };
  saving.value = true;
  error.value = "";
  try {
    await changeAssetCondition(
      props.asset,
      payload.target_condition,
      payload.occurred_on,
      payload.reason,
      requestFor(requests, payload),
    );
    if (active && eligible.value) emit("updated", payload.target_condition);
  } catch (failure) {
    if (active && eligible.value) error.value = safeError(failure);
  } finally {
    if (active) saving.value = false;
  }
}
</script>
<template>
  <section v-if="eligible" aria-label="故障与维修">
    <h3>{{ action }}</h3>
    <p>
      记录实际{{
        fault ? "故障" : "维修恢复"
      }}情况，持有方、负责人和使用期限保持不变。
    </p>
    <form class="stack" @submit.prevent="submit">
      <label
        >{{ fault ? "故障发生日期" : "恢复正常日期"
        }}<input
          v-model="occurredOn"
          type="date"
          required
          :min="earliestOn || undefined"
          :max="businessToday()"
          :disabled="saving"
      /></label>
      <label
        >{{ fault ? "故障说明" : "维修处理结果"
        }}<textarea
          v-model="reason"
          required
          maxlength="2000"
          :disabled="saving"
        ></textarea>
      </label>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <ActionGroup :aria-label="action + '操作'">
        <button type="submit" :disabled="saving">
          {{ saving ? "正在记录…" : "确认" + action }}
        </button>
      </ActionGroup>
    </form>
  </section>
</template>
