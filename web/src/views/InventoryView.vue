<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { computed, reactive, ref } from "vue";
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
import AppIcon from "../components/AppIcon.vue";
const filtersExpanded = ref(false);
const filters = reactive({
  search: "",
  category: "",
  state: "",
  holder_kind: "",
});
const filterCount = computed(
  () =>
    [filters.category, filters.state, filters.holder_kind].filter(Boolean)
      .length,
);
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
  [],
  "assets",
);
const primaryStats = computed(() => {
  const summary = data.value?.summary;
  if (!summary) return [];
  return [
    { key: "", label: "有效设备总数", value: summary.total, tone: "primary" },
    {
      key: "inventory_available",
      label: "在库可用",
      value: summary.inventory_available,
      tone: "success",
    },
    { key: "in_use", label: "使用中", value: summary.in_use, tone: "info" },
    {
      key: "managed_faulty",
      label: "在管故障",
      value: summary.managed_faulty,
      tone: "warning",
    },
  ];
});
const secondaryStats = computed(() => {
  const summary = data.value?.summary;
  if (!summary) return [];
  return [
    {
      key: "inventory_faulty",
      label: "在库故障",
      value: summary.inventory_faulty,
    },
    {
      key: "returned_upstream",
      label: "已退上游",
      value: summary.returned_upstream,
    },
    { key: "lost", label: "遗失", value: summary.lost },
    { key: "scrapped", label: "已报废", value: summary.scrapped },
  ];
});
function selectState(target: string) {
  if (loading.value) return;
  filters.state = filters.state === target ? "" : target;
  void load();
}
</script>
<template>
  <section v-if="inventoryAccess" class="card">
    <div class="section-heading">
      <div>
        <p class="eyebrow">资产总览与检索</p>
        <h1>设备台账</h1>
      </div>
      <div v-if="inventoryWriteAccess" class="action-group page-actions">
        <RouterLink class="button quiet" to="/assets/import"
          ><AppIcon name="upload" />批量导入已有设备</RouterLink
        >
        <RouterLink class="button" to="/assets/new"
          ><AppIcon name="plus" />登记已有设备</RouterLink
        >
      </div>
    </div>
    <div v-if="data" class="inventory-summary" aria-label="设备统计">
      <div class="stats-overview">
        <div
          v-for="stat in primaryStats"
          :key="stat.key"
          class="stat-card"
          :class="[
            'stat-card-' + stat.tone,
            { 'is-active': filters.state === stat.key },
          ]"
          @click="selectState(stat.key)"
        >
          <span>{{ stat.label }}<i class="visually-hidden">：</i></span
          ><strong>{{ stat.value }}</strong>
        </div>
      </div>
      <div class="inventory-breakdown">
        <span
          v-for="stat in secondaryStats"
          :key="stat.key"
          class="breakdown-pill"
          :class="{ 'is-active': filters.state === stat.key }"
          @click="selectState(stat.key)"
          >{{ stat.label }}<i class="visually-hidden">：</i
          ><b>{{ stat.value }}</b></span
        >
      </div>
    </div>
    <form class="inventory-filters" @submit.prevent="load">
      <FormField
        label="搜索设备"
        v-model="filters.search"
        maxlength="120"
        placeholder="编号、名称、型号、持有方或位置"
      />
      <button type="submit" :disabled="loading">
        <AppIcon name="search" />查询
      </button>
      <button
        type="button"
        class="quiet filter-toggle"
        :aria-expanded="filtersExpanded"
        aria-controls="additional-filters"
        @click="filtersExpanded = !filtersExpanded"
      >
        <AppIcon name="settings" />筛选条件<span v-if="filterCount"
          >（{{ filterCount }}）</span
        >
      </button>
      <div
        id="additional-filters"
        class="additional-filters"
        :class="{ 'is-expanded': filtersExpanded }"
      >
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
      </div>
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
        <p class="muted">符合当前条件：{{ data.matched }} 件。</p>
      </template>
      <template #default="{ items }"><AssetTable :items="items" /></template>
    </ListResults>
  </section>
  <InventoryGate v-else />
</template>
