<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { ref } from "vue";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import {
  inventoryAccess,
  listDueAssets,
  dueStates,
  type DueState,
  type DueAssetList,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
import ListResults from "../components/ListResults.vue";
import ListExport from "../components/ListExport.vue";
import { dueCsv } from "../inventory-export";
import DataTable from "../components/DataTable.vue";
import type { TableColumn } from "../table";
const columns: TableColumn<DueAssetList["items"][number]>[] = [
  { key: "asset_code", label: "编号与设备" },
  { key: "holder_name", label: "当前持有方" },
  { key: "responsible_name", label: "负责人" },
  { key: "due_on", label: "预计归还" },
  {
    key: "due_state",
    label: "到期情况",
    value: (asset) => dueStates[asset.due_state],
  },
  {
    key: "followup_name",
    label: "跟进经办人",
    value: (asset) => asset.followup_name || "未指定",
  },
];
const state = ref<DueState | "">("");
const query = () => listDueAssets(state.value || null);
const { data, error, loading, load } = useAuthorizedQuery(
  inventoryAccess,
  query,
  [],
  "due-assets",
);
</script>
<template>
  <section v-if="inventoryAccess" class="card">
    <h1>临时使用与到期</h1>
    <p>
      只列当前仍在管的临时领用设备。到期当天不算逾期；点击设备可查看详情或办理延期。
    </p>
    <form class="inventory-filters" @submit.prevent="load">
      <FormField
        label="到期情况"
        v-model="state"
        :options="dueStates"
        empty-label="全部临时领用"
      />
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <ListExport
      :allowed="inventoryAccess"
      :disabled="loading"
      filename="临时使用清单"
      :query="async () => dueCsv(await query())"
    />
    <ListResults
      :items="data?.items ?? null"
      :loading="loading"
      :error="error"
      loading-text="正在读取临时领用…"
      retry-label="重新查询"
      label="临时使用分页"
      empty-text="当前条件下没有临时领用设备。"
      @retry="load"
    >
      <template #summary v-if="data">
        <p>
          业务日期：{{ data.business_on }}；提前 {{ data.notice_days }} 天提示。
        </p>
        <div class="inventory-summary" aria-label="临时使用统计">
          <span>临时使用总数：{{ data.summary.total }}</span>
          <span v-for="(label, key) in dueStates" :key="key"
            >{{ label }}：{{ data.summary[key] }}</span
          >
        </div>
      </template>
      <template #default="{ items }">
        <DataTable :items="items" :columns="columns">
          <template #asset_code="{ row: asset }"
            ><RouterLink :to="'/assets/' + asset.id"
              >{{ asset.asset_code }} · {{ asset.name }}</RouterLink
            ></template
          >
        </DataTable>
      </template>
      <template #footer
        ><p class="muted">本页提供站内查询，归还提醒邮件尚未启用。</p></template
      >
    </ListResults>
  </section>
  <InventoryGate v-else title="临时使用与到期" />
</template>
