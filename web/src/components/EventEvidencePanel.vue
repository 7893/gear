<script setup lang="ts">
import QueryState from "./QueryState.vue";
import FormField from "./FormField.vue";
import { computed, ref, watch } from "vue";
import { account } from "../accounts";
import {
  listEventEvidence,
  evidenceAccess,
  evidenceWrite,
  uploadEvidence,
  emptyHints,
  reviewEventEvidence,
  cancelEvidence,
  downloadEvidence,
  type Attachment,
} from "../evidence";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { useAuthorizedAction } from "../useAuthorizedAction";
import DownloadAction from "./DownloadAction.vue";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ eventId: string; historical?: boolean }>();
const open = ref(false),
  file = ref<File | null>(null),
  reason = ref(""),
  acknowledged = ref(false),
  note = ref("");
const read = computed(() => evidenceAccess.value && open.value);
const write = computed(() => read.value && evidenceWrite.value);
const {
  data,
  error: readError,
  loading,
  load,
} = useAuthorizedQuery(read, () => listEventEvidence(props.eventId), [
  () => props.eventId,
]);
const { busy, error, run } = useAuthorizedAction(write, [() => props.eventId]);
watch(
  [
    read,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
    () => props.eventId,
  ],
  () => {
    file.value = null;
    reason.value = "";
    acknowledged.value = false;
    note.value = "";
  },
  { flush: "sync" },
);
function selected(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] || null;
  note.value = "";
}
function upload() {
  const selected = file.value,
    current = data.value;
  if (!selected || !current || !acknowledged.value || !reason.value.trim())
    return;
  const explanation = reason.value.trim();
  void run(
    {
      event: props.eventId,
      name: selected.name,
      size: selected.size,
      modified: selected.lastModified,
      version: current.asset_version,
      reason: explanation,
    },
    async (request, signal) => {
      return uploadEvidence(
        selected,
        "",
        current.asset_version,
        request,
        emptyHints(),
        "external",
        explanation.slice(0, 120),
        explanation,
        signal,
        props.eventId,
      );
    },
    () => {
      file.value = null;
      acknowledged.value = false;
      note.value = "凭证已上传，请下载核对后记录核对结果。";
      void load();
    },
  );
}
function review(item: Attachment, accepted: boolean) {
  if (!reason.value.trim()) return;
  const explanation = reason.value.trim();
  void run(
    { id: item.id, version: item.version, accepted, reason: explanation },
    (id) => reviewEventEvidence(item, accepted, explanation, id),
    () => {
      note.value = "核对结果已保存，原文件保留。";
      void load();
    },
  );
}
function cancel(item: Attachment) {
  void run(
    { id: item.id, version: item.version, cancel: true },
    (id) => cancelEvidence(item, id),
    () => void load(),
  );
}
async function download(item: Attachment, signal: AbortSignal) {
  return {
    blob: await downloadEvidence(item.id, signal),
    filename: item.original_name,
    message: "原件已交由浏览器下载。",
  };
}
</script>
<template>
  <section v-if="evidenceAccess" aria-label="事件凭证">
    <ActionGroup
      ><button class="quiet" type="button" @click="open = !open">
        {{
          open
            ? "收起凭证"
            : historical
              ? "查看或补传历史凭证"
              : "查看或补传事件凭证"
        }}
      </button></ActionGroup
    >
    <div v-if="open" class="stack">
      <p class="hint">
        {{
          historical
            ? "补充原有领用、移交等历史证明，不补造交接单和签字。"
            : "附件仅作为本事件的证明材料。"
        }}原件永久保留；请下载查看内容后人工核对。
      </p>
      <QueryState
        :loading="loading"
        :error="readError"
        loading-text="正在读取凭证…"
        retry-label="重新读取凭证"
        @retry="load"
      />
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <p v-if="note" role="status">{{ note }}</p>
      <template v-if="data"
        ><p v-if="!data.items.length">尚未上传凭证。</p>
        <ul>
          <li v-for="item in data.items" :key="item.id">
            <p>
              {{ item.original_name }} ·
              {{
                item.upload_state === "ready"
                  ? item.review_state === "accepted"
                    ? "已核对"
                    : item.review_state === "rejected"
                      ? "不采用，保留原件"
                      : "待核对"
                  : item.is_active
                    ? "上传未完成"
                    : "已取消上传"
              }}
            </p>
            <DownloadAction
              v-if="item.upload_state === 'ready'"
              :allowed="read"
              label="下载凭证原件"
              :query="(signal) => download(item, signal)"
            /><ActionGroup v-if="write && item.is_active"
              ><template
                v-if="
                  item.upload_state === 'ready' &&
                  (item.review_state === 'pending' ||
                    account.profile?.membership?.role === 'admin')
                "
                ><button
                  class="quiet"
                  :disabled="busy || !reason.trim()"
                  type="button"
                  @click="review(item, true)"
                >
                  确认凭证相符</button
                ><button
                  class="quiet"
                  :disabled="busy || !reason.trim()"
                  type="button"
                  @click="review(item, false)"
                >
                  标记凭证不采用
                </button></template
              ><button
                v-if="item.upload_state === 'pending'"
                class="quiet"
                :disabled="busy"
                type="button"
                @click="cancel(item)"
              >
                取消未完成上传
              </button></ActionGroup
            >
          </li>
        </ul>
        <form v-if="write" class="stack" @submit.prevent="upload">
          <FormField
            label="上传或核对说明"
            v-model="reason"
            :disabled="busy"
            maxlength="1000"
            required
            type="textarea"
          /><label
            >凭证原件<input
              :key="note"
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              :disabled="busy"
              @change="selected"
          /></label>
          <p class="hint">
            PDF、JPEG、PNG；单份最多 20 MB、20 页；每事件最多 10 份、合计 100
            MB。
          </p>
          <label class="check"
            ><input
              v-model="acknowledged"
              type="checkbox"
              :disabled="busy"
            />已确认所选凭证属于本事件</label
          ><ActionGroup
            ><button
              :disabled="busy || !file || !acknowledged || !reason.trim()"
              type="submit"
            >
              {{ busy ? "正在处理…" : "上传事件凭证" }}
            </button></ActionGroup
          >
        </form></template
      >
    </div>
  </section>
</template>
