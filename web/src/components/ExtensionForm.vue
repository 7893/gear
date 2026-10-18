<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { safeError } from "../accounts";
import {
  businessToday,
  extendAssignment,
  inventoryWriteAccess,
  requestFor,
  type Asset,
} from "../inventory";
const props = defineProps<{ asset: Asset }>();
const emit = defineEmits<{ updated: [] }>();
const newDueOn = ref("");
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
    props.asset.usage_kind === "temporary" &&
    !!props.asset.holder_party_id &&
    !!props.asset.due_on &&
    !!props.asset.version,
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
  saving.value = true;
  error.value = "";
  try {
    await extendAssignment(
      props.asset,
      payload.new_due_on,
      payload.reason,
      requestFor(requests, payload),
    );
    if (active && eligible.value) emit("updated");
  } catch (failure) {
    if (active && eligible.value) error.value = safeError(failure);
  } finally {
    if (active) saving.value = false;
  }
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
      <label
        >新的预计归还日期<input
          v-model="newDueOn"
          type="date"
          required
          :min="businessToday()"
          :disabled="saving"
      /></label>
      <label
        >延期原因<textarea
          v-model="reason"
          required
          maxlength="2000"
          :disabled="saving"
        ></textarea>
      </label>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="saving">
        {{ saving ? "正在保存延期…" : "确认延期" }}
      </button>
    </form>
  </section>
</template>
