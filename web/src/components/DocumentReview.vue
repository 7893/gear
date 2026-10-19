<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { account, safeError } from "../accounts";
import { requestFor, timestamp } from "../inventory";
import {
  flowAdminAccess,
  listDocuments,
  reviewDocument,
  type FlowDocument,
} from "../flows";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ document: FlowDocument }>();
const emit = defineEmits<{ changed: [] }>();
const eligible = computed(
  () => flowAdminAccess.value && props.document.status === "confirmed",
);
const action = ref<"void_document" | "correct_document" | null>(null);
const reason = ref("");
const correction = ref("");
const replacement = ref("");
const acknowledged = ref(false);
const busy = ref(false);
const error = ref("");
const requests = new Map<string, string>();
let generation = 0;
const replacementAccess = computed(
  () => eligible.value && action.value === "correct_document",
);
const {
  data: replacements,
  loading,
  error: listError,
  load,
} = useAuthorizedQuery(
  replacementAccess,
  () =>
    listDocuments({
      search: "",
      kind: props.document.kind,
      state: "confirmed",
    }),
  [() => props.document.id],
);
const candidates = computed(() =>
  (replacements.value || []).filter(
    (d) =>
      d.id !== props.document.id &&
      d.status === "confirmed" &&
      (!props.document.confirmed_at ||
        (d.confirmed_at || "") >= props.document.confirmed_at),
  ),
);
function clear() {
  action.value = null;
  reason.value = "";
  correction.value = "";
  replacement.value = "";
  acknowledged.value = false;
  error.value = "";
}
watch(
  [
    eligible,
    () => account.profile?.membership?.id,
    () => props.document.id,
    () => props.document.version,
  ],
  () => {
    generation++;
    busy.value = false;
    clear();
    requests.clear();
  },
  { flush: "sync" },
);
onBeforeUnmount(() => generation++);
async function submit() {
  if (!eligible.value || !action.value || busy.value) return;
  if (
    !reason.value.trim() ||
    (action.value === "correct_document" && !correction.value.trim())
  ) {
    error.value = safeError(
      new Error(
        action.value === "void_document"
          ? "invalid_document_void"
          : "invalid_document_correction",
      ),
    );
    return;
  }
  if (action.value === "void_document" && !acknowledged.value) return;
  const current = generation;
  const payload = {
    id: props.document.id,
    version: props.document.version,
    action: action.value,
    reason: reason.value.trim(),
    correction: correction.value.trim(),
    replacement: replacement.value || null,
  };
  busy.value = true;
  error.value = "";
  try {
    await reviewDocument(
      props.document,
      payload.action,
      payload.reason,
      payload.correction,
      payload.replacement,
      requestFor(requests, payload),
    );
    if (current === generation && eligible.value) emit("changed");
  } catch (failure) {
    if (current === generation && eligible.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section v-if="eligible" class="print-controls" aria-label="管理员单据处理">
    <h2>管理员单据处理</h2>
    <ActionGroup v-if="!action">
      <button type="button" class="quiet" @click="action = 'correct_document'">
        追加更正说明
      </button>
      <button
        type="button"
        class="quiet danger"
        @click="action = 'void_document'"
      >
        作废误录单据
      </button>
    </ActionGroup>
    <form v-else class="stack" @submit.prevent="submit">
      <h3>
        {{ action === "void_document" ? "作废误录单据" : "追加更正说明" }}
      </h3>
      <p v-if="action === 'void_document'" class="notice">
        仅用于实际交接不成立的误录。系统逐件核对后续依赖和当前状态，全部符合才整单恢复；有后续流转、故障或延期时拒绝。原单号、快照和签字件永久保留。
      </p>
      <p v-else class="notice">
        更正说明与原单关联保留，不覆盖打印快照或签字原件，不改变设备去向、数量或期限。真实设备变化仍需办理对应业务。
      </p>
      <label
        >处理原因<textarea
          v-model="reason"
          required
          maxlength="2000"
          :disabled="busy"
        />
      </label>
      <template v-if="action === 'correct_document'">
        <label
          >更正说明<textarea
            v-model="correction"
            required
            maxlength="4000"
            :disabled="busy"
            placeholder="写明原记录有误的内容、正确事实及涉及的设备编号"
          />
        </label>
        <p v-if="loading" role="status">正在读取可关联单据…</p>
        <div v-if="listError" class="notice error" role="alert">
          {{ listError }}
          <button type="button" class="quiet" @click="load">
            重新读取可关联单据
          </button>
        </div>
        <label
          >关联替代单（可选）<select
            v-model="replacement"
            :disabled="busy || loading || !!listError"
          >
            <option value="">不关联其他单据</option>
            <option v-for="doc in candidates" :key="doc.id" :value="doc.id">
              {{ doc.document_no }} · {{ doc.from_label }} → {{ doc.to_label }}
            </option>
          </select></label
        >
      </template>
      <label v-else class="checkbox-row"
        ><input
          v-model="acknowledged"
          type="checkbox"
          required
          :disabled="busy"
        />已核对这是误录，实际交接不成立，申请作废整单</label
      >
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <ActionGroup>
        <button type="submit" :disabled="busy">
          {{
            busy
              ? "正在处理…"
              : action === "void_document"
                ? "确认作废整单"
                : "保存更正说明"
          }}
        </button>
        <button type="button" class="quiet" :disabled="busy" @click="clear">
          取消处理
        </button>
      </ActionGroup>
    </form>
  </section>
  <section
    v-if="document.changes?.length"
    class="document-changes"
    aria-label="单据处理记录"
  >
    <h2>单据处理记录</h2>
    <p>以下为原单的补充记录，原打印内容和签字件保留。</p>
    <ol class="asset-history">
      <li v-for="change in document.changes" :key="change.id">
        <strong>{{
          change.event_type === "document_voided" ? "整单作废" : "更正说明"
        }}</strong>
        <p>
          {{ timestamp(change.recorded_at) }}（东八区）；管理员：{{
            change.actor_label
          }}
        </p>
        <p class="preserve-text">原因：{{ change.reason }}</p>
        <p v-if="change.correction_text" class="preserve-text">
          {{ change.correction_text }}
        </p>
        <RouterLink
          v-if="change.replacement_document_id"
          :to="'/documents/' + change.replacement_document_id"
          >关联替代单：{{ change.replacement_document_no }}</RouterLink
        >
      </li>
    </ol>
  </section>
</template>
