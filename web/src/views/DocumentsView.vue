<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { recordPath } from "../references";
import { reactive, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { timestamp } from "../inventory";
import {
  flowAccess,
  flowWriteAccess,
  flowKinds,
  documentStates,
  listDocuments,
  type FlowDocument,
} from "../flows";
import FlowGate from "../components/FlowGate.vue";
import ActionGroup from "../components/ActionGroup.vue";
import DownloadAction from "../components/DownloadAction.vue";
import { originalsZip } from "../original-export";
import ListExport from "../components/ListExport.vue";
import { evidenceAccess } from "../evidence";
import { documentCsv, attachmentCsv } from "../document-export";
import { evidenceStates } from "../evidence-model";
import { evidenceTask, filterEvidenceTask } from "../document-tasks";
import ListResults from "../components/ListResults.vue";
import DataTable from "../components/DataTable.vue";
import type { TableColumn } from "../table";
const columns: TableColumn<FlowDocument>[] = [
  { key: "document_no", label: "单号 / 类型" },
  { key: "status", label: "状态" },
  { key: "handover_on", label: "交接日期 / 双方" },
  { key: "item_count", label: "设备数", value: (row) => row.item_count ?? 0 },
  {
    key: "created_at",
    label: "记录时间",
    value: (row) => timestamp(row.created_at),
  },
];
const props = defineProps<{ manage?: boolean }>();
const route = useRoute();
const filters = reactive({
  search: "",
  kind: "",
  state: props.manage ? "draft" : "",
  evidence: evidenceTask(route.query.evidence),
});
watch(
  [() => props.manage, () => route.query.evidence],
  () => {
    if (route.path !== (props.manage ? "/flows" : "/documents")) return;
    filters.evidence = evidenceTask(route.query.evidence);
    filters.state = filters.evidence
      ? "confirmed"
      : props.manage
        ? "draft"
        : "";
  },
  { immediate: true, flush: "sync" },
);
watch(
  () => filters.evidence,
  (value) => {
    filters.state = value ? "confirmed" : props.manage ? "draft" : "";
  },
  { flush: "sync" },
);
const query = async () => {
  const task = filters.evidence;
  const documents = await listDocuments({
    search: filters.search,
    kind: filters.kind || null,
    state: filters.state || null,
  });
  return filterEvidenceTask(documents, task);
};
const { data, loading, error, load } = useAuthorizedQuery(
  flowAccess,
  query,
  [() => props.manage, () => filters.evidence],
  "documents",
);
</script>
<template>
  <section v-if="flowAccess" class="card">
    <div class="section-heading">
      <div>
        <p class="eyebrow">
          {{ manage ? "交接单据开立与草稿" : "正式单据与凭证核对" }}
        </p>
        <h1>{{ manage ? "流转办理" : "单据记录" }}</h1>
      </div>
      <ActionGroup v-if="flowWriteAccess" class="links page-actions">
        <RouterLink
          v-for="(label, kind) in flowKinds"
          :key="kind"
          class="button quiet"
          :to="'/documents/new?kind=' + kind"
          >新建{{ label }}单</RouterLink
        >
      </ActionGroup>
    </div>
    <ActionGroup class="links segmented-tabs"
      ><RouterLink
        :class="{ 'is-active-tab': filters.evidence === 'awaiting_upload' }"
        to="/documents?evidence=awaiting_upload"
        >待回传签字件</RouterLink
      ><RouterLink
        :class="{ 'is-active-tab': filters.evidence === 'awaiting_review' }"
        to="/documents?evidence=awaiting_review"
        >待核对签字件</RouterLink
      ><RouterLink
        :class="{ 'is-active-tab': !filters.evidence && !manage }"
        to="/documents"
        >全部单据</RouterLink
      ></ActionGroup
    >
    <p class="hint">
      草稿不占库存；请在实际交接时确认。打印和签字件回传不改变设备去向。
    </p>
    <form class="flow-filters" @submit.prevent="load">
      <FormField
        label="搜索单据"
        v-model="filters.search"
        maxlength="120"
        placeholder="单号、双方或移交接收人"
      />
      <FormField
        label="单据类型"
        v-model="filters.kind"
        :options="flowKinds"
        empty-label="全部类型"
      />
      <FormField
        label="签字件状态"
        v-model="filters.evidence"
        :options="evidenceStates"
        empty-label="全部凭证状态"
      />
      <FormField
        label="单据状态"
        v-model="filters.state"
        :disabled="!!filters.evidence"
        :options="documentStates"
        empty-label="全部状态"
      />
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <p v-if="filters.evidence" class="hint">
      凭证筛选只列有效的已确认单据，草稿和作废单不进入待办。点击单号可查看、上传或核对签字件。
    </p>
    <div class="export-toolbar-grid">
      <DownloadAction
        :allowed="evidenceAccess"
        label="批量下载全部凭证原件"
        description="全部已上传原件，包括历史事件凭证和不采用的原件；不受单据筛选影响，最多 25 MB。"
        :query="originalsZip"
      />
      <ListExport
        :key="'documents-' + !!manage + ':' + filters.evidence"
        :allowed="flowAccess"
        :disabled="loading"
        filename="单据清单"
        label="导出单据 CSV"
        :query="async () => documentCsv(await query())"
      />
      <ListExport
        :key="'attachments-' + !!manage + ':' + filters.evidence"
        :allowed="evidenceAccess"
        :disabled="loading"
        filename="附件关联清单"
        label="导出附件关联 CSV"
        description="按当前单据筛选导出可见附件的关联与核对状态，不含原件。"
        :query="(signal) => attachmentCsv(query, signal)"
      />
    </div>
    <ListResults
      :items="data"
      :loading="loading"
      :error="error"
      loading-text="正在读取单据…"
      label="单据分页"
      empty-text="暂无符合条件的单据。"
      @retry="load"
    >
      <template #default="{ items }"
        ><DataTable :items="items" :columns="columns"
          ><template #document_no="{ row }">
            <div class="doc-primary-cell">
              <RouterLink
                class="doc-title-link"
                :to="recordPath('document', row)"
                >{{
                  row.document_no || row.reference_code || "尚未编号的草稿"
                }}</RouterLink
              >
              <span class="doc-kind-badge" :class="'doc-kind-' + row.kind">{{
                flowKinds[row.kind] || "转交"
              }}</span>
            </div>
          </template>
          <template #status="{ row }">
            <div class="status-stack">
              <span
                class="doc-status-badge"
                :class="'doc-status-' + row.status"
                >{{ documentStates[row.status] }}</span
              ><span
                v-if="row.status === 'confirmed' && row.evidence_state"
                class="hint doc-evidence-badge"
                :class="'doc-evidence-' + row.evidence_state"
                >{{
                  evidenceStates[
                    row.evidence_state as keyof typeof evidenceStates
                  ] || "待核对"
                }}签字件</span
              >
            </div>
          </template>
          <template #handover_on="{ row }">
            <div class="handover-flow-cell">
              <span class="handover-date">{{
                row.handover_on || "未填写"
              }}</span>
              <small class="handover-parties"
                >{{ row.from_label || "未填写" }} →
                {{ row.to_label || "未填写" }}</small
              >
            </div>
          </template></DataTable
        ></template
      >
    </ListResults>
  </section>
  <FlowGate v-else />
</template>
