<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed, ref } from "vue";
import {
  inventoryWriteAccess,
  partyFields,
  updateParty,
  type Party,
} from "../inventory";
import { useAuthorizedAction } from "../useAuthorizedAction";
import PartyFields from "./PartyFields.vue";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ party: Party; people: Party[] }>();
const emit = defineEmits<{ updated: [] }>();
const fields = ref(partyFields(props.party));
const enabled = ref(props.party.is_active !== false);
const reason = ref("");
const open = ref(false);
const eligible = computed(
  () => inventoryWriteAccess.value && !!props.party.version,
);
function clearForm() {
  fields.value = partyFields(props.party);
  enabled.value = props.party.is_active !== false;
  reason.value = "";
  open.value = false;
}
const {
  busy,
  error,
  run,
  reset: clear,
} = useAuthorizedAction(
  eligible,
  [() => props.party.id, () => props.party.version],
  clearForm,
);
function save() {
  const payload = {
    party_id: props.party.id,
    expected_version: props.party.version,
    details: { ...fields.value },
    active: enabled.value,
    reason: reason.value.trim(),
  };
  void run(
    payload,
    (id) =>
      updateParty(
        props.party,
        payload.details,
        payload.active,
        payload.reason,
        id,
      ),
    () => emit("updated"),
  );
}
</script>
<template>
  <section v-if="eligible" aria-label="人员和团队维护">
    <ActionGroup v-if="!open"
      ><button type="button" @click="open = true">
        修改资料或启用状态
      </button></ActionGroup
    >
    <form v-else class="form-grid" @submit.prevent="save">
      <PartyFields
        v-model="fields"
        :people="people"
        :disabled="busy"
        fixed-kind
      />
      <label
        >启用状态<select v-model="enabled" :disabled="busy">
          <option :value="true">启用</option>
          <option :value="false">停用</option>
        </select></label
      >
      <p class="form-wide hint">
        停用仅阻止新的领用选择，已有设备仍由原持有方和负责人负责，需另行办理退回或转交。停用团队默认负责人前，须先更换有效团队的默认负责人。
      </p>
      <FormField
        label="修改原因"
        v-model="reason"
        required
        maxlength="2000"
        :disabled="busy"
        type="textarea"
        wide
      />
      <p v-if="error" class="form-wide notice error" role="alert">
        {{ error }}
      </p>
      <ActionGroup class="form-wide"
        ><button type="submit" :disabled="busy">
          {{ busy ? "正在保存…" : "保存人员或团队" }}</button
        ><button class="quiet" type="button" :disabled="busy" @click="clear">
          取消修改
        </button></ActionGroup
      >
    </form>
  </section>
</template>
