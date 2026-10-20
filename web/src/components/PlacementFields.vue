<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed } from "vue";
import { partyLabel, type Party } from "../inventory";
const props = defineProps<{
  parties: Party[];
  minDate?: string;
  disabled?: boolean;
}>();
const mode = defineModel<string>("mode", { required: true });
const holderId = defineModel<string>("holderId", { required: true });
const responsibleId = defineModel<string>("responsibleId", { required: true });
const usage = defineModel<string>("usage", { required: true });
const dueOn = defineModel<string>("dueOn", { required: true });
const holders = computed(() =>
  props.parties.filter((p) => p.kind === mode.value && p.is_active !== false),
);
const people = computed(() =>
  props.parties.filter((p) => p.kind === "person" && p.is_active !== false),
);
</script>
<template>
  <FormField
    label="当前持有情况"
    v-model="mode"
    :disabled="disabled"
    :options="{ inventory: '经办人库存', person: '个人持有', team: '团队持有' }"
  />
  <template v-if="mode !== 'inventory'">
    <label
      >持有方<select v-model="holderId" required :disabled="disabled">
        <option value="">请选择，或先新增接收对象</option>
        <option v-for="p in holders" :key="p.id" :value="p.id">
          {{ partyLabel(p) }}
        </option>
      </select></label
    >
    <label v-if="mode === 'team'"
      >本设备负责人<select
        v-model="responsibleId"
        required
        :disabled="disabled"
      >
        <option value="">请选择个人负责人</option>
        <option v-for="p in people" :key="p.id" :value="p.id">
          {{ partyLabel(p) }}
        </option>
      </select></label
    >
    <FormField
      label="使用期限"
      v-model="usage"
      :disabled="disabled"
      :options="{ long_term: '长期使用', temporary: '临时使用' }"
    />
    <FormField
      label="预计归还日期"
      v-model="dueOn"
      type="date"
      required
      :min="minDate || undefined"
      :disabled="disabled"
      v-if="usage === 'temporary'"
    />
  </template>
</template>
