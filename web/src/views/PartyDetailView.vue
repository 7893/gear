<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { account } from "../accounts";
import { useRoute } from "vue-router";
import {
  getParty,
  inventoryAccess,
  listPartyRecords,
  personTypes,
  timestamp,
  type Party,
} from "../inventory";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import InventoryGate from "../components/InventoryGate.vue";
import PartyEditor from "../components/PartyEditor.vue";
const route = useRoute();
const access = computed(() => inventoryAccess.value && !!route.params.id);
const { data, error, loading, load } = useAuthorizedQuery(access, async () => {
  const [detail, parties] = await Promise.all([
    getParty(String(route.params.id)),
    listPartyRecords(),
  ]);
  return { ...detail, parties };
}, [() => route.params.id]);
const people = computed(() =>
  (data.value?.parties || []).filter(
    (p) =>
      p.kind === "person" &&
      (p.is_active || p.id === data.value?.party.default_responsible_id),
  ),
);
const notice = ref("");
watch(
  [
    access,
    () => route.params.id,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
  ],
  () => {
    notice.value = "";
  },
  { flush: "sync" },
);
function updated() {
  notice.value = "修改已记录，已有分配和原单快照保持。";
  void load();
}
const changedLabels = {
  name: "名称",
  person_type: "人员类型",
  organization_name: "所属单位",
  default_responsible_id: "默认负责人",
  contact: "联系方式",
  note: "备注",
  is_active: "启用状态",
} as const;
type Key = keyof typeof changedLabels;
function label(key: Key, value: unknown, snapshot?: Party) {
  if (key === "is_active") return value === false ? "停用" : "启用";
  if (!value) return "未填写";
  if (key === "person_type")
    return personTypes[value as keyof typeof personTypes] || String(value);
  if (key === "default_responsible_id")
    return snapshot
      ? snapshot.default_responsible_name || "当时负责人（未记录姓名）"
      : data.value?.parties.find((p) => p.id === value)?.name || "原负责人";
  return String(value);
}
</script>
<template>
  <section v-if="access" class="card">
    <RouterLink to="/parties">返回人员与团队</RouterLink>
    <h1>人员或团队详情</h1>
    <button class="quiet" type="button" :disabled="loading" @click="load">
      刷新资料
    </button>
    <p v-if="notice && data" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在读取资料…</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <template v-if="data">
      <h2>
        {{ data.party.name }} · {{ data.party.is_active ? "启用" : "停用" }}
      </h2>
      <dl class="asset-fields">
        <div v-for="(title, key) in changedLabels" :key="key">
          <dt>{{ title }}</dt>
          <dd class="preserve-text">{{ label(key, data.party[key]) }}</dd>
        </div>
      </dl>
      <p>
        当前在用设备关联：{{
          data.parties.find((p) => p.id === data?.party.id)
            ?.current_asset_count || 0
        }}
        台；作为有效团队默认负责人：{{
          data.parties.find((p) => p.id === data?.party.id)
            ?.default_team_count || 0
        }}
        个。
      </p>
      <PartyEditor
        :key="data.party.id + ':' + data.party.version"
        :party="data.party"
        :people="people"
        @updated="updated"
      />
      <h3>修改历史</h3>
      <ol class="asset-history">
        <li v-for="event in data.history" :key="event.id">
          <strong>{{
            event.event_type === "party_created"
              ? "新增接收对象"
              : "修改人员或团队"
          }}</strong>
          <p>
            {{ timestamp(event.recorded_at) }}（东八区）；经办人：{{
              event.actor_label
            }}
          </p>
          <p v-if="event.reason">原因：{{ event.reason }}</p>
          <ul v-if="event.before_data">
            <template v-for="(title, key) in changedLabels" :key="key"
              ><li
                v-if="event.before_data[key] !== event.after_data[key]"
                class="preserve-text"
              >
                {{ title }}：{{
                  label(key, event.before_data[key], event.before_data)
                }}
                →
                {{ label(key, event.after_data[key], event.after_data) }}
              </li></template
            >
          </ul>
        </li>
      </ol>
    </template>
  </section>
  <InventoryGate v-else title="人员或团队详情" />
</template>
