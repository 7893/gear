<script setup lang="ts">
import QueryState from "../components/QueryState.vue";
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
import { useRouteAccess } from "../useRouteAccess";
import InventoryGate from "../components/InventoryGate.vue";
import PartyEditor from "../components/PartyEditor.vue";
import PartyHoldings from "../components/PartyHoldings.vue";
const route = useRoute();
const access = useRouteAccess(inventoryAccess);
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
  <section v-if="access" class="card party-detail-view">
    <div class="detail-top-bar">
      <RouterLink to="/parties" class="back-link">返回人员与团队</RouterLink>
      <button class="quiet" type="button" :disabled="loading" @click="load">
        刷新资料
      </button>
    </div>
    <p class="eyebrow">接收对象资料</p>
    <h1>人员或团队详情</h1>
    <p v-if="notice && data" role="status">{{ notice }}</p>
    <QueryState
      :loading="loading"
      :error="error"
      loading-text="正在读取资料…"
      retry-label=""
    />
    <template v-if="data">
      <div class="detail-hero">
        <div class="detail-hero-main">
          <div class="detail-badges">
            <span
              class="party-kind-badge"
              :class="'party-kind-' + data.party.kind"
            >
              {{ data.party.kind === "team" ? "团队" : "个人" }}
            </span>
            <span
              class="active-badge"
              :class="data.party.is_active ? 'is-active' : 'is-inactive'"
            >
              {{ data.party.is_active ? "启用" : "停用" }}
            </span>
            <span v-if="data.party.reference_code" class="reference-code">
              {{ data.party.reference_code }}
            </span>
          </div>
          <h2>
            {{ data.party.name }}
          </h2>
          <p class="party-kpi-summary">
            当前持有或负责设备：{{
              data.parties.find((p) => p.id === data?.party.id)
                ?.current_asset_count || 0
            }}
            台；作为有效团队默认负责人：{{
              data.parties.find((p) => p.id === data?.party.id)
                ?.default_team_count || 0
            }}
            个。
          </p>
        </div>
      </div>

      <div class="detail-workspace">
        <div class="detail-primary">
          <dl class="asset-fields">
            <div v-for="(title, key) in changedLabels" :key="key">
              <dt>{{ title }}</dt>
              <dd
                class="preserve-text"
                :class="{
                  'is-empty-meta': label(key, data.party[key]) === '未填写',
                }"
              >
                {{ label(key, data.party[key]) }}
              </dd>
            </div>
          </dl>

          <PartyEditor
            :key="data.party.id + ':' + data.party.version"
            :party="data.party"
            :people="people"
            @updated="updated"
          />

          <PartyHoldings
            :key="'holdings:' + data.party.id"
            :party="data.party"
          />
        </div>

        <aside class="detail-timeline">
          <div class="timeline-header">
            <h3>修改历史</h3>
            <span class="timeline-count">{{ data.history.length }} 条记录</span>
          </div>
          <ol class="asset-history">
            <li v-for="event in data.history" :key="event.id">
              <strong>{{
                event.event_type === "party_created"
                  ? "新增接收对象"
                  : "修改人员或团队"
              }}</strong>
              <p>
                {{ timestamp(event.recorded_at) }}；经办人：{{
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
        </aside>
      </div>
    </template>
  </section>
  <InventoryGate v-else title="人员或团队详情" />
</template>
