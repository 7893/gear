<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed, ref, watch } from "vue";
import { account } from "../accounts";
import {
  inventoryAccess,
  businessToday,
  listParties,
  changeAssetLifecycle,
  lifecycleActions,
  type Asset,
  type LifecycleAction,
  type RecoveryPlacement,
} from "../inventory";
import { useAuthorizedAction } from "../useAuthorizedAction";
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
const recoveryAccess = computed(
  () => eligible.value && open.value && action.value === "found",
);
const {
  data: parties,
  loading,
  error: partiesError,
  load,
} = useAuthorizedQuery(recoveryAccess, listParties);
const { busy, error, run, reset } = useAuthorizedAction(
  eligible,
  [() => props.asset.id, () => props.asset.version],
  () => {
    open.value = false;
    reason.value = "";
    acknowledged.value = false;
  },
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
async function save() {
  if (
    !eligible.value ||
    !acknowledged.value ||
    busy.value ||
    (action.value === "found" && (!parties.value || loading.value))
  )
    return;
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
  void run(
    payload,
    (id) =>
      changeAssetLifecycle(
        props.asset,
        payload.action,
        payload.occurred_on,
        details,
        payload.reason,
        id,
      ),
    () => emit("updated", payload.action),
  );
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
      <FormField
        label="处理日期"
        v-model="occurredOn"
        type="date"
        required
        :disabled="busy || action === 'invalidate'"
        :min="earliestOn || undefined"
        :max="businessToday()"
      />
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
        <FormField
          label="找回时状况"
          v-model="condition"
          required
          :disabled="busy"
          :options="{ normal: '正常', faulty: '故障' }"
        />
        <FormField
          label="找回后位置"
          v-model="location"
          maxlength="120"
          :disabled="busy"
        />
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
      <FormField
        label="处理原因"
        v-model="reason"
        required
        maxlength="2000"
        :disabled="busy"
        type="textarea"
        wide
      />
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
