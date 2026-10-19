<script setup lang="ts">
import { categories, type AssetFieldsInput } from "../inventory-model";
const fields = defineModel<AssetFieldsInput>({ required: true });
defineProps<{ disabled?: boolean }>();
</script>
<template>
  <label
    >设备名称<input
      v-model="fields.name"
      maxlength="120"
      required
      :disabled="disabled"
  /></label>
  <label
    >设备分类<select v-model="fields.category" required :disabled="disabled">
      <option value="">请选择分类</option>
      <option v-for="(label, code) in categories" :key="code" :value="code">
        {{ label }}
      </option>
    </select></label
  >
  <slot />
  <label
    >原资产编号<input
      v-model="fields.legacy_code"
      aria-label="原资产编号"
      maxlength="120"
      :disabled="disabled"
    />
    <span class="hint">可留空；保留原格式和前导零，不作为唯一编号。</span>
  </label>
  <label
    >品牌<input v-model="fields.brand" maxlength="120" :disabled="disabled"
  /></label>
  <label
    >型号<input v-model="fields.model" maxlength="120" :disabled="disabled"
  /></label>
  <label
    >出厂序列号<input
      v-model="fields.serial_number"
      maxlength="120"
      :disabled="disabled"
  /></label>
  <label
    >位置<input v-model="fields.location" maxlength="120" :disabled="disabled"
  /></label>
  <label class="form-wide"
    >设备备注<textarea
      v-model="fields.note"
      maxlength="2000"
      rows="3"
      :disabled="disabled"
      placeholder="配件、外观、历史来源等"
    />
  </label>
</template>
