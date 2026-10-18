<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import {
  inventoryAccess,
  inventoryWriteAccess,
  listAssets,
  categories,
  assetStates,
  holderLabel,
  dueLabel,
  type AssetList,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
const filters = reactive({
  search: "",
  category: "",
  state: "",
  holder_kind: "",
});
const data = ref<AssetList | null>(null);
const loading = ref(false);
const error = ref("");
let generation = 0;
async function load() {
  const current = ++generation;
  data.value = null;
  error.value = "";
  if (!inventoryAccess.value) return;
  loading.value = true;
  try {
    const result = await listAssets({
      search: filters.search,
      category: filters.category || null,
      state: filters.state || null,
      holder_kind: filters.holder_kind || null,
    });
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
    <div class="section-heading">
      <div>
        <p class="eyebrow">设备</p>
        <h1>设备台账</h1>
      </div>
      <RouterLink v-if="inventoryWriteAccess" class="button" to="/assets/new"
        >登记已有设备</RouterLink
      >
    </div>
    <form class="inventory-filters" @submit.prevent="load">
      <label
        >搜索设备<input
          v-model="filters.search"
          maxlength="120"
          placeholder="编号、名称、型号、持有方或位置"
      /></label>
      <label
        >分类<select v-model="filters.category">
          <option value="">全部分类</option>
          <option v-for="(label, code) in categories" :key="code" :value="code">
            {{ label }}
          </option>
        </select></label
      >
      <label
        >状态<select v-model="filters.state">
          <option value="">全部状态</option>
          <option
            v-for="(label, code) in assetStates"
            :key="code"
            :value="code"
          >
            {{ label }}
          </option>
        </select></label
      >
      <label
        >持有情况<select v-model="filters.holder_kind">
          <option value="">全部持有情况</option>
          <option value="inventory">经办人库存</option>
          <option value="person">个人持有</option>
          <option value="team">团队持有</option>
        </select></label
      >
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <p v-if="loading" role="status">正在读取台账…</p>
    <div v-if="error" class="notice error" role="alert">
      <p>{{ error }}</p>
      <button class="quiet" type="button" @click="load">重新查询</button>
    </div>
    <template v-if="data">
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
      <div v-if="data.items.length" class="table-scroll">
        <table class="inventory-table">
          <thead>
            <tr>
              <th>编号与设备</th>
              <th>分类与型号</th>
              <th>状态与状况</th>
              <th>当前持有方</th>
              <th>负责人</th>
              <th>位置</th>
              <th>预计归还</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="asset in data.items" :key="asset.id">
              <td>
                <RouterLink :to="'/assets/' + asset.id"
                  >{{ asset.asset_code }} · {{ asset.name }}</RouterLink
                ><small>旧编号：{{ asset.legacy_code || "未填写" }}</small>
              </td>
              <td>
                {{
                  categories[asset.category as keyof typeof categories] ||
                  asset.category
                }}<small>{{ asset.model || "型号未填写" }}</small>
              </td>
              <td>
                {{ assetStates[asset.display_status]
                }}<small>{{
                  asset.condition === "faulty" ? "故障" : "正常"
                }}</small>
              </td>
              <td>{{ holderLabel(asset) }}</td>
              <td>{{ asset.responsible_name || "不适用" }}</td>
              <td>{{ asset.location || "未填写" }}</td>
              <td>{{ dueLabel(asset) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else>
        {{
          data.summary.total
            ? "没有符合当前条件的设备，请调整查询条件。"
            : "尚未登记设备。"
        }}
      </p>
    </template>
  </section>
  <InventoryGate v-else />
</template>
