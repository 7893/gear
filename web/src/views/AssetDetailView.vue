<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { account } from "../accounts";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import {
  inventoryAccess,
  inventoryWriteAccess,
  getAsset,
  categories,
  assetStates,
  holderLabel,
  dueLabel,
  timestamp,
  type Asset,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
import ExtensionForm from "../components/ExtensionForm.vue";
import AssetConditionForm from "../components/AssetConditionForm.vue";
const route = useRoute();
const detailAccess = computed(() => inventoryAccess.value && !!route.params.id);
const { data, error, loading, load } = useAuthorizedQuery(
  detailAccess,
  () => getAsset(String(route.params.id)),
  [() => route.params.id],
);
const message = ref("");
const conditionEarliestOn = computed(
  () =>
    [
      data.value?.asset.last_flow_on,
      data.value?.asset.started_on,
      ...(data.value?.history || [])
        .filter((event) =>
          ["asset_fault_reported", "asset_repaired"].includes(event.event_type),
        )
        .map((event) => event.occurred_on),
    ]
      .filter((date): date is string => !!date)
      .sort()
      .at(-1) || "",
);
function conditionChanged(condition: Asset["condition"]) {
  message.value =
    condition === "faulty"
      ? "故障已记录，持有关系保持不变。"
      : "维修恢复已记录，设备编号和持有关系保持不变。";
  void load();
}
function extended() {
  message.value = "延期已记录，原分发单和签字件保留。";
  void load();
}
watch(
  [
    inventoryAccess,
    () => account.profile?.membership?.id,
    () => route.params.id,
  ],
  () => {
    message.value = "";
  },
);
</script>
<template>
  <section v-if="inventoryAccess" class="card">
    <RouterLink to="/assets">返回设备台账</RouterLink>
    <h1 class="refresh">设备详情</h1>
    <button type="button" class="quiet" :disabled="loading" @click="load">
      刷新设备情况
    </button>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p v-if="loading" role="status">正在读取设备…</p>
    <div v-if="error" class="notice error" role="alert">
      <p>{{ error }}</p>
      <button class="quiet" type="button" @click="load">重新读取</button>
    </div>
    <template v-if="data">
      <h2>{{ data.asset.asset_code }} · {{ data.asset.name }}</h2>
      <p v-if="data.asset.invalidated_at" class="notice">
        此建账记录已标记无效，保留历史供核对。
      </p>
      <h3>当前情况</h3>
      <dl class="asset-fields">
        <div>
          <dt>原资产编号</dt>
          <dd>{{ data.asset.legacy_code || "未填写" }}</dd>
        </div>
        <div>
          <dt>分类</dt>
          <dd>
            {{
              categories[data.asset.category as keyof typeof categories] ||
              data.asset.category
            }}
          </dd>
        </div>
        <div>
          <dt>品牌 / 型号</dt>
          <dd>
            {{ data.asset.brand || "品牌未填写" }} /
            {{ data.asset.model || "型号未填写" }}
          </dd>
        </div>
        <div>
          <dt>出厂序列号</dt>
          <dd>{{ data.asset.serial_number || "未填写" }}</dd>
        </div>
        <div>
          <dt>状态 / 状况</dt>
          <dd>
            {{ assetStates[data.asset.display_status] }} /
            {{ data.asset.condition === "faulty" ? "故障" : "正常" }}
          </dd>
        </div>
        <div>
          <dt>当前持有方</dt>
          <dd>{{ holderLabel(data.asset) }}</dd>
        </div>
        <div>
          <dt>当前负责人</dt>
          <dd>{{ data.asset.responsible_name || "不适用" }}</dd>
        </div>
        <div>
          <dt>位置</dt>
          <dd>{{ data.asset.location || "未填写" }}</dd>
        </div>
        <div>
          <dt>领用起始日期</dt>
          <dd>
            {{
              data.asset.holder_party_id
                ? data.asset.started_on || "未知，未补造日期"
                : "不适用"
            }}
          </dd>
        </div>
        <div>
          <dt>预计归还日期</dt>
          <dd>{{ dueLabel(data.asset) }}</dd>
        </div>
        <div>
          <dt>跟进经办人</dt>
          <dd>{{ data.asset.followup_name || "不适用" }}</dd>
        </div>
        <div>
          <dt>备注</dt>
          <dd class="preserve-text">{{ data.asset.note || "未填写" }}</dd>
        </div>
      </dl>
      <AssetConditionForm
        :key="'condition:' + data.asset.id + ':' + data.asset.version"
        :asset="data.asset"
        :earliest-on="conditionEarliestOn"
        @updated="conditionChanged"
      />
      <ExtensionForm
        :key="data.asset.id + ':' + data.asset.version"
        :asset="data.asset"
        @updated="extended"
      />
      <h3>历史记录</h3>
      <ol v-if="data.history.length" class="asset-history">
        <li v-for="event in data.history" :key="event.id">
          <strong>{{
            event.event_type === "asset_initialized"
              ? "登记已有设备"
              : event.event_type === "document_confirmed"
                ? "交接确认"
                : event.event_type === "assignment_extended"
                  ? "临时使用延期"
                  : event.event_type === "asset_fault_reported"
                    ? "登记故障"
                    : event.event_type === "asset_repaired"
                      ? "维修恢复正常"
                      : event.event_type === "document_voided"
                        ? "单据作废恢复"
                        : "设备变更记录"
          }}</strong>
          <p>
            历史日期：{{ event.occurred_on || "未知，未补造日期" }}；记录于
            {{ timestamp(event.recorded_at) }}（东八区）；经办人：{{
              event.actor_label
            }}
          </p>
          <p v-if="event.after_data.holder_name">
            当时持有方：{{ event.after_data.holder_name }}；负责人：{{
              event.after_data.responsible_name
            }}
          </p>
          <p v-if="event.reason">说明：{{ event.reason }}</p>
          <p v-if="event.event_type === 'assignment_extended'">
            原期限：{{ event.after_data.previous_due_on }}；新期限：{{
              event.after_data.due_on
            }}
          </p>
          <RouterLink
            v-if="event.after_data.document_id && account.flowsEnabled"
            :to="'/documents/' + event.after_data.document_id"
            >{{ event.after_data.document_no || "查看交接单" }}</RouterLink
          >
        </li>
      </ol>
      <p v-else>暂无设备事件记录。</p>
      <RouterLink v-if="inventoryWriteAccess" class="button" to="/assets/new"
        >继续登记已有设备</RouterLink
      >
    </template>
  </section>
  <InventoryGate v-else title="设备详情" />
</template>
