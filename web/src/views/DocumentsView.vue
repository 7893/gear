<script setup lang="ts">
import { computed, reactive } from "vue";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { timestamp } from "../inventory";
import {
  flowAccess,
  flowWriteAccess,
  flowKinds,
  documentStates,
  listDocuments,
} from "../flows";
import FlowGate from "../components/FlowGate.vue";
import ActionGroup from "../components/ActionGroup.vue";
const props = defineProps<{ manage?: boolean }>();
const filters = reactive({
  search: "",
  kind: "",
  state: props.manage ? "draft" : "",
});
const { data, loading, error, load } = useAuthorizedQuery(
  flowAccess,
  () =>
    listDocuments({
      search: filters.search,
      kind: filters.kind || null,
      state: filters.state || null,
    }),
  [() => props.manage],
);
const rows = computed(() => data.value || []);
</script>
<template>
  <section v-if="flowAccess" class="card">
    <h1>{{ manage ? "流转办理" : "单据记录" }}</h1>
    <ActionGroup v-if="flowWriteAccess" class="links">
      <RouterLink
        v-for="(label, kind) in flowKinds"
        :key="kind"
        class="button"
        :to="'/documents/new?kind=' + kind"
        >新建{{ label }}单</RouterLink
      >
    </ActionGroup>
    <p class="hint">
      草稿不占库存；请在实际交接时确认。打印和签字件回传不改变设备去向。
    </p>
    <form class="flow-filters" @submit.prevent="load">
      <label
        >搜索单据<input
          v-model="filters.search"
          maxlength="120"
          placeholder="单号、双方或移交接收人"
      /></label>
      <label
        >单据类型<select v-model="filters.kind">
          <option value="">全部类型</option>
          <option v-for="(label, kind) in flowKinds" :key="kind" :value="kind">
            {{ label }}
          </option>
        </select></label
      >
      <label
        >单据状态<select v-model="filters.state">
          <option value="">全部状态</option>
          <option
            v-for="(label, state) in documentStates"
            :key="state"
            :value="state"
          >
            {{ label }}
          </option>
        </select></label
      >
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <p v-if="loading" role="status">正在读取单据…</p>
    <div v-else-if="error" class="notice error" role="alert">
      {{ error }} <button class="quiet" @click="load">重新读取</button>
    </div>
    <div v-else-if="rows.length" class="table-scroll">
      <table class="inventory-table">
        <thead>
          <tr>
            <th>单号 / 类型</th>
            <th>状态</th>
            <th>交接日期 / 双方</th>
            <th>设备数</th>
            <th>记录时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <RouterLink :to="'/documents/' + row.id">{{
                row.document_no || "尚未编号的草稿"
              }}</RouterLink
              ><br />{{ flowKinds[row.kind] || "转交" }}
            </td>
            <td>
              {{ documentStates[row.status] }}<br /><span
                v-if="row.evidence_state === 'awaiting_upload'"
                class="hint"
                >待回传签字件</span
              >
            </td>
            <td>
              {{ row.handover_on || "未填写" }}<br />{{
                row.from_label || "未填写"
              }}
              → {{ row.to_label || "未填写" }}
            </td>
            <td>{{ row.item_count ?? 0 }}</td>
            <td>{{ timestamp(row.created_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else>暂无符合条件的单据。</p>
  </section>
  <FlowGate v-else />
</template>
