<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  inventoryWriteAccess,
  partyFields,
  requestFor,
  updateParty,
  type Party,
} from "../inventory";
import PartyFields from "./PartyFields.vue";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ party: Party; people: Party[] }>();
const emit = defineEmits<{ updated: [] }>();
const fields = ref(partyFields(props.party));
const enabled = ref(props.party.is_active !== false);
const reason = ref("");
const error = ref("");
const open = ref(false);
const busy = ref(false);
const eligible = computed(
  () => inventoryWriteAccess.value && !!props.party.version,
);
const requests = new Map<string, string>();
let generation = 0;
function clear() {
  generation++;
  fields.value = partyFields(props.party);
  enabled.value = props.party.is_active !== false;
  reason.value = "";
  error.value = "";
  open.value = false;
  busy.value = false;
  requests.clear();
}
watch(
  [
    eligible,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
    () => props.party.id,
    () => props.party.version,
  ],
  clear,
  { flush: "sync" },
);
onBeforeUnmount(() => generation++);
async function save() {
  if (!eligible.value || busy.value) return;
  const current = generation;
  const details = { ...fields.value };
  const payload = {
    party_id: props.party.id,
    expected_version: props.party.version,
    details,
    active: enabled.value,
    reason: reason.value.trim(),
  };
  busy.value = true;
  error.value = "";
  try {
    await updateParty(
      props.party,
      details,
      payload.active,
      payload.reason,
      requestFor(requests, payload),
    );
    if (current === generation && eligible.value) emit("updated");
  } catch (failure) {
    if (current === generation && eligible.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
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
      <label class="form-wide"
        >修改原因<textarea
          v-model="reason"
          required
          maxlength="2000"
          :disabled="busy"
        />
      </label>
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
