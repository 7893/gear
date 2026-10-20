<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { recordPath } from "../references";
import { computed, ref, watch } from "vue";
import { account } from "../accounts";
import {
  inventoryAccess,
  inventoryWriteAccess,
  listPartyRecords,
  personTypes,
  type Party,
  type PartyRecord,
} from "../inventory";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import InventoryGate from "../components/InventoryGate.vue";
import PartyQuickCreate from "../components/PartyQuickCreate.vue";
import ListResults from "../components/ListResults.vue";
import DataTable from "../components/DataTable.vue";
import type { TableColumn } from "../table";
const columns: TableColumn<PartyRecord>[] = [
  { key: "name", label: "名称" },
  {
    key: "kind",
    label: "类别",
    value: (party) =>
      party.kind === "team"
        ? "团队"
        : personTypes[party.person_type || "other"],
  },
  {
    key: "organization_name",
    label: "所属单位",
    value: (party) => party.organization_name || "未填写",
  },
  {
    key: "default_responsible_id",
    label: "默认负责人",
    value: (party) =>
      data.value?.find((p) => p.id === party.default_responsible_id)?.name ||
      "不适用",
  },
  {
    key: "current_asset_count",
    label: "持有或负责设备",
    value: (party) => `${party.current_asset_count} 台`,
  },
  {
    key: "is_active",
    label: "状态",
    value: (party) => (party.is_active ? "启用" : "停用"),
  },
];
const { data, error, loading, load } = useAuthorizedQuery(
  inventoryAccess,
  listPartyRecords,
);
const search = ref("");
const kind = ref("");
const state = ref("active");
const notice = ref("");
watch(
  [
    inventoryAccess,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
  ],
  () => {
    notice.value = "";
  },
  { flush: "sync" },
);
const people = computed(() =>
  (data.value || []).filter((p) => p.kind === "person" && p.is_active),
);
const filtered = computed(() =>
  (data.value || []).filter(
    (p) =>
      (!kind.value || p.kind === kind.value) &&
      (!state.value || p.is_active === (state.value === "active")) &&
      [p.reference_code, p.name, p.organization_name, p.contact, p.note].some(
        (v) => (v || "").includes(search.value.trim()),
      ),
  ),
);
function created(party: Party) {
  notice.value = `已新增${party.name}。`;
  void load();
}
</script>
<template>
  <section v-if="inventoryAccess" class="card">
    <h1>人员与团队</h1>
    <p>
      接收对象无需注册账号。修改默认负责人不改变已有设备的责任人，停用不代表设备已归还。
    </p>
    <PartyQuickCreate
      v-if="data && inventoryWriteAccess"
      :people="people"
      :allowed="inventoryWriteAccess"
      :disabled="loading"
      @created="created"
    />
    <p v-if="notice" role="status">{{ notice }}</p>
    <form class="inventory-filters" @submit.prevent="load">
      <FormField label="搜索人员或团队" v-model="search" maxlength="200" />
      <FormField
        label="对象类别"
        v-model="kind"
        :options="{ '': '全部类别', person: '个人', team: '团队' }"
      />
      <FormField
        label="对象状态"
        v-model="state"
        :options="{ '': '全部状态', active: '启用', inactive: '停用' }"
      />
      <button type="submit" :disabled="loading">刷新名单</button>
    </form>
    <ListResults
      :items="data ? filtered : null"
      :loading="loading"
      :error="error"
      loading-text="正在读取名单…"
      label="人员与团队分页"
      empty-text="没有符合条件的人员或团队。"
      @retry="load"
    >
      <template #default="{ items }">
        <DataTable :items="items" :columns="columns">
          <template #name="{ row: party }">
            <RouterLink :to="recordPath('party', party)">{{
              party.name
            }}</RouterLink>
            <small class="reference-code" v-if="party.reference_code">{{
              party.reference_code
            }}</small>
          </template>
        </DataTable>
      </template>
    </ListResults>
  </section>
  <InventoryGate v-else title="人员与团队" />
</template>
