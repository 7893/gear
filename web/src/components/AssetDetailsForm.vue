<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  assetFields,
  inventoryWriteAccess,
  requestFor,
  updateAssetDetails,
  type Asset,
} from "../inventory";
import AssetFields from "./AssetFields.vue";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ asset: Asset }>();
const emit = defineEmits<{ updated: [] }>();
const fields = ref(assetFields(props.asset));
const open = ref(false),
  busy = ref(false),
  error = ref("");
const reason = ref(""),
  duplicate = ref(false),
  acknowledged = ref(false);
const requests = new Map<string, string>();
let generation = 0;
const eligible = computed(
  () =>
    inventoryWriteAccess.value &&
    !props.asset.invalidated_at &&
    !!props.asset.version,
);
function clear() {
  generation++;
  fields.value = assetFields(props.asset);
  open.value = false;
  busy.value = false;
  error.value = "";
  reason.value = "";
  duplicate.value = false;
  acknowledged.value = false;
  requests.clear();
}
watch(
  [
    eligible,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
    () => props.asset.id,
    () => props.asset.version,
  ],
  clear,
  { flush: "sync" },
);
watch(
  () => fields.value.legacy_code,
  () => {
    duplicate.value = false;
    acknowledged.value = false;
  },
);
onBeforeUnmount(() => generation++);
async function save() {
  if (
    !eligible.value ||
    busy.value ||
    !fields.value.category ||
    (duplicate.value && !acknowledged.value)
  )
    return;
  if (!reason.value.trim()) {
    error.value = safeError(new Error("invalid_asset_details"));
    return;
  }
  const current = generation;
  const details = { ...fields.value, category: fields.value.category };
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    details,
    reason: reason.value.trim(),
    allow_legacy_duplicate: acknowledged.value,
  };
  busy.value = true;
  error.value = "";
  try {
    await updateAssetDetails(
      props.asset,
      details,
      payload.reason,
      requestFor(requests, payload),
      payload.allow_legacy_duplicate,
    );
    if (current === generation && eligible.value) emit("updated");
  } catch (failure) {
    if (current === generation && eligible.value) {
      error.value = safeError(failure);
      if (
        failure &&
        typeof failure === "object" &&
        "message" in failure &&
        failure.message === "legacy_code_duplicate"
      )
        duplicate.value = true;
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section v-if="eligible" aria-label="设备资料更正">
    <h3>设备资料更正</h3>
    <ActionGroup v-if="!open"
      ><button type="button" class="quiet" @click="open = true">
        更正基本资料
      </button></ActionGroup
    >
    <form v-else class="form-grid" @submit.prevent="save">
      <p class="form-wide muted">
        更正名称、分类、旧编号等资料并保留前后记录。内部编号、持有方、实际状况、期限及原单快照保持不变。
      </p>
      <AssetFields v-model="fields" :disabled="busy" />
      <label class="form-wide"
        >更正原因<textarea
          v-model="reason"
          required
          maxlength="2000"
          :disabled="busy"
        />
      </label>
      <label v-if="duplicate" class="form-wide checkbox-row"
        ><input
          v-model="acknowledged"
          type="checkbox"
          :disabled="busy"
        />已核对重复旧编号，确认是不同实物</label
      >
      <p v-if="error" class="form-wide notice error" role="alert">
        {{ error }}
      </p>
      <ActionGroup class="form-wide">
        <button type="submit" :disabled="busy || (duplicate && !acknowledged)">
          {{ busy ? "正在保存…" : "保存资料更正" }}
        </button>
        <button type="button" class="quiet" :disabled="busy" @click="clear">
          取消更正
        </button>
      </ActionGroup>
    </form>
  </section>
</template>
