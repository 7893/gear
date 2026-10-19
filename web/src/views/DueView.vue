<script setup lang="ts">
import { ref } from "vue";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import {
  inventoryAccess,
  listDueAssets,
  dueStates,
  type DueState,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
import ListPagination from "../components/ListPagination.vue";
import { defaultPageSize } from "../pagination";
const state = ref<DueState | "">("");
const pageSize = ref(defaultPageSize);
const { data, error, loading, load } = useAuthorizedQuery(inventoryAccess, () =>
  listDueAssets(state.value || null),
);
</script>
<template>
  <section v-if="inventoryAccess" class="card">
    <h1>临时使用与到期</h1>
    <p>
      只列当前仍在管的临时领用设备。到期当天不算逾期；点击设备可查看详情或办理延期。
    </p>
    <form class="inventory-filters" @submit.prevent="load">
      <label
        >到期情况<select v-model="state">
          <option value="">全部临时领用</option>
          <option v-for="(label, key) in dueStates" :key="key" :value="key">
            {{ label }}
          </option>
        </select></label
      >
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <p v-if="loading" role="status">正在读取临时领用…</p>
    <div v-if="error" class="notice error" role="alert">
      <p>{{ error }}</p>
      <button class="quiet" type="button" @click="load">重新查询</button>
    </div>
    <template v-if="data">
      <p>
        业务日期：{{ data.business_on }}（东八区）；提前
        {{ data.notice_days }} 天提示。
      </p>
      <div class="inventory-summary" aria-label="临时使用统计">
        <span>临时使用总数：{{ data.summary.total }}</span>
        <span v-for="(label, key) in dueStates" :key="key"
          >{{ label }}：{{ data.summary[key] }}</span
        >
      </div>
      <ListPagination
        v-model:page-size="pageSize"
        :items="data.items"
        label="临时使用分页"
        v-slot="{ items }"
      >
        <div v-if="items.length" class="table-scroll">
          <table class="inventory-table">
            <thead>
              <tr>
                <th>编号与设备</th>
                <th>当前持有方</th>
                <th>负责人</th>
                <th>预计归还</th>
                <th>到期情况</th>
                <th>跟进经办人</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="asset in items" :key="asset.id">
                <td>
                  <RouterLink :to="'/assets/' + asset.id"
                    >{{ asset.asset_code }} · {{ asset.name }}</RouterLink
                  >
                </td>
                <td>{{ asset.holder_name }}</td>
                <td>{{ asset.responsible_name }}</td>
                <td>{{ asset.due_on }}</td>
                <td>{{ dueStates[asset.due_state] }}</td>
                <td>{{ asset.followup_name || "未指定" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else>当前条件下没有临时领用设备。</p>
      </ListPagination>
      <p class="muted">本页提供站内查询，归还提醒邮件尚未启用。</p>
    </template>
  </section>
  <InventoryGate v-else title="临时使用与到期" />
</template>
