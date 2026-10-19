<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  inventoryAccess,
  businessToday,
  listParties,
  changeAssetLifecycle,
  lifecycleActions,
  requestFor,
  type Asset,
  type LifecycleAction,
  type RecoveryPlacement,
} from "../inventory";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import ActionGroup from "./ActionGroup.vue";
import PlacementFields from "./PlacementFields.vue";
const props = defineProps<{ asset: Asset; earliestOn: string }>();
const emit = defineEmits<{ updated: [action: LifecycleAction] }>();
const eligible = computed(
  () =>
    inventoryAccess.value &&
    account.profile?.membership?.role === "admin" &&
    !props.asset.invalidated_at &&
    !!props.asset.version &&
    ["managed", "lost"].includes(props.asset.management_status),
);
const open = ref(false);
const action = ref<LifecycleAction>(
  props.asset.management_status === "lost" ? "found" : "lost",
);
const occurredOn = ref(businessToday());
const reason = ref("");
const acknowledged = ref(false);
const condition = ref<Asset["condition"]>(props.asset.condition);
const location = ref("");
const mode = ref("inventory"),
  holderId = ref(""),
  responsibleId = ref(""),
  usage = ref("long_term"),
  dueOn = ref("");
const busy = ref(false),
  error = ref("");
const recoveryAccess = computed(
  () => eligible.value && open.value && action.value === "found",
);
const {
  data: parties,
  loading,
  error: partiesError,
  load,
} = useAuthorizedQuery(recoveryAccess, listParties);
const requests = new Map<string, string>();
let generation = 0;
function reset() {
  generation++;
  open.value = false;
  busy.value = false;
  error.value = "";
  reason.value = "";
  acknowledged.value = false;
  requests.clear();
}
watch(
  [
    eligible,
    () => account.profile?.membership?.id,
    () => props.asset.id,
    () => props.asset.version,
  ],
  reset,
  { flush: "sync" },
);
watch(action, () => {
  acknowledged.value = false;
  error.value = "";
  occurredOn.value = businessToday();
});
watch(mode, () => {
  holderId.value = "";
  responsibleId.value = "";
});
watch(holderId, () => {
  responsibleId.value =
    mode.value === "person"
      ? holderId.value
      : parties.value?.find((p) => p.id === holderId.value)
          ?.default_responsible_id || "";
});
onBeforeUnmount(() => generation++);
async function save() {
  if (
    !eligible.value ||
    !acknowledged.value ||
    busy.value ||
    (action.value === "found" && (!parties.value || loading.value))
  )
    return;
  const current = generation;
  const details: RecoveryPlacement | Record<string, never> =
    action.value === "found"
      ? {
          condition: condition.value,
          location: location.value,
          holder_party_id:
            mode.value === "inventory" ? null : holderId.value || null,
          responsible_person_id:
            mode.value === "inventory"
              ? null
              : mode.value === "person"
                ? holderId.value || null
                : responsibleId.value || null,
          usage_kind:
            mode.value === "inventory"
              ? null
              : (usage.value as "long_term" | "temporary"),
          due_on:
            mode.value !== "inventory" && usage.value === "temporary"
              ? dueOn.value || null
              : null,
        }
      : {};
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    action: action.value,
    occurred_on: occurredOn.value,
    details,
    reason: reason.value.trim(),
  };
  busy.value = true;
  error.value = "";
  try {
    await changeAssetLifecycle(
      props.asset,
      payload.action,
      payload.occurred_on,
      details,
      payload.reason,
      requestFor(requests, payload),
    );
    if (current === generation && eligible.value)
      emit("updated", payload.action);
  } catch (failure) {
    if (current === generation && eligible.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section v-if="eligible" aria-label="设备退出与找回">
    <h3>设备退出与找回</h3>
    <ActionGroup v-if="!open"
      ><button class="quiet" type="button" @click="open = true">
        办理遗失、报废或找回
      </button></ActionGroup
    >
    <form v-else class="form-grid" @submit.prevent="save">
      <label
        >处理类型<select v-model="action" :disabled="busy">
          <template v-if="asset.management_status === 'managed'"
            ><option value="lost">登记遗失</option>
            <option value="scrapped">登记报废</option>
            <option value="invalidate">作废误建台账</option></template
          >
          <option v-else value="found">登记找回</option>
        </select></label
      >
      <label
        >处理日期<input
          v-model="occurredOn"
          type="date"
          required
          :disabled="busy || action === 'invalidate'"
          :min="earliestOn || undefined"
          :max="businessToday()"
      /></label>
      <template v-if="action === 'found'">
        <p class="form-wide hint">
          请核对找回后的实际状况和持有关系，重新选择使用期限；不会自动恢复旧领用记录或旧期限。
        </p>
        <p v-if="loading" role="status">正在读取接收对象…</p>
        <p v-if="partiesError" class="form-wide notice error" role="alert">
          {{ partiesError }}
          <button class="quiet" type="button" @click="load">
            重新读取名单
          </button>
        </p>
        <label
          >找回时状况<select v-model="condition" required :disabled="busy">
            <option value="normal">正常</option>
            <option value="faulty">故障</option>
          </select></label
        >
        <label
          >找回后位置<input v-model="location" maxlength="120" :disabled="busy"
        /></label>
        <PlacementFields
          v-if="parties"
          v-model:mode="mode"
          v-model:holder-id="holderId"
          v-model:responsible-id="responsibleId"
          v-model:usage="usage"
          v-model:due-on="dueOn"
          :parties="parties"
          :min-date="occurredOn"
          :disabled="busy"
        />
      </template>
      <p v-else class="form-wide hint">
        {{
          action === "invalidate"
            ? "仅用于误录且未发生后续流转或处置的初始建账。记录不删除，内部编号不回收。"
            : "关闭当前分配和到期提醒，保留最后责任方与原单据，不作为正常退回。报废不能直接登记找回。"
        }}
      </p>
      <label class="form-wide"
        >处理原因<textarea
          v-model="reason"
          required
          maxlength="2000"
          :disabled="busy"
        />
      </label>
      <label class="form-wide checkbox-row"
        ><input
          v-model="acknowledged"
          type="checkbox"
          required
          :disabled="busy"
        />已核对实际情况，确认办理{{ lifecycleActions[action] }}</label
      >
      <p v-if="error" class="form-wide notice error" role="alert">
        {{ error }}
      </p>
      <ActionGroup class="form-wide"
        ><button
          type="submit"
          :disabled="
            busy ||
            !acknowledged ||
            (action === 'found' && (!parties || loading))
          "
        >
          {{ busy ? "正在记录…" : "确认" + lifecycleActions[action] }}</button
        ><button type="button" class="quiet" :disabled="busy" @click="reset">
          取消处理
        </button></ActionGroup
      >
    </form>
  </section>
</template>
