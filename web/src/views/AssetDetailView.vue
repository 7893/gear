<script setup lang="ts">
import QueryState from "../components/QueryState.vue";
import RecordQr from "../components/RecordQr.vue";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { account } from "../accounts";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { useRouteAccess } from "../useRouteAccess";
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
  assetDetailsChanges,
  lifecycleActions,
  type LifecycleAction,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
import ExtensionForm from "../components/ExtensionForm.vue";
import AssetConditionForm from "../components/AssetConditionForm.vue";
import AssetDetailsForm from "../components/AssetDetailsForm.vue";
import AssetLifecycleForm from "../components/AssetLifecycleForm.vue";
import AssignmentUserForm from "../components/AssignmentUserForm.vue";
import EventEvidencePanel from "../components/EventEvidencePanel.vue";
import LifecycleCorrectionForm from "../components/LifecycleCorrectionForm.vue";
const route = useRoute();
const detailAccess = useRouteAccess(inventoryAccess);
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
        .filter(
          (event) =>
            !(data.value?.history || []).some(
              (r) => r.reverses_event_id === event.id,
            ),
        )
        .filter((event) =>
          [
            "asset_initialized",
            "asset_fault_reported",
            "asset_repaired",
            "asset_lost",
            "asset_scrapped",
            "asset_found",
          ].includes(event.event_type),
        )
        .map((event) => event.occurred_on),
    ]
      .filter((date): date is string => !!date)
      .sort()
      .at(-1) || "",
);
const lifecycleEarliestOn = computed(
  () =>
    [
      conditionEarliestOn.value,
      ...(data.value?.history || [])
        .filter(
          (event) =>
            !(data.value?.history || []).some(
              (r) => r.reverses_event_id === event.id,
            ),
        )
        .filter((event) =>
          ["assignment_extended", "assignment_user_changed"].includes(
            event.event_type,
          ),
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
function lifecycleUpdated(action: LifecycleAction) {
  message.value = lifecycleActions[action] + "已记录，内部编号和历史单据保留。";
  void load();
}
function detailsUpdated() {
  message.value = "设备资料更正已记录，原单快照和持有关系保持不变。";
  void load();
}
function userUpdated() {
  message.value = "具体使用人已记录，团队持有方、负责人、期限和原单快照保持。";
  void load();
}
function lifecycleCorrected() {
  message.value = "误登记处置已撤销，原记录和设备编号保留。";
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
    <QueryState
      :loading="loading"
      :error="error"
      loading-text="正在读取设备…"
      retry-label="重新读取"
      @retry="load"
    />
    <template v-if="data">
      <div class="asset-identity">
        <div>
          <h2>{{ data.asset.asset_code }} · {{ data.asset.name }}</h2>
          <span
            class="asset-status"
            :class="'asset-status-' + data.asset.display_status"
            >{{ assetStates[data.asset.display_status] }}</span
          >
        </div>
        <RecordQr
          v-if="data.asset.reference_code"
          kind="asset"
          :reference="data.asset.reference_code"
        />
      </div>
      <p v-if="data.asset.invalidated_at" class="notice">
        此建账记录已标记无效，保留历史供核对。
      </p>
      <div class="detail-workspace">
        <div class="detail-primary">
          <h3>当前情况</h3>
          <dl class="asset-fields">
            <div>
              <dt>原资产编号</dt>
              <dd :class="{ 'is-empty-meta': !data.asset.legacy_code }">
                {{ data.asset.legacy_code || "未填写" }}
              </dd>
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
              <dd
                :class="{
                  'is-empty-meta': !data.asset.brand && !data.asset.model,
                }"
              >
                {{ data.asset.brand || "品牌未填写" }} /
                {{ data.asset.model || "型号未填写" }}
              </dd>
            </div>
            <div>
              <dt>出厂序列号</dt>
              <dd :class="{ 'is-empty-meta': !data.asset.serial_number }">
                {{ data.asset.serial_number || "未填写" }}
              </dd>
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
              <dd :class="{ 'is-empty-meta': !data.asset.responsible_name }">
                {{ data.asset.responsible_name || "不适用" }}
              </dd>
            </div>
            <div>
              <dt>位置</dt>
              <dd :class="{ 'is-empty-meta': !data.asset.location }">
                {{ data.asset.location || "未填写" }}
              </dd>
            </div>
            <div>
              <dt>具体使用人</dt>
              <dd
                :class="{
                  'is-empty-meta':
                    !data.asset.actual_user_name &&
                    data.asset.holder_kind !== 'person',
                }"
              >
                {{
                  data.asset.actual_user_name ||
                  (data.asset.holder_kind === "person"
                    ? data.asset.holder_name
                    : data.asset.holder_kind === "team"
                      ? "待补录"
                      : "不适用")
                }}
              </dd>
            </div>
            <div>
              <dt>领用起始日期</dt>
              <dd :class="{ 'is-empty-meta': !data.asset.holder_party_id }">
                {{
                  data.asset.holder_party_id
                    ? data.asset.started_on || "未记录"
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
              <dd :class="{ 'is-empty-meta': !data.asset.followup_name }">
                {{ data.asset.followup_name || "不适用" }}
              </dd>
            </div>
            <div class="form-wide">
              <dt>备注</dt>
              <dd
                class="preserve-text"
                :class="{ 'is-empty-meta': !data.asset.note }"
              >
                {{ data.asset.note || "未填写" }}
              </dd>
            </div>
          </dl>
          <div class="detail-operations-grid">
            <AssetDetailsForm
              :key="'details:' + data.asset.id + ':' + data.asset.version"
              :asset="data.asset"
              @updated="detailsUpdated"
            />
            <AssignmentUserForm
              :key="'user:' + data.asset.id + ':' + data.asset.version"
              :asset="data.asset"
              @updated="userUpdated"
            />
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
            <AssetLifecycleForm
              :key="'lifecycle:' + data.asset.id + ':' + data.asset.version"
              :asset="data.asset"
              :earliest-on="lifecycleEarliestOn"
              @updated="lifecycleUpdated"
            />
            <LifecycleCorrectionForm
              :key="'correction:' + data.asset.id + ':' + data.asset.version"
              :asset="data.asset"
              :history="data.history"
              @updated="lifecycleCorrected"
            />
          </div>
        </div>
        <div class="detail-timeline">
          <h3>历史记录</h3>
          <ol v-if="data.history.length" class="asset-history">
            <li v-for="event in data.history" :key="event.id">
              <strong>{{
                event.event_type === "asset_initialized"
                  ? "登记已有设备"
                  : event.event_type === "asset_updated"
                    ? "更正设备资料"
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
                              : event.event_type === "asset_lost"
                                ? "登记遗失"
                                : event.event_type === "asset_scrapped"
                                  ? "登记报废"
                                  : event.event_type === "asset_found"
                                    ? "登记找回"
                                    : event.event_type === "asset_invalidated"
                                      ? "作废误建台账"
                                      : event.event_type ===
                                          "assignment_user_changed"
                                        ? "记录团队具体使用人"
                                        : event.event_type ===
                                            "asset_lifecycle_corrected"
                                          ? "撤销误登记处置"
                                          : event.event_type ===
                                              "attachment_uploaded"
                                            ? "上传事件凭证"
                                            : event.event_type ===
                                                "attachment_reviewed"
                                              ? "核对事件凭证"
                                              : "设备变更记录"
              }}</strong>
              <p>
                历史日期：{{ event.occurred_on || "未记录" }}；记录于
                {{ timestamp(event.recorded_at) }}；经办人：{{
                  event.actor_label
                }}
              </p>
              <p v-if="event.after_data.holder_name">
                当时持有方：{{ event.after_data.holder_name }}；负责人：{{
                  event.after_data.responsible_name
                }}
              </p>
              <p
                v-if="
                  [
                    'asset_lost',
                    'asset_scrapped',
                    'asset_invalidated',
                  ].includes(event.event_type) && event.before_data?.holder_name
                "
              >
                退出前持有方：{{
                  event.before_data.holder_name
                }}；最后负责人：{{
                  event.before_data.responsible_name
                }}；原预计归还日期：{{
                  event.before_data.due_on || "长期使用"
                }}。
              </p>
              <p v-if="event.reverses_event_id">
                已撤销原记录 {{ event.reverses_event_id }}，原记录保留。
              </p>
              <p v-if="event.reason">说明：{{ event.reason }}</p>
              <p v-if="event.event_type === 'assignment_user_changed'">
                具体使用人：{{
                  event.before_data?.actual_user_name || "待补录"
                }}
                →
                {{ event.after_data.actual_user_name || "待补录" }}
              </p>
              <ul v-if="event.event_type === 'asset_updated'">
                <li
                  v-for="change in assetDetailsChanges(event)"
                  :key="change.key"
                  class="preserve-text"
                >
                  {{ change.label }}：{{ change.before }} → {{ change.after }}
                </li>
              </ul>
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
              <EventEvidencePanel
                v-if="
                  [
                    'asset_initialized',
                    'asset_fault_reported',
                    'asset_repaired',
                    'asset_lost',
                    'asset_scrapped',
                    'asset_found',
                    'asset_invalidated',
                    'asset_lifecycle_corrected',
                  ].includes(event.event_type)
                "
                :event-id="event.id"
                :historical="event.event_type === 'asset_initialized'"
              />
            </li>
          </ol>
          <p v-else>暂无设备事件记录。</p>
        </div>
      </div>
      <RouterLink v-if="inventoryWriteAccess" class="button" to="/assets/new"
        >继续登记已有设备</RouterLink
      >
    </template>
  </section>
  <InventoryGate v-else title="设备详情" />
</template>
