<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  inventoryAccess,
  listDueAssets,
  dueStates,
  type DueState,
  type DueAssetList,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
const state = ref<DueState | "">("");
const data = ref<DueAssetList | null>(null);
const error = ref("");
const loading = ref(false);
const page = ref(1);
const pageSize = ref(20);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.items.length || 0) / pageSize.value)),
);
const items = computed(
  () =>
    data.value?.items.slice(
      (page.value - 1) * pageSize.value,
      page.value * pageSize.value,
    ) || [],
);
watch(pageSize, () => (page.value = 1));
let generation = 0;
async function load() {
  const current = ++generation;
  data.value = null;
  error.value = "";
  page.value = 1;
  if (!inventoryAccess.value) return;
  loading.value = true;
  try {
    const result = await listDueAssets(state.value || null);
    if (current === generation && inventoryAccess.value) data.value = result;
  } catch (failure) {
    if (current === generation && inventoryAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  [inventoryAccess, () => account.profile?.membership?.id],
  () => {
    if (inventoryAccess.value) void load();
    else {
      generation++;
      data.value = null;
      loading.value = false;
      error.value = "";
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => generation++);
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
      <nav class="inventory-pagination" aria-label="临时使用分页">
        <label
          >每页显示<select v-model.number="pageSize">
            <option v-for="size in [10, 20, 50, 100]" :key="size" :value="size">
              {{ size }} 条
            </option>
          </select></label
        >
        <p role="status">
          第 {{ page }} / {{ pageCount }} 页，共 {{ data.items.length }} 条
        </p>
        <div class="pagination-actions">
          <button
            class="quiet"
            type="button"
            :disabled="page === 1"
            @click="page = 1"
          >
            首页
          </button>
          <button
            class="quiet"
            type="button"
            :disabled="page === 1"
            @click="page--"
          >
            上一页
          </button>
          <button
            class="quiet"
            type="button"
            :disabled="page >= pageCount"
            @click="page++"
          >
            下一页
          </button>
          <button
            class="quiet"
            type="button"
            :disabled="page >= pageCount"
            @click="page = pageCount"
          >
            末页
          </button>
        </div>
      </nav>
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
      <p class="muted">本页提供站内查询，归还提醒邮件尚未启用。</p>
    </template>
  </section>
  <InventoryGate v-else title="临时使用与到期" />
</template>
