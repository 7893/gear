<script setup lang="ts">
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
  <label
    >当前持有情况<select v-model="mode" :disabled="disabled">
      <option value="inventory">经办人库存</option>
      <option value="person">个人持有</option>
      <option value="team">团队持有</option>
    </select></label
  >
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
    <label
      >使用期限<select v-model="usage" :disabled="disabled">
        <option value="long_term">长期使用</option>
        <option value="temporary">临时使用</option>
      </select></label
    >
    <label v-if="usage === 'temporary'"
      >预计归还日期<input
        v-model="dueOn"
        type="date"
        required
        :min="minDate || undefined"
        :disabled="disabled"
    /></label>
  </template>
</template>
