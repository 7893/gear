<script setup lang="ts">
import FormField from "./FormField.vue";
import { categories, type AssetFieldsInput } from "../inventory-model";
const fields = defineModel<AssetFieldsInput>({ required: true });
defineProps<{ disabled?: boolean }>();
</script>
<template>
  <FormField
    label="设备名称"
    v-model="fields.name"
    maxlength="120"
    required
    :disabled="disabled"
  />
  <FormField
    label="设备分类"
    v-model="fields.category"
    required
    :disabled="disabled"
    :options="categories"
    empty-label="请选择分类"
  />
  <slot />
  <FormField
    label="原资产编号"
    v-model="fields.legacy_code"
    aria-label="原资产编号"
    maxlength="120"
    :disabled="disabled"
    hint="可留空；保留原格式和前导零，不作为唯一编号。"
  />
  <FormField
    label="品牌"
    v-model="fields.brand"
    maxlength="120"
    :disabled="disabled"
  />
  <FormField
    label="型号"
    v-model="fields.model"
    maxlength="120"
    :disabled="disabled"
  />
  <FormField
    label="出厂序列号"
    v-model="fields.serial_number"
    maxlength="120"
    :disabled="disabled"
  />
  <FormField
    label="位置"
    v-model="fields.location"
    maxlength="120"
    :disabled="disabled"
  />
  <FormField
    label="设备备注"
    v-model="fields.note"
    maxlength="2000"
    rows="3"
    :disabled="disabled"
    placeholder="配件、外观、历史来源等"
    type="textarea"
    wide
  />
</template>
