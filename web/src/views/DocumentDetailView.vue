<script setup lang="ts">
import QueryState from "../components/QueryState.vue";
import ActionGroup from "../components/ActionGroup.vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import RecordQr from "../components/RecordQr.vue";
import { recordPath } from "../references";
import { account } from "../accounts";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { useAuthorizedAction } from "../useAuthorizedAction";
import { useRouteAccess } from "../useRouteAccess";
import { listAssets, categories, timestamp, type Asset } from "../inventory";
import {
  flowAccess,
  flowWriteAccess,
  flowKinds,
  transferModes,
  documentStates,
  getDocument,
  deleteDocument,
  type DocumentItem,
} from "../flows";
import FlowGate from "../components/FlowGate.vue";
import EvidencePanel from "../components/EvidencePanel.vue";
import DocumentReview from "../components/DocumentReview.vue";
const route = useRoute();
const router = useRouter();
const detailAccess = useRouteAccess(flowAccess);
const {
  data: loaded,
  loading,
  error: readError,
  load: loadDocument,
} = useAuthorizedQuery(
  detailAccess,
  async (isCurrent) => {
    const doc = await getDocument(String(route.params.id));
    if (!isCurrent()) return null;
    const preview =
      doc.status === "draft"
        ? await listAssets({
            search: "",
            category: null,
            state: null,
            holder_kind: null,
          })
        : null;
    return { doc, assets: preview?.items || [] };
  },
  [() => route.params.id],
);
const data = computed(() => loaded.value?.doc || null);
const draftAssets = computed(() => loaded.value?.assets || []);
const deleting = ref(false);
watch(
  [() => data.value?.document_no, () => data.value?.status, flowAccess],
  () => {
    if (data.value && flowAccess.value)
      document.documentElement.style.setProperty(
        "--gear-print-id",
        JSON.stringify(
          "单号：" +
            (data.value.document_no || "草稿 · 尚未编号") +
            (data.value.status === "voided" ? " · 已作废" : ""),
        ),
      );
    else document.documentElement.style.removeProperty("--gear-print-id");
  },
  { flush: "sync" },
);
const canEdit = computed(
  () =>
    flowWriteAccess.value &&
    data.value?.status === "draft" &&
    (account.profile?.membership?.role === "admin" ||
      data.value.created_by === account.profile?.membership?.id),
);
const {
  busy,
  error: actionError,
  run,
} = useAuthorizedAction(
  canEdit,
  [() => route.params.id],
  () => (deleting.value = false),
);
const error = computed(() => actionError.value || readError.value);
const parties = computed(() => data.value?.parties_snapshot || data.value);
const snapshotComplete = computed(
  () =>
    data.value &&
    (data.value.status === "draft" ||
      data.value.items.every((i) => i.asset_snapshot)),
);
function asset(item: DocumentItem): Partial<Asset> {
  return (
    item.asset_snapshot ||
    draftAssets.value.find((a) => a.id === item.asset_id) ||
    item.new_asset_data ||
    {}
  );
}
function load() {
  deleting.value = false;
  actionError.value = "";
  return loadDocument();
}
onBeforeUnmount(() =>
  document.documentElement.style.removeProperty("--gear-print-id"),
);
function print() {
  if (flowAccess.value && snapshotComplete.value && !error.value)
    window.print();
}
async function remove() {
  if (!data.value || !deleting.value) return;
  const current = data.value;
  await run(
    { id: current.id, version: current.version, action: "delete" },
    (id) => deleteDocument(current, id),
    async () => {
      await router.push("/flows");
    },
  );
}
</script>
<template>
  <section v-if="flowAccess" class="card document-detail">
    <div class="print-controls">
      <div class="detail-top-bar">
        <RouterLink to="/documents" class="back-link">返回单据记录</RouterLink>
        <span
          v-if="data"
          class="doc-status-badge"
          :class="'doc-status-' + data.status"
        >
          {{ documentStates[data.status] }}
        </span>
      </div>
      <div class="section-header-row">
        <div>
          <p class="eyebrow">HANDOVER VOUCHER</p>
          <h1 class="refresh">单据详情</h1>
        </div>
        <ActionGroup v-if="data" class="links">
          <button
            type="button"
            :disabled="busy || !snapshotComplete || !!error"
            @click="print"
          >
            打印单据 / 另存 PDF
          </button>
          <RouterLink
            v-if="canEdit"
            class="button"
            :to="recordPath('document', data) + '/edit'"
            >继续编辑草稿</RouterLink
          >
          <button
            v-if="canEdit"
            type="button"
            class="quiet danger"
            :disabled="busy"
            @click="deleting = true"
          >
            删除草稿
          </button>
        </ActionGroup>
      </div>
      <QueryState
        :loading="loading"
        :error="error"
        loading-text="正在读取单据…"
        retry-label="重新读取"
        @retry="load"
      />
      <template v-if="data">
        <div class="voucher-status-strip">
          <p class="voucher-state-summary">
            状态：{{ documentStates[data.status] }}；{{
              data.evidence_state === "awaiting_upload"
                ? "待回传签字件"
                : data.evidence_state === "archived"
                  ? "已归档"
                  : data.evidence_state === "awaiting_review"
                    ? "待核对签字件"
                    : data.status === "draft"
                      ? "尚未实际交接"
                      : "凭证待核对"
            }}。
          </p>
          <p class="hint">
            打印或另存 PDF 不会再次办理交接。默认 A4 横向。建议使用桌面 Chrome
            或 Edge；关闭浏览器自带页眉页脚，页码由单据提供。
          </p>
        </div>
        <div v-if="deleting" class="notice">
          <p>确认删除此草稿？审计记录会保留。</p>
          <ActionGroup>
            <button type="button" :disabled="busy" @click="remove">
              确认删除草稿
            </button>
            <button
              type="button"
              class="quiet"
              :disabled="busy"
              @click="deleting = false"
            >
              保留草稿
            </button>
          </ActionGroup>
        </div>
        <p v-if="!snapshotComplete" class="notice error" role="alert">
          单据快照不完整，暂不能打印，请联系管理员。
        </p>
      </template>
    </div>
    <div v-if="data && data.status !== 'draft'" class="document-panels-grid">
      <DocumentReview
        :key="data.id + ':' + data.version"
        :document="data"
        @changed="load"
      />
      <EvidencePanel :document="data" @changed="load" />
    </div>
    <article
      v-if="data && snapshotComplete"
      class="print-sheet"
      aria-label="交接单据"
    >
      <header class="sheet-header document-heading">
        <div class="sheet-title-block">
          <p class="sheet-org-title">
            {{ data.header_snapshot?.title || "设备簿" }}
          </p>
          <div class="sheet-title-line">
            <h2>{{ flowKinds[data.kind] || "转交" }}单</h2>
            <strong v-if="data.status === 'voided'" class="document-watermark"
              >已作废</strong
            ><strong
              v-else-if="data.status === 'draft'"
              class="document-watermark"
              >草稿 · 不作为正式交接凭证</strong
            >
          </div>
          <p class="document-number">
            {{ data.document_no || "草稿 · 尚未编号" }}
          </p>
        </div>
        <RecordQr
          v-if="data.status !== 'draft' && data.document_no"
          kind="document"
          :reference="data.document_no"
        />
      </header>

      <section class="sheet-parties print-parties" aria-label="交接双方信息">
        <div class="sheet-flow-cards">
          <div class="sheet-party-card">
            <span class="sheet-party-role">交出方</span>
            <p class="sheet-party-main">
              交出方：{{
                parties?.from_label ||
                (data.from_kind === "inventory" ? "经办人库存" : "未填写")
              }}；接收方：{{
                parties?.to_label ||
                (data.to_kind === "inventory" ? "经办人库存" : "未填写")
              }}
            </p>
            <p class="sheet-party-sub">
              实际移交人：{{ parties?.sender_name || "未填写" }}；实际接收人：{{
                parties?.receiver_name || "未填写"
              }}
            </p>
            <p
              v-if="
                data.parties_snapshot?.from_responsible_name ||
                data.parties_snapshot?.to_responsible_name
              "
              class="sheet-party-sub"
            >
              交出负责人：{{
                data.parties_snapshot.from_responsible_name || "不适用"
              }}；接收负责人：{{
                data.parties_snapshot.to_responsible_name || "不适用"
              }}
            </p>
          </div>
          <div class="sheet-meta-card">
            <p>实际交接日期：{{ data.handover_on || "未填写" }}</p>
            <p v-if="data.kind === 'transfer'">
              转交方式：{{ transferModes[data.transfer_mode || "holder"] }}
            </p>
            <p v-if="data.usage_kind">
              使用方式：{{ data.usage_kind === "temporary" ? "临时" : "长期"
              }}<span v-if="data.due_on"
                >；预计归还日期：{{ data.due_on }}</span
              >
            </p>
          </div>
        </div>
      </section>

      <section class="sheet-items" role="table" aria-label="交接设备明细">
        <div class="sheet-items-header" role="rowgroup">
          <div class="sheet-item-row is-header" role="row">
            <div class="sheet-cell" role="columnheader">序号</div>
            <div class="sheet-cell" role="columnheader">内部 / 原编号</div>
            <div class="sheet-cell" role="columnheader">设备名称 / 分类</div>
            <div class="sheet-cell" role="columnheader">品牌型号 / 序列号</div>
            <div class="sheet-cell" role="columnheader">数量</div>
            <div class="sheet-cell" role="columnheader">交接状况</div>
            <div class="sheet-cell" role="columnheader">交接后位置</div>
            <div class="sheet-cell" role="columnheader">备注 / 说明</div>
          </div>
        </div>
        <div class="sheet-items-body" role="rowgroup">
          <article
            v-for="(item, index) in data.items"
            :key="item.id"
            class="sheet-item-row"
            role="row"
          >
            <div class="sheet-cell is-index" role="cell" data-label="序号">
              {{ index + 1 }}
            </div>
            <div class="sheet-cell" role="cell" data-label="内部 / 原编号">
              <strong class="sheet-code">{{
                asset(item).reference_code ||
                asset(item).asset_code ||
                "确认后生成"
              }}</strong>
              <span
                class="sheet-sub"
                :class="{ 'is-empty-meta': !asset(item).legacy_code }"
                >{{ asset(item).legacy_code || "无原编号" }}</span
              >
            </div>
            <div class="sheet-cell" role="cell" data-label="设备名称 / 分类">
              <strong>{{ asset(item).name || "未填写" }}</strong>
              <span class="sheet-sub">{{
                categories[asset(item).category as keyof typeof categories] ||
                asset(item).category ||
                "未填写"
              }}</span>
            </div>
            <div class="sheet-cell" role="cell" data-label="品牌型号 / 序列号">
              <span
                :class="{
                  'is-empty-meta': !asset(item).brand && !asset(item).model,
                }"
              >
                {{ asset(item).brand || "未填写品牌" }} /
                {{ asset(item).model || "未填写型号" }}
              </span>
              <span
                class="sheet-sub"
                :class="{ 'is-empty-meta': !asset(item).serial_number }"
                >{{ asset(item).serial_number || "无序列号" }}</span
              >
            </div>
            <div class="sheet-cell" role="cell" data-label="数量">1</div>
            <div class="sheet-cell" role="cell" data-label="交接状况">
              <span
                class="condition-pill"
                :class="
                  'condition-' + (item.condition_on_handover || 'pending')
                "
              >
                {{
                  item.condition_on_handover === "normal"
                    ? "正常"
                    : item.condition_on_handover === "faulty"
                      ? "故障"
                      : "未核对"
                }}
              </span>
            </div>
            <div
              class="sheet-cell"
              :class="{ 'is-empty-meta': !item.location }"
              role="cell"
              data-label="交接后位置"
            >
              {{ item.location || "未填写" }}
            </div>
            <div class="sheet-cell" role="cell" data-label="备注 / 说明">
              <p
                v-if="
                  data.kind === 'transfer' &&
                  data.transfer_mode === 'responsibility'
                "
              >
                原起始日期：{{ asset(item).started_on || "未知" }}；{{
                  asset(item).usage_kind === "temporary"
                    ? "保留预计归还日期：" + asset(item).due_on
                    : "长期使用，原期限不变"
                }}
              </p>
              <p v-if="asset(item).note">设备：{{ asset(item).note }}</p>
              <p v-if="item.note">交接：{{ item.note }}</p>
              <span
                v-if="
                  !item.note &&
                  !asset(item).note &&
                  data.transfer_mode !== 'responsibility'
                "
                class="is-empty-meta"
                >—</span
              >
            </div>
          </article>
        </div>
      </section>

      <footer class="sheet-footer">
        <p class="sheet-footer-no">
          单号：{{ data.document_no || "草稿 · 尚未编号"
          }}<span v-if="data.status === 'voided'"> · 已作废</span
          ><span v-if="data.status === 'draft'"> · 草稿</span>
        </p>
      </footer>

      <div class="print-summary">
        <p>合计：{{ data.items.length }} 件设备。</p>
        <p v-if="data.remarks" class="preserve-text">
          {{ data.kind === "return" ? "退回原因" : "用途或备注" }}：{{
            data.remarks
          }}
        </p>
        <p v-if="data.void_reason">作废原因：{{ data.void_reason }}</p>
      </div>
      <div class="print-signatures">
        <p>移交人签字：________________<br />日期：______年____月____日</p>
        <p>接收人签字：________________<br />日期：______年____月____日</p>
      </div>
      <p class="print-record" v-if="data.confirmed_at">
        <span v-if="data.header_snapshot?.operator_name"
          >经办人：{{ data.header_snapshot.operator_name }}；</span
        >
        系统确认时间：{{ timestamp(data.confirmed_at) }}。
      </p>
    </article>
  </section>
  <FlowGate v-else title="单据详情" />
</template>
