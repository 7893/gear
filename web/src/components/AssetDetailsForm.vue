<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed, ref, watch } from "vue";
import { safeError } from "../accounts";
import {
  assetFields,
  inventoryWriteAccess,
  updateAssetDetails,
  type Asset,
} from "../inventory";
import { useAuthorizedAction } from "../useAuthorizedAction";
import AssetFields from "./AssetFields.vue";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ asset: Asset }>();
const emit = defineEmits<{ updated: [] }>();
const fields = ref(assetFields(props.asset));
const open = ref(false);
const reason = ref(""),
  duplicate = ref(false),
  acknowledged = ref(false);
const eligible = computed(
  () =>
    inventoryWriteAccess.value &&
    !props.asset.invalidated_at &&
    !!props.asset.version,
);
function clearForm() {
  fields.value = assetFields(props.asset);
  open.value = false;
  reason.value = "";
  duplicate.value = false;
  acknowledged.value = false;
}
const {
  busy,
  error,
  run,
  reset: clear,
} = useAuthorizedAction(
  eligible,
  [() => props.asset.id, () => props.asset.version],
  clearForm,
);
watch(
  () => fields.value.legacy_code,
  () => {
    duplicate.value = false;
    acknowledged.value = false;
  },
);
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
  const details = { ...fields.value, category: fields.value.category };
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    details,
    reason: reason.value.trim(),
    allow_legacy_duplicate: acknowledged.value,
  };
  void run(
    payload,
    (id) =>
      updateAssetDetails(
        props.asset,
        details,
        payload.reason,
        id,
        payload.allow_legacy_duplicate,
      ),
    () => emit("updated"),
    (failure) => {
      if (
        failure &&
        typeof failure === "object" &&
        "message" in failure &&
        failure.message === "legacy_code_duplicate"
      )
        duplicate.value = true;
    },
  );
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
      <FormField
        label="更正原因"
        v-model="reason"
        required
        maxlength="2000"
        :disabled="busy"
        type="textarea"
        wide
      />
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
