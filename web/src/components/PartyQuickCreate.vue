<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  createParty,
  inventoryWriteAccess,
  partyFields,
  requestFor,
  type Party,
} from "../inventory";
import ActionGroup from "./ActionGroup.vue";
import PartyFields from "./PartyFields.vue";
const props = defineProps<{
  people: Party[];
  allowed: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ created: [Party] }>();
const form = ref(partyFields());
const busy = defineModel<boolean>("busy", { default: false });
const canCreate = computed(() => props.allowed && inventoryWriteAccess.value);
const error = ref("");
const notice = ref("");
const requests = new Map<string, string>();
let generation = 0;
watch(
  [
    canCreate,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
  ],
  () => {
    generation++;
    busy.value = false;
    error.value = "";
    notice.value = "";
    form.value = partyFields();
    requests.clear();
  },
  { flush: "sync" },
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
    ...form.value,
    person_type: form.value.kind === "person" ? form.value.person_type : null,
    default_responsible_id:
      form.value.kind === "team" ? form.value.default_responsible_id : null,
  };
  try {
    const result = await createParty(data, requestFor(requests, data));
    if (current === generation && canCreate.value) {
      emit("created", result);
      form.value.name = "";
      form.value.note = "";
      form.value.contact = "";
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
        <PartyFields
          v-model="form"
          :people="people"
          :disabled="busy || disabled"
        />
        <div class="form-wide">
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
