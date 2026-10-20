<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { reactive } from "vue";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import {
  inventoryAccess,
  inventoryWriteAccess,
  listAssets,
  categories,
  assetStates,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
import AssetTable from "../components/AssetTable.vue";
import ListResults from "../components/ListResults.vue";
import ListExport from "../components/ListExport.vue";
import { inventoryCsv } from "../inventory-export";
const filters = reactive({
  search: "",
  category: "",
  state: "",
  holder_kind: "",
});
const query = () =>
  listAssets({
    search: filters.search,
    category: filters.category || null,
    state: filters.state || null,
    holder_kind: filters.holder_kind || null,
  });
const { data, loading, error, load } = useAuthorizedQuery(
  inventoryAccess,
  query,
);
</script>
<template>
  <section v-if="inventoryAccess" class="card">
    <div class="section-heading">
      <div>
        <p class="eyebrow">设备</p>
        <h1>设备台账</h1>
      </div>
      <RouterLink v-if="inventoryWriteAccess" class="button" to="/assets/new"
        >登记已有设备</RouterLink
      >
    </div>
    <RouterLink v-if="inventoryWriteAccess" to="/assets/import"
      >批量导入已有设备</RouterLink
    >
    <form class="inventory-filters" @submit.prevent="load">
      <FormField
        label="搜索设备"
        v-model="filters.search"
        maxlength="120"
        placeholder="编号、名称、型号、持有方或位置"
      />
      <FormField
        label="分类"
        v-model="filters.category"
        :options="categories"
        empty-label="全部分类"
      />
      <FormField
        label="状态"
        v-model="filters.state"
        :options="assetStates"
        empty-label="全部状态"
      />
      <FormField
        label="持有情况"
        v-model="filters.holder_kind"
        :options="{
          '': '全部持有情况',
          inventory: '经办人库存',
          person: '个人持有',
          team: '团队持有',
        }"
      />
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <ListExport
      :allowed="inventoryAccess"
      :disabled="loading"
      filename="设备台账"
      :query="async () => inventoryCsv(await query())"
    />
    <ListResults
      :items="data?.items ?? null"
      :loading="loading"
      :error="error"
      loading-text="正在读取台账…"
      retry-label="重新查询"
      label="设备分页"
      :empty-text="
        data?.summary.total
          ? '没有符合当前条件的设备，请调整查询条件。'
          : '尚未登记设备。'
      "
      @retry="load"
    >
      <template #summary v-if="data">
        <div class="inventory-summary" aria-label="设备统计">
          <span>有效设备总数：{{ data.summary.total }}</span>
          <span v-for="(label, status) in assetStates" :key="status"
            >{{ label }}：{{ data.summary[status] }}</span
          >
          <span>在管故障：{{ data.summary.managed_faulty }}（交叉统计）</span>
        </div>
        <p class="muted">
          符合当前条件：{{ data.matched }} 件。日期按东八区显示。
        </p>
      </template>
      <template #default="{ items }"><AssetTable :items="items" /></template>
    </ListResults>
  </section>
  <InventoryGate v-else />
</template>
