<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  createParty,
  inventoryWriteAccess,
  partyFields,
  type Party,
} from "../inventory";
import { useAuthorizedAction } from "../useAuthorizedAction";
import ActionGroup from "./ActionGroup.vue";
import PartyFields from "./PartyFields.vue";
const props = defineProps<{
  people: Party[];
  allowed: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ created: [Party] }>();
const form = ref(partyFields());
const parentBusy = defineModel<boolean>("busy", { default: false });
const canCreate = computed(() => props.allowed && inventoryWriteAccess.value);
const notice = ref("");
const { busy, error, run } = useAuthorizedAction(canCreate, [], () => {
  notice.value = "";
  form.value = partyFields();
});
watch(busy, (value) => (parentBusy.value = value), {
  immediate: true,
  flush: "sync",
});
function save() {
  if (busy.value || props.disabled || !canCreate.value) return;
  notice.value = "";
  const data = {
    ...form.value,
    person_type: form.value.kind === "person" ? form.value.person_type : null,
    default_responsible_id:
      form.value.kind === "team" ? form.value.default_responsible_id : null,
  };
  void run(
    data,
    (id) => createParty(data, id),
    (result) => {
      emit("created", result);
      form.value.name = "";
      form.value.note = "";
      form.value.contact = "";
      notice.value = "已新增接收对象，请选择后继续。";
    },
  );
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
