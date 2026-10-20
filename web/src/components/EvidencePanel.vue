<script setup lang="ts">
import QueryState from "./QueryState.vue";
import FormField from "./FormField.vue";
import { computed, ref, watch } from "vue";
import { account } from "../accounts";
import { timestamp } from "../inventory";
import { listDocuments, type FlowDocument } from "../flows";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import {
  useAuthorizedAction,
  type AuthorizedOperation,
} from "../useAuthorizedAction";
import { downloadBlob } from "../download";
import ActionGroup from "./ActionGroup.vue";
import {
  evidenceAccess,
  evidenceWrite,
  listEvidence,
  matchEvidence,
  uploadEvidence,
  downloadEvidence,
  updateEvidence,
  cancelEvidence,
  archiveEvidence,
  emptyHints,
  evidenceStates,
  type Attachment,
  type EvidenceHints,
  type Candidate,
} from "../evidence";
const props = defineProps<{ document: FlowDocument }>();
const emit = defineEmits<{ changed: [] }>();
const {
  data: records,
  loading,
  error: readError,
  refresh,
} = useAuthorizedQuery(evidenceAccess, () => listEvidence(props.document.id), [
  () => props.document.id,
]);
const message = ref("");
const selected = ref<File | null>(null),
  recognition = ref<EvidenceHints>(emptyHints()),
  candidates = ref<Candidate[]>([]),
  progress = ref("");
const source = ref("internal"),
  reference = ref(""),
  uploadReason = ref(""),
  associationConfirmed = ref(false);
const checks = ref({
    signatures: false,
    number: false,
    content: false,
    pages: false,
  }),
  manualReason = ref("");
const preview = ref<{
  item: Attachment;
  blob: Blob;
  url: string;
  page: number;
  pages: number;
} | null>(null);
const editing = ref<Attachment | null>(null),
  target = ref(""),
  active = ref(true),
  correctionReference = ref(""),
  reason = ref("");
