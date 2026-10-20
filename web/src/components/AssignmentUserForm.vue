<script setup lang="ts">
import QueryState from "./QueryState.vue";
import FormField from "./FormField.vue";
import { computed, ref } from "vue";
import {
  inventoryWriteAccess,
  listParties,
  setAssignmentUser,
  partyLabel,
  type Asset,
} from "../inventory";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { useAuthorizedAction } from "../useAuthorizedAction";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ asset: Asset }>();
const emit = defineEmits<{ updated: [] }>();
const open = ref(false);
const personId = ref(props.asset.actual_user_id || ""),
  reason = ref("");
const eligible = computed(
  () =>
    inventoryWriteAccess.value &&
    props.asset.management_status === "managed" &&
    !props.asset.invalidated_at &&
    props.asset.holder_kind === "team" &&
    !!props.asset.version,
);
const readAccess = computed(() => eligible.value && open.value);
const {
  data,
  error: readError,
  loading,
  load,
} = useAuthorizedQuery(readAccess, listParties);
const people = computed(() =>
  (data.value || []).filter((p) => p.kind === "person"),
);
function clearForm() {
  open.value = false;
  personId.value = props.asset.actual_user_id || "";
  reason.value = "";
}
const { busy, error, run, reset } = useAuthorizedAction(
  eligible,
  [() => props.asset.id, () => props.asset.version],
  clearForm,
);
function save() {
  if (!data.value || loading.value) return;
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    actual_user_id: personId.value || null,
    reason: reason.value.trim(),
  };
  void run(
    payload,
    (id) =>
      setAssignmentUser(
        props.asset,
        payload.actual_user_id,
        payload.reason,
        id,
      ),
    () => emit("updated"),
  );
}
</script>
<template>
  <section v-if="eligible" aria-label="团队具体使用人">
    <h3>团队具体使用人</h3>
    <ActionGroup v-if="!open"
      ><button class="quiet" type="button" @click="open = true">
        补录或更换具体使用人
      </button></ActionGroup
    >
    <form v-else class="stack" @submit.prevent="save">
      <p class="hint">
        只记录团队内部的实际使用人，团队持有方、负责人和期限保持。实际交给其他个人或团队时，请办理转交。
      </p>
      <QueryState
        :loading="loading"
        :error="readError"
        loading-text="正在读取人员名单…"
        retry-label="重新读取人员"
        @retry="load"
      />
      <label
        >具体使用人<select
          v-model="personId"
          :disabled="busy || loading || !data"
        >
          <option value="">待补录／清空</option>
          <option
            v-if="
              asset.actual_user_id &&
              !people.some((p) => p.id === asset.actual_user_id)
            "
            :value="asset.actual_user_id"
            disabled
          >
            {{ asset.actual_user_name || "原使用人" }}（已停用）
          </option>
          <option v-for="person in people" :key="person.id" :value="person.id">
            {{ partyLabel(person) }}
          </option>
        </select></label
      >
      <FormField
        label="记录原因"
        v-model="reason"
        required
        maxlength="2000"
        :disabled="busy"
        type="textarea"
      />
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <ActionGroup
        ><button type="submit" :disabled="busy || loading || !data">
          {{ busy ? "正在保存…" : "保存具体使用人" }}</button
        ><button class="quiet" type="button" :disabled="busy" @click="reset">
          取消补录</button
        ><RouterLink to="/parties">维护人员名单</RouterLink></ActionGroup
      >
    </form>
  </section>
</template>
