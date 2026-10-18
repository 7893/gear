<script setup lang="ts">
import { reactive, ref } from "vue";
import { account, safeError } from "../accounts";
import {
  createParty,
  personTypes,
  requestFor,
  type Party,
  type PartyInput,
} from "../inventory";
import { flowWriteAccess } from "../flows";
const props = defineProps<{ people: Party[]; disabled?: boolean }>();
const emit = defineEmits<{ created: [Party] }>();
const form = reactive<PartyInput>({
  kind: "person",
  name: "",
  person_type: "staff",
  organization_name: "",
  default_responsible_id: null,
  note: "",
});
const busy = ref(false);
const error = ref("");
const notice = ref("");
const requests = new Map<string, string>();
async function save() {
  if (busy.value || props.disabled || !flowWriteAccess.value) return;
  const owner = account.profile?.membership?.id;
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
    if (flowWriteAccess.value && owner === account.profile?.membership?.id) {
      emit("created", result);
      form.name = "";
      form.note = "";
      notice.value = "已新增接收对象，请选择后继续。";
    }
  } catch (failure) {
    if (flowWriteAccess.value && owner === account.profile?.membership?.id)
      error.value = safeError(failure);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details>
    <summary>没有接收对象？新增个人或团队</summary>
    <form @submit.prevent="save">
      <fieldset :disabled="busy || disabled">
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
              {{ person.name }}
            </option>
          </select></label
        >
        <label>对象备注<textarea v-model="form.note" maxlength="2000" /></label
        ><button type="submit">新增接收对象</button>
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
      </fieldset>
    </form>
  </details>
</template>
