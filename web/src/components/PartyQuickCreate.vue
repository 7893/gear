<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  createParty,
  inventoryWriteAccess,
  partyLabel,
  personTypes,
  requestFor,
  type Party,
  type PartyInput,
} from "../inventory";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{
  people: Party[];
  allowed: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ created: [Party] }>();
const blank = (): PartyInput => ({
  kind: "person",
  name: "",
  person_type: "staff",
  organization_name: "",
  default_responsible_id: null,
  note: "",
});
const form = reactive(blank());
const busy = defineModel<boolean>("busy", { default: false });
const canCreate = computed(() => props.allowed && inventoryWriteAccess.value);
const error = ref("");
const notice = ref("");
const requests = new Map<string, string>();
let generation = 0;
watch(
  [canCreate, () => account.profile?.membership?.id],
  () => {
    generation++;
    busy.value = false;
    error.value = "";
    notice.value = "";
    Object.assign(form, blank());
    requests.clear();
  },
  { flush: "sync" },
);
watch(
  () => form.kind,
  (kind) => {
    form.person_type = kind === "person" ? "staff" : null;
    form.default_responsible_id = null;
  },
);
onBeforeUnmount(() => {
  generation++;
  busy.value = false;
});
async function save() {
  if (busy.value || props.disabled || !canCreate.value) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  const data = {
    ...form,
    person_type: form.kind === "person" ? form.person_type : null,
    default_responsible_id:
      form.kind === "team" ? form.default_responsible_id : null,
  };
  try {
    const result = await createParty(data, requestFor(requests, data));
    if (current === generation && canCreate.value) {
      emit("created", result);
      form.name = "";
      form.note = "";
      notice.value = "已新增接收对象，请选择后继续。";
    }
  } catch (failure) {
    if (current === generation && canCreate.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <details v-if="canCreate" class="recipient-editor">
    <summary>新增个人或团队</summary>
    <form @submit.prevent="save">
      <fieldset class="form-grid" :disabled="busy || disabled">
        <label
          >对象类型<select v-model="form.kind">
            <option value="person">个人</option>
            <option value="team">团队</option>
          </select></label
        >
        <label
          >对象名称<input v-model="form.name" required maxlength="80"
        /></label>
        <template v-if="form.kind === 'person'"
          ><label
            >人员类型<select v-model="form.person_type">
              <option
                v-for="(label, type) in personTypes"
                :key="type"
                :value="type"
              >
                {{ label }}
              </option>
            </select></label
          ><label
            >所属单位<input
              v-model="form.organization_name"
              maxlength="120" /></label
        ></template>
        <label v-else
          >团队默认负责人<select v-model="form.default_responsible_id" required>
            <option :value="null">请选择个人</option>
            <option
              v-for="person in people"
              :key="person.id"
              :value="person.id"
            >
              {{ partyLabel(person) }}
            </option>
          </select></label
        >
        <label>对象备注<textarea v-model="form.note" maxlength="2000" /></label>
        <div class="form-wide">
          <p v-if="form.kind === 'team'" class="hint">
            负责人需先登记为个人。默认负责人只作填表参考，不改动已有设备的责任人。
          </p>
          <p v-if="error" class="notice error" role="alert">{{ error }}</p>
          <p v-if="notice" role="status">{{ notice }}</p>
          <ActionGroup aria-label="新增接收对象操作">
            <button type="submit">
              {{ busy ? "添加中…" : "新增接收对象" }}
            </button>
          </ActionGroup>
        </div>
      </fieldset>
    </form>
  </details>
</template>