const targets = ref<FlowDocument[]>([]);
const {
  busy,
  error: actionError,
  run,
  requestId,
} = useAuthorizedAction(evidenceAccess, [() => props.document.id], resetForm);
const error = computed(() => actionError.value || readError.value);
// An uncertain upload must retain its original version as well as its nonce.
let attempt: { signature: string; version: number; id: string } | null = null;
const writable = computed(
  () => evidenceWrite.value && props.document.status === "confirmed",
);
const canEdit = computed(
  () =>
    writable.value &&
    (records.value?.evidence_state !== "archived" ||
      account.profile?.membership?.role === "admin"),
);
const activeFiles = computed(
  () =>
    records.value?.items.filter(
      (a) => a.upload_state === "ready" && a.is_active,
    ) || [],
);
const pendingFiles = computed(
  () =>
    records.value?.items.filter(
      (a) => a.upload_state === "pending" && a.is_active,
    ) || [],
);
const manualRequired = computed(() =>
  activeFiles.value.some((a) => {
    const h = a.ocr_result || emptyHints();
    return (
      !(
        h.document_ids.includes(props.document.id) ||
        h.document_numbers.includes(props.document.document_no || "")
      ) ||
      h.document_ids.some((id) => id !== props.document.id) ||
      h.document_numbers.some((n) => n !== props.document.document_no)
    );
  }),
);
function closePreview() {
  if (preview.value) URL.revokeObjectURL(preview.value.url);
  preview.value = null;
}
function resetForm() {
  selected.value = null;
  recognition.value = emptyHints();
  candidates.value = [];
  message.value = "";
  progress.value = "";
  checks.value = {
    signatures: false,
    number: false,
    content: false,
    pages: false,
  };
  manualReason.value = "";
  source.value = "internal";
  reference.value = "";
  uploadReason.value = "";
  associationConfirmed.value = false;
  attempt = null;
  editing.value = null;
  targets.value = [];
  reason.value = "";
  closePreview();
}
watch(
  records,
  () => {
    checks.value = {
      signatures: false,
      number: false,
      content: false,
      pages: false,
    };
  },
  { flush: "sync" },
);
function reload() {
  actionError.value = "";
  return refresh();
}
function perform(
  payload: unknown,
  action: AuthorizedOperation<void>,
  onFailure?: (failure: unknown) => void,
) {
  if (!evidenceAccess.value || busy.value) return;
  message.value = "";
  return run(payload, action, undefined, onFailure);
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !canEdit.value || busy.value) return;
  selected.value = file;
  recognition.value = emptyHints();
  candidates.value = [];
  associationConfirmed.value = false;
  attempt = null;
  progress.value = "正在读取文件…";
  await perform(
    { action: "choose" },
    async (_, signal, isCurrent) => {
      const engine = await import("../evidence-recognition");
      const result = await engine.recognizeEvidence(file, signal, (s) => {
        if (isCurrent()) progress.value = s;
      });
      if (!isCurrent() || !canEdit.value) return;
      recognition.value = result.hints;
      progress.value = `共 ${result.pages} 页；${result.hints.document_ids.length + result.hints.document_numbers.length ? "已找到编号线索，请核对候选。" : "未识别到编号，可上传后人工关联和核对。"}`;
      const matched = await matchEvidence(result.hints);
      if (isCurrent() && canEdit.value) candidates.value = matched;
    },
    (failure) => {
      const code = failure instanceof Error ? failure.message : "";
      if (
        [
          "evidence_file_too_large",
          "unsupported_evidence_file",
          "invalid_or_encrypted_pdf",
          "pdf_page_limit_exceeded",
          "image_dimensions_exceeded",
          "invalid_evidence_file",
        ].includes(code)
      )
        selected.value = null;
      else
        progress.value = "识别或匹配未完成，可以重试识别，或上传后人工核对。";
    },
  );
}
async function upload() {
  if (
    !selected.value ||
    !records.value ||
    !canEdit.value ||
    !associationConfirmed.value
  )
    return;
  const file = selected.value;
  const signature = JSON.stringify([
    file.name,
    file.size,
    file.lastModified,
    source.value,
    reference.value,
    uploadReason.value,
    recognition.value,
  ]);
  if (!attempt || attempt.signature !== signature)
    attempt = {
      signature,
      version: records.value.document_version,
      id: crypto.randomUUID(),
    };
  const frozen = attempt;
  await perform(
    { action: "upload", id: frozen.id },
    async (_, signal, isCurrent) => {
      await uploadEvidence(
        file,
        props.document.id,
        frozen.version,
        frozen.id,
        recognition.value,
        source.value,
        reference.value,
        uploadReason.value,
        signal,
      );
      if (!isCurrent()) return;
      selected.value = null;
      attempt = null;
      message.value = "原件已保存，待人工核对；尚未归档。";
      await reload();
      if (isCurrent()) emit("changed");
    },
  );
}
async function show(item: Attachment, page = 1) {
  await perform(
    { action: "preview", id: item.id, page },
    async (_, signal, isCurrent) => {
      const blob =
        preview.value?.item.id === item.id
          ? preview.value.blob
          : await downloadEvidence(item.id, signal);
      if (!isCurrent()) return;
      const engine = await import("../evidence-recognition");
      const rendered = await engine.previewPage(
        blob,
        item.media_type!,
        page,
        signal,
      );
      if (!isCurrent()) {
        URL.revokeObjectURL(rendered.url);
        return;
      }
      closePreview();
      preview.value = {
        item,
        blob,
        url: rendered.url,
        page,
        pages: rendered.pages,
      };
    },
  );
}
async function download(item: Attachment) {
  await perform(
    { action: "download", id: item.id },
    async (_, signal, isCurrent) => {
      const blob = await downloadEvidence(item.id, signal);
      if (isCurrent()) downloadBlob(blob, item.original_name);
    },
  );
}
async function cancel(item: Attachment) {
  if (!writable.value) return;
  await perform(
    { action: "cancel", id: item.id, version: item.version },
    async (id, _, isCurrent) => {
      await cancelEvidence(item, id);
      if (isCurrent()) await reload();
    },
  );
}
async function startEdit(item: Attachment) {
  if (!canEdit.value) return;
  await perform({ action: "edit", id: item.id }, async (_, __, isCurrent) => {
    const list = await listDocuments({
      search: "",
      kind: null,
      state: "confirmed",
    });
    if (!isCurrent() || !canEdit.value) return;
    targets.value = list;
    editing.value = item;
    target.value = item.document_id || "";
    active.value = item.is_active;
    correctionReference.value = item.external_reference || "";
    reason.value = "";
  });
}
async function correct() {
  if (!editing.value || !canEdit.value || !reason.value.trim()) return;
  const item = editing.value;
  const changes = {
    document_id: target.value,
    is_active: active.value,
    external_reference: correctionReference.value || null,
    reason: reason.value.trim(),
  };
  await perform(
    { action: "correct", id: item.id, version: item.version, changes },
    async (id, _, isCurrent) => {
      await updateEvidence(item, changes, id);
      if (!isCurrent()) return;
      editing.value = null;
      await reload();
      if (isCurrent()) emit("changed");
    },
  );
}
async function retryRecognition(item: Attachment) {
  if (!canEdit.value || records.value?.evidence_state === "archived") return;
  await perform(
    { action: "recognize", id: item.id },
    async (_, signal, isCurrent) => {
      const blob = await downloadEvidence(item.id, signal);
      if (!isCurrent()) return;
      const engine = await import("../evidence-recognition");
      const result = await engine.recognizeEvidence(
        new File([blob], item.original_name, { type: item.media_type! }),
        signal,
      );
      if (!isCurrent() || !canEdit.value) return;
      const changes = {
        recognition: result.hints,
        reason: "重新识别单据编号，仍需人工核对",
      };
      await updateEvidence(
        item,
        changes,
        requestId({
          action: "recognize-result",
          id: item.id,
          version: item.version,
          changes,
        }),
      );
      if (!isCurrent()) return;
      await reload();
      if (isCurrent()) emit("changed");
    },
  );
}
async function archive() {
  if (
    !records.value ||
    !writable.value ||
    records.value.evidence_state === "archived" ||
    pendingFiles.value.length ||
    !activeFiles.value.length ||
    !Object.values(checks.value).every(Boolean) ||
    (manualRequired.value && !manualReason.value.trim())
  )
    return;
  const payload = [
    props.document.id,
    records.value.document_version,
    activeFiles.value.map((a) => a.id),
    checks.value,
    manualReason.value.trim(),
  ] as const;
  await perform({ action: "archive", payload }, async (id, _, isCurrent) => {
    await archiveEvidence(...payload, id);
    if (!isCurrent()) return;
    message.value = "已人工核对归档。";
    await reload();
    if (isCurrent()) emit("changed");
  });
}
</script>
<template>
  <section
    v-if="evidenceAccess"
    class="evidence-panel print-controls"
    aria-label="签字件与归档"
  >
    <h2>签字件与归档</h2>
    <p>上传只进入待核对。识别二维码及 PDF 单号；签字、内容和页数由人核对。</p>
    <p v-if="document.status === 'voided'" class="notice">
      单据已作废，原件仅供追溯。
    </p>
    <QueryState
      :loading="loading"
      :error="error"
      loading-text="正在读取附件…"
      retry-label=""
    />
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <button
      type="button"
      class="quiet"
      :disabled="busy || loading"
      @click="reload"
    >
      刷新附件状态
    </button>
    <template v-if="records">
      <p>
        凭证状态：{{ evidenceStates[records.evidence_state] }}；有效原件
        {{ activeFiles.length }} 个。
      </p>
      <div v-if="canEdit" class="evidence-upload">
        <h3>上传签字原件</h3>
        <p class="hint">
          支持 JPEG、PNG、PDF。单件 20 MiB、每单最多 10 个有效附件和 100
          MiB、PDF 最多 20 页；多张照片可逐张追加。
        </p>
        <label
          >选择签字件<input
            type="file"
            accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
            :disabled="busy"
            @change="choose"
        /></label>
        <p v-if="selected">待上传原件：{{ selected.name }}</p>
        <p v-if="progress" role="status">{{ progress }}</p>
        <ul v-if="candidates.length">
          <li v-for="candidate in candidates" :key="candidate.id">
            识别候选：<RouterLink :to="'/documents/' + candidate.id">{{
              candidate.document_no
            }}</RouterLink
            >（{{
              candidate.id === document.id
                ? "当前单据"
                : "其他单据，请核对关联"
            }}）
          </li>
        </ul>
        <p v-else-if="selected">
          没有匹配候选，仍可上传到当前单据后人工核对；关联有误可更正。
        </p>
        <FormField
          label="凭证来源"
          v-model="source"
          :disabled="busy"
          :options="{ internal: '本系统交接单', external: '交付方原单' }"
          v-if="document.kind === 'receipt'"
        />
        <FormField
          label="外部单号"
          v-model="reference"
          maxlength="120"
          :disabled="busy"
          v-if="source === 'external'"
        />
        <FormField
          label="补充或更正原因"
          v-model="uploadReason"
          maxlength="1000"
          :disabled="busy"
          type="textarea"
          v-if="records.evidence_state === 'archived'"
        />
        <label v-if="selected" class="checkbox-row"
          ><input
            v-model="associationConfirmed"
            type="checkbox"
            :disabled="busy"
          />我已核对，本次原件关联当前单据 {{ document.document_no }}</label
        >
        <button
          type="button"
          :disabled="
            busy ||
            !selected ||
            !associationConfirmed ||
            (source === 'external' && !reference.trim()) ||
            (records.evidence_state === 'archived' && !uploadReason.trim())
          "
          @click="upload"
        >
          {{ busy ? "正在处理…" : "上传原件，进入待核对" }}
        </button>
      </div>
      <p v-else-if="writable && records.evidence_state === 'archived'">
        已归档凭证如需补充或纠正，请管理员填写原因处理。
      </p>
      <p v-if="!records.items.length && !loading">尚无附件。</p>
      <ul class="evidence-files">
        <li v-for="item in records.items" :key="item.id">
          <strong>{{ item.original_name }}</strong> ·
          {{
            item.upload_state === "ready"
              ? "已保存"
              : item.upload_state === "pending"
                ? "待完成上传"
                : "已取消或失败"
          }}
          · {{ item.is_active ? "当前采用" : "历史保留" }}
          <span v-if="item.upload_state === 'ready'">
            · {{ item.page_count }} 页 ·
            {{ item.review_state === "accepted" ? "已核对" : "待核对" }} ·
            {{
              item.ocr_state === "succeeded"
                ? "已有编号线索"
                : "未识别，可人工核对"
            }}</span
          ><span v-if="item.external_reference">
            · 外部单号：{{ item.external_reference }}</span
          >
          <ActionGroup class="links" v-if="item.upload_state === 'ready'">
            <button
              type="button"
              class="quiet"
              :disabled="busy"
              @click="show(item)"
            >
              预览 {{ item.original_name }}</button
            ><button
              type="button"
              class="quiet"
              :disabled="busy"
              @click="download(item)"
            >
              下载原件
            </button>
            <button
              v-if="canEdit"
              type="button"
              class="quiet"
              :disabled="busy"
              @click="startEdit(item)"
            >
              更正关联或归档用途
            </button>
            <button
              v-if="canEdit && records.evidence_state !== 'archived'"
              type="button"
              class="quiet"
              :disabled="busy"
              @click="retryRecognition(item)"
            >
              重新识别
            </button>
          </ActionGroup>
          <button
            v-else-if="
              item.upload_state === 'pending' &&
              writable &&
              (item.uploaded_by === account.profile?.membership?.id ||
                account.profile?.membership?.role === 'admin')
            "
            type="button"
            class="quiet"
            :disabled="busy"
            @click="cancel(item)"
          >
            取消待完成上传
          </button>
        </li>
      </ul>
      <div v-if="preview" class="evidence-preview">
        <h3>原件预览：{{ preview.item.original_name }}</h3>
        <p>第 {{ preview.page }} / {{ preview.pages }} 页</p>
        <img :src="preview.url" alt="签字原件当前页" />
        <ActionGroup class="links">
          <button
            type="button"
            class="quiet"
            :disabled="busy || preview.page <= 1"
            @click="show(preview.item, preview.page - 1)"
          >
            上一页</button
          ><button
            type="button"
            class="quiet"
            :disabled="busy || preview.page >= preview.pages"
            @click="show(preview.item, preview.page + 1)"
          >
            下一页</button
          ><button
            type="button"
            class="quiet"
            :disabled="busy"
            @click="closePreview"
          >
            关闭预览
          </button>
        </ActionGroup>
      </div>
      <form v-if="editing && canEdit" @submit.prevent="correct">
        <h3>更正凭证关联或用途</h3>
        <p>原件保留；涉及的单据将重新等待核对。</p>
        <label
          >关联单据<select v-model="target" :disabled="busy">
            <option v-for="d in targets" :key="d.id" :value="d.id">
              {{ d.document_no }}
            </option>
          </select></label
        ><label class="checkbox-row"
          ><input
            v-model="active"
            type="checkbox"
            :disabled="busy"
          />用于当前归档（取消勾选则作为历史保留）</label
        ><FormField
          label="外部单号"
          v-model="correctionReference"
          maxlength="120"
          :disabled="busy"
          v-if="editing.source_kind === 'external'"
        /><FormField
          label="更正原因"
          v-model="reason"
          maxlength="1000"
          required
          :disabled="busy"
          type="textarea"
        />
        <ActionGroup class="links">
          <button :disabled="busy || !reason.trim()">保存更正并重新核对</button
          ><button
            type="button"
            class="quiet"
            :disabled="busy"
            @click="editing = null"
          >
            保留现状
          </button>
        </ActionGroup>
      </form>
      <form
        v-if="writable && records.evidence_state !== 'archived'"
        @submit.prevent="archive"
      >
        <h3>人工核对后归档</h3>
        <p>请查看本次采用的全部原件；系统不判断签名真伪。</p>
        <label class="checkbox-row"
          ><input
            v-model="checks.signatures"
            type="checkbox"
            :disabled="busy"
          />已核对所需签字齐全</label
        ><label class="checkbox-row"
          ><input
            v-model="checks.number"
            type="checkbox"
            :disabled="busy"
          />已核对单号或外部单号及对应关系</label
        ><label class="checkbox-row"
          ><input
            v-model="checks.content"
            type="checkbox"
            :disabled="busy"
          />已核对设备、交接双方及内容</label
        ><label class="checkbox-row"
          ><input
            v-model="checks.pages"
            type="checkbox"
            :disabled="busy"
          />已核对全部页和附件，无缺页</label
        >
        <label
          >人工核对说明{{
            manualRequired ? "（未识别或编号不一致时必填）" : "（可选）"
          }}<textarea
            v-model="manualReason"
            maxlength="1000"
            :disabled="busy"
            :required="manualRequired"
          />
        </label>
        <p v-if="pendingFiles.length" class="hint">
          还有待完成上传，请先重试或取消，再归档。
        </p>
        <button
          :disabled="
            busy ||
            loading ||
            !activeFiles.length ||
            !!pendingFiles.length ||
            !Object.values(checks).every(Boolean) ||
            (manualRequired && !manualReason.trim())
          "
        >
          确认核对并归档
        </button>
      </form>
      <details v-if="records.history.length">
        <summary>凭证办理历史</summary>
        <ol>
          <li v-for="event in records.history" :key="event.id">
            {{ event.actor_label }} · {{ timestamp(event.recorded_at) }} ·
            {{
              event.event_type === "attachment_reviewed"
                ? "核对归档"
                : event.event_type === "attachment_corrected"
                  ? "更正凭证"
                  : event.event_type === "attachment_reserved"
                    ? "预留上传"
                    : event.event_type === "attachment_cancelled"
                      ? "取消上传"
                      : "保存原件"
            }}<span v-if="event.reason">：{{ event.reason }}</span>
          </li>
        </ol>
      </details>
    </template>
  </section>
</template>
