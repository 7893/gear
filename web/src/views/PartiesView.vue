<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { account } from "../accounts";
import {
  inventoryAccess,
  inventoryWriteAccess,
  listPartyRecords,
  personTypes,
  type Party,
} from "../inventory";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { defaultPageSize } from "../pagination";
import InventoryGate from "../components/InventoryGate.vue";
import PartyQuickCreate from "../components/PartyQuickCreate.vue";
import ListPagination from "../components/ListPagination.vue";
const { data, error, loading, load } = useAuthorizedQuery(
  inventoryAccess,
  listPartyRecords,
);
const search = ref("");
const kind = ref("");
const state = ref("active");
const pageSize = ref(defaultPageSize);
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
      [p.name, p.organization_name, p.contact, p.note].some((v) =>
        (v || "").includes(search.value.trim()),
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
      <label>搜索人员或团队<input v-model="search" maxlength="200" /></label>
      <label
        >对象类别<select v-model="kind">
          <option value="">全部类别</option>
          <option value="person">个人</option>
          <option value="team">团队</option>
        </select></label
      >
      <label
        >对象状态<select v-model="state">
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="inactive">停用</option>
        </select></label
      >
      <button type="submit" :disabled="loading">刷新名单</button>
    </form>
    <p v-if="loading" role="status">正在读取名单…</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <ListPagination
      v-if="data"
      v-model:page-size="pageSize"
      :items="filtered"
      label="人员与团队分页"
      v-slot="{ items }"
    >
      <div v-if="items.length" class="table-scroll">
        <table class="inventory-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类别</th>
              <th>所属单位</th>
              <th>默认负责人</th>
              <th>在用设备关联</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="party in items" :key="party.id">
              <td>
                <RouterLink :to="'/parties/' + party.id">{{
                  party.name
                }}</RouterLink>
              </td>
              <td>
                {{
                  party.kind === "team"
                    ? "团队"
                    : personTypes[party.person_type || "other"]
                }}
              </td>
              <td>{{ party.organization_name || "未填写" }}</td>
              <td>
                {{
                  data.find((p) => p.id === party.default_responsible_id)
                    ?.name || "不适用"
                }}
              </td>
              <td>{{ party.current_asset_count }} 台</td>
              <td>{{ party.is_active ? "启用" : "停用" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else>没有符合条件的人员或团队。</p>
    </ListPagination>
  </section>
  <InventoryGate v-else title="人员与团队" />
</template>
