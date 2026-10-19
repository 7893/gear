<script setup lang="ts">
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
  <label
    >对象类型<select v-model="form.kind" :disabled="disabled || fixedKind">
      <option value="person">个人</option>
      <option value="team">团队</option>
    </select></label
  >
  <label
    >对象名称<input
      v-model="form.name"
      required
      maxlength="80"
      :disabled="disabled"
  /></label>
  <label v-if="form.kind === 'person'"
    >人员类型<select v-model="form.person_type" :disabled="disabled">
      <option v-for="(label, type) in personTypes" :key="type" :value="type">
        {{ label }}
      </option>
    </select></label
  >
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
  <label
    >所属单位<input
      v-model="form.organization_name"
      maxlength="120"
      :disabled="disabled"
  /></label>
  <label
    >联系方式<input v-model="form.contact" maxlength="200" :disabled="disabled"
  /></label>
  <label
    >对象备注<textarea
      v-model="form.note"
      maxlength="2000"
      :disabled="disabled"
    />
  </label>
  <p v-if="form.kind === 'team'" class="form-wide hint">
    负责人需先登记为个人。默认负责人只作填表参考，不改动已有设备的责任人。
  </p>
</template>
