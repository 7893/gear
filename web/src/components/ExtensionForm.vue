<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed, ref } from "vue";
import { safeError } from "../accounts";
import {
  businessToday,
  extendAssignment,
  inventoryWriteAccess,
  type Asset,
} from "../inventory";
import { useAuthorizedAction } from "../useAuthorizedAction";
const props = defineProps<{ asset: Asset }>();
const emit = defineEmits<{ updated: [] }>();
const newDueOn = ref("");
const reason = ref("");
const eligible = computed(
  () =>
    inventoryWriteAccess.value &&
    props.asset.management_status === "managed" &&
    !props.asset.invalidated_at &&
    props.asset.usage_kind === "temporary" &&
    !!props.asset.holder_party_id &&
    !!props.asset.due_on &&
    !!props.asset.version,
);
const {
  error,
  busy: saving,
  run,
} = useAuthorizedAction(
  eligible,
  [() => props.asset.id, () => props.asset.version],
  () => {
    newDueOn.value = "";
    reason.value = "";
  },
);
async function submit() {
  if (!eligible.value || saving.value) return;
  if (
    !newDueOn.value ||
    newDueOn.value <= props.asset.due_on! ||
    newDueOn.value < businessToday()
  ) {
    error.value = safeError(new Error("invalid_extension_date"));
    return;
  }
  if (!reason.value.trim()) {
    error.value = safeError(new Error("invalid_extension"));
    return;
  }
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    new_due_on: newDueOn.value,
    reason: reason.value.trim(),
  };
  void run(
    payload,
    (id) =>
      extendAssignment(props.asset, payload.new_due_on, payload.reason, id),
    () => emit("updated"),
  );
}
</script>
<template>
  <section v-if="eligible" aria-label="临时使用延期">
    <h3>临时使用延期</h3>
    <p>
      当前期限：{{
        asset.due_on
      }}。仅延长本设备的当前临时领用，原分发单及签字件保留。
    </p>
    <form class="stack" @submit.prevent="submit">
      <FormField
        label="新的预计归还日期"
        v-model="newDueOn"
        type="date"
        required
        :min="businessToday()"
        :disabled="saving"
      />
      <FormField
        label="延期原因"
        v-model="reason"
        required
        maxlength="2000"
        :disabled="saving"
        type="textarea"
      />
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="saving">
        {{ saving ? "正在保存延期…" : "确认延期" }}
      </button>
    </form>
  </section>
</template>
