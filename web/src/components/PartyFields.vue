<script setup lang="ts">
import FormField from "./FormField.vue";
import { watch } from "vue";
import {
  partyLabel,
  personTypes,
  type Party,
  type PartyInput,
} from "../inventory";
const form = defineModel<PartyInput>({ required: true });
defineProps<{ people: Party[]; disabled?: boolean; fixedKind?: boolean }>();
watch(
  () => form.value.kind,
  (kind) => {
    form.value.person_type = kind === "person" ? "staff" : null;
    form.value.default_responsible_id = null;
  },
);
</script>
<template>
  <FormField
    label="对象类型"
    v-model="form.kind"
    :disabled="disabled || fixedKind"
    :options="{ person: '个人', team: '团队' }"
  />
  <FormField
    label="对象名称"
    v-model="form.name"
    required
    maxlength="80"
    :disabled="disabled"
  />
  <FormField
    label="人员类型"
    v-model="form.person_type"
    :disabled="disabled"
    :options="personTypes"
    v-if="form.kind === 'person'"
  />
  <label v-else
    >团队默认负责人<select
      v-model="form.default_responsible_id"
      required
      :disabled="disabled"
    >
      <option :value="null">请选择个人</option>
      <option v-for="person in people" :key="person.id" :value="person.id">
        {{ partyLabel(person)
        }}{{ person.is_active === false ? "（已停用）" : "" }}
      </option>
    </select></label
  >
  <FormField
    label="所属单位"
    v-model="form.organization_name"
    maxlength="120"
    :disabled="disabled"
  />
  <FormField
    label="联系方式"
    v-model="form.contact"
    maxlength="200"
    :disabled="disabled"
  />
  <FormField
    label="对象备注"
    v-model="form.note"
    maxlength="2000"
    :disabled="disabled"
    type="textarea"
  />
  <p v-if="form.kind === 'team'" class="form-wide hint">
    负责人需先登记为个人。默认负责人只作填表参考，不改动已有设备的责任人。
  </p>
</template>
