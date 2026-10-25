<script setup lang="ts">
import { computed } from "vue";
import DataTable from "./DataTable.vue";
import type { TableColumn } from "../table";
import { recordPath } from "../references";
import {
  categories,
  assetStates,
  holderLabel,
  dueLabel,
  partyAssetRelations,
  type Asset,
  type Party,
} from "../inventory";
const props = defineProps<{ items: Asset[]; party?: Party }>();
const columns = computed<TableColumn<Asset>[]>(() => [
  { key: "asset_code", label: "编号与设备" },
  ...(props.party
    ? [
        {
          key: "relation",
          label: "关联类型",
          value: (asset: Asset) => partyAssetRelations(asset, props.party!),
        },
      ]
    : []),
  { key: "category", label: "分类与型号" },
  { key: "display_status", label: "状态与状况" },
  { key: "holder_name", label: "当前持有方", value: holderLabel },
  {
    key: "responsible_name",
    label: "负责人",
    value: (asset) => asset.responsible_name || "不适用",
  },
  {
    key: "actual_user_name",
    label: "具体使用人",
    value: (asset) =>
      asset.actual_user_name ||
      (asset.holder_kind === "person"
        ? asset.holder_name
        : asset.holder_kind === "team"
          ? "待补录"
          : "不适用"),
  },
  {
    key: "location",
    label: "位置",
    value: (asset) => asset.location || "未填写",
  },
  { key: "due_on", label: "预计归还", value: dueLabel },
]);
</script>
<template>
  <DataTable :items="items" :columns="columns">
    <template #asset_code="{ row: asset }">
      <div class="asset-primary-cell">
        <RouterLink class="asset-title-link" :to="recordPath('asset', asset)"
          >{{ asset.asset_code }} · {{ asset.name }}</RouterLink
        >
        <div class="asset-submeta">
          <span v-if="asset.reference_code" class="reference-pill">{{
            asset.reference_code
          }}</span>
          <small :class="{ 'is-empty-meta': !asset.legacy_code }"
            >旧编号：{{ asset.legacy_code || "未填写" }}</small
          >
        </div>
      </div>
    </template>
    <template #category="{ row: asset }">
      <span class="category-tag">{{
        categories[asset.category as keyof typeof categories] || asset.category
      }}</span>
      <small :class="{ 'is-empty-meta': !asset.model }">{{
        asset.model || "型号未填写"
      }}</small>
    </template>
    <template #display_status="{ row: asset }">
      <div class="status-stack">
        <span
          class="asset-status"
          :class="'asset-status-' + asset.display_status"
          >{{ assetStates[asset.display_status] }}</span
        >
        <small
          class="condition-pill"
          :class="
            asset.condition === 'faulty'
              ? 'condition-faulty'
              : 'condition-normal'
          "
          >{{ asset.condition === "faulty" ? "故障" : "正常" }}</small
        >
      </div>
    </template>
  </DataTable>
</template>
