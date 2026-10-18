<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import qrcode from "qrcode-generator";
import { account, safeError } from "../accounts";
import {
  listAssets,
  categories,
  timestamp,
  requestFor,
  type Asset,
} from "../inventory";
import {
  flowAccess,
  flowWriteAccess,
  flowKinds,
  documentStates,
  getDocument,
  deleteDocument,
  type FlowDocument,
  type DocumentItem,
} from "../flows";
import FlowGate from "../components/FlowGate.vue";
import EvidencePanel from "../components/EvidencePanel.vue";
const route = useRoute();
const router = useRouter();
const data = ref<FlowDocument | null>(null);
const draftAssets = ref<Asset[]>([]);
const error = ref("");
const loading = ref(false);
const busy = ref(false);
const deleting = ref(false);
const requests = new Map<string, string>();
let generation = 0;
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
const qr = computed(() => {
  if (!data.value || data.value.status === "draft") return null;
  const code = qrcode(0, "M");
  code.addData("gear:document:" + data.value.id);
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row++)
    for (let column = 0; column < count; column++) {
      if (code.isDark(row, column)) path += `M${column + 4},${row + 4}h1v1h-1z`;
    }
  return { path, size: count + 8 };
});
const canEdit = computed(
  () =>
    flowWriteAccess.value &&
    data.value?.status === "draft" &&
    (account.profile?.membership?.role === "admin" ||
      data.value.created_by === account.profile?.membership?.id),
);
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
async function load() {
  const current = ++generation;
  data.value = null;
  draftAssets.value = [];
  error.value = "";
  deleting.value = false;
  if (!flowAccess.value) return;
  loading.value = true;
  try {
    const doc = await getDocument(String(route.params.id));
    const preview =
      doc.status === "draft"
        ? await listAssets({
            search: "",
            category: null,
            state: null,
            holder_kind: null,
          })
        : null;
    if (current === generation && flowAccess.value) {
      data.value = doc;
      draftAssets.value = preview?.items || [];
    }
  } catch (failure) {
    if (current === generation && flowAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  [
    flowAccess,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
    () => route.params.id,
  ],
  () => {
    if (flowAccess.value) void load();
    else {
      generation++;
      data.value = null;
      draftAssets.value = [];
      error.value = "";
      deleting.value = false;
      loading.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  document.documentElement.style.removeProperty("--gear-print-id");
});
function print() {
  if (flowAccess.value && snapshotComplete.value && !error.value)
    window.print();
}
async function remove() {
  if (!data.value || !canEdit.value || busy.value || !deleting.value) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    await deleteDocument(
      data.value,
      requestFor(requests, {
        id: data.value.id,
        version: data.value.version,
        action: "delete",
      }),
    );
    if (current === generation && flowWriteAccess.value)
      await router.push("/flows");
  } catch (failure) {
    if (current === generation && flowAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section v-if="flowAccess" class="card document-detail">
    <div class="print-controls">
      <RouterLink to="/documents">返回单据记录</RouterLink>
      <h1 class="refresh">单据详情</h1>
      <p v-if="loading" role="status">正在读取单据…</p>
      <div v-if="error" class="notice error" role="alert">
        {{ error }} <button class="quiet" @click="load">重新读取</button>
      </div>
      <template v-if="data"
        ><p>
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
          打印或另存 PDF 不会再次办理交接。建议使用桌面 Chrome 或
          Edge；关闭浏览器自带页眉页脚，页码由单据提供。
        </p>
        <div class="links">
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
            :to="'/documents/' + data.id + '/edit'"
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
        </div>
        <div v-if="deleting" class="notice">
          <p>确认删除此草稿？审计记录会保留。</p>
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
        </div>
        <p v-if="!snapshotComplete" class="notice error" role="alert">
          单据快照不完整，暂不能打印，请联系管理员。
        </p>
      </template>
    </div>
    <EvidencePanel
      v-if="data && data.status !== 'draft'"
      :document="data"
      @changed="load"
    />
    <article
      v-if="data && snapshotComplete"
      class="print-sheet"
      aria-label="交接单据"
    >
      <table class="print-table">
        <colgroup>
          <col v-for="index in 8" :key="index" />
        </colgroup>
        <thead>
          <tr>
            <th colspan="8">
              <div class="document-heading">
                <div>
                  <p>{{ data.header_snapshot?.title || "设备簿" }}</p>
                  <h2>{{ flowKinds[data.kind] || "转交" }}单</h2>
                  <p class="document-number">
                    {{ data.document_no || "草稿 · 尚未编号" }}
                  </p>
                  <strong
                    v-if="data.status === 'voided'"
                    class="document-watermark"
                    >已作废</strong
                  ><strong
                    v-else-if="data.status === 'draft'"
                    class="document-watermark"
                    >草稿 · 不作为正式交接凭证</strong
                  >
                </div>
                <svg
                  v-if="qr"
                  :viewBox="`0 0 ${qr.size} ${qr.size}`"
                  width="84"
                  height="84"
                  role="img"
                  aria-label="单据匹配二维码"
                  shape-rendering="crispEdges"
                >
                  <rect :width="qr.size" :height="qr.size" fill="#fff" />
                  <path :d="qr.path" fill="#000" />
                </svg>
              </div>
            </th>
          </tr>
          <tr>
            <th colspan="8" class="print-parties">
              <p>实际交接日期：{{ data.handover_on || "未填写" }}</p>
              <p>
                交出方：{{
                  parties?.from_label ||
                  (data.from_kind === "inventory" ? "经办人库存" : "未填写")
                }}；接收方：{{
                  parties?.to_label ||
                  (data.to_kind === "inventory" ? "经办人库存" : "未填写")
                }}
              </p>
              <p>
                实际移交人：{{
                  parties?.sender_name || "未填写"
                }}；实际接收人：{{ parties?.receiver_name || "未填写" }}
              </p>
              <p
                v-if="
                  data.parties_snapshot?.from_responsible_name ||
                  data.parties_snapshot?.to_responsible_name
                "
              >
                交出负责人：{{
                  data.parties_snapshot.from_responsible_name || "不适用"
                }}；接收负责人：{{
                  data.parties_snapshot.to_responsible_name || "不适用"
                }}
              </p>
              <p v-if="data.usage_kind">
                使用方式：{{ data.usage_kind === "temporary" ? "临时" : "长期"
                }}<span v-if="data.due_on"
                  >；预计归还日期：{{ data.due_on }}</span
                >
              </p>
            </th>
          </tr>
          <tr>
            <th>序号</th>
            <th>内部 / 原编号</th>
            <th>设备名称 / 分类</th>
            <th>品牌型号 / 序列号</th>
            <th>数量</th>
            <th>交接状况</th>
            <th>交接后位置</th>
            <th>备注 / 说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in data.items" :key="item.id">
            <td>{{ index + 1 }}</td>
            <td>
              {{ asset(item).asset_code || "确认后生成" }}<br />{{
                asset(item).legacy_code || "无原编号"
              }}
            </td>
            <td>
              {{ asset(item).name || "未填写" }}<br />{{
                categories[asset(item).category as keyof typeof categories] ||
                asset(item).category ||
                "未填写"
              }}
            </td>
            <td>
              {{ asset(item).brand || "未填写品牌" }} /
              {{ asset(item).model || "未填写型号" }}<br />{{
                asset(item).serial_number || "无序列号"
              }}
            </td>
            <td>1</td>
            <td>
              {{
                item.condition_on_handover === "normal"
                  ? "正常"
                  : item.condition_on_handover === "faulty"
                    ? "故障"
                    : "未核对"
              }}
            </td>
            <td>{{ item.location || "未填写" }}</td>
            <td>
              <p v-if="asset(item).note">设备：{{ asset(item).note }}</p>
              <p v-if="item.note">交接：{{ item.note }}</p>
              <span v-if="!item.note && !asset(item).note">—</span>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="8">
              单号：{{ data.document_no || "草稿 · 尚未编号"
              }}<span v-if="data.status === 'voided'"> · 已作废</span
              ><span v-if="data.status === 'draft'"> · 草稿</span>
            </td>
          </tr>
        </tfoot>
      </table>
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
        系统确认时间：{{ timestamp(data.confirmed_at) }}（东八区）。
      </p>
    </article>
  </section>
  <FlowGate v-else title="单据详情" />
</template>
