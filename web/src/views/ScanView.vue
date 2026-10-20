<script setup lang="ts">
import QueryState from "../components/QueryState.vue";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { account } from "../accounts";
import { flowAccess, getDocument, flowKinds, documentStates } from "../flows";
import {
  inventoryAccess,
  getAsset,
  assetStates,
  holderLabel,
} from "../inventory";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { recordPath, returnPath } from "../references";
import ActionGroup from "../components/ActionGroup.vue";
const route = useRoute();
const kind = computed(() =>
  route.params.kind === "asset"
    ? "asset"
    : route.params.kind === "document"
      ? "document"
      : null,
);
const code = computed(() => String(route.params.code || ""));
const valid = computed(() => !!kind.value && !!returnPath(route.path));
const title = computed(() =>
  kind.value === "asset" ? "设备核对" : "单据核对",
);
const allowed = computed(
  () =>
    valid.value &&
    (kind.value === "asset" ? inventoryAccess.value : flowAccess.value),
);
const { data, loading, error, load } = useAuthorizedQuery(allowed, async () => {
  if (kind.value === "asset") {
    const { asset } = await getAsset(code.value);
    return {
      code: asset.asset_code,
      name: asset.name,
      status: asset.invalidated_at
        ? "建账已作废"
        : assetStates[asset.display_status],
      destination: holderLabel(asset),
      date: asset.due_on,
      dateTitle: "预计归还",
      details: recordPath("asset", asset),
      invalid: !!asset.invalidated_at,
    };
  }
  const doc = await getDocument(code.value);
  return {
    code: doc.document_no || doc.reference_code || "草稿",
    name: flowKinds[doc.kind] + "单",
    status: documentStates[doc.status],
    destination: `${doc.parties_snapshot?.from_label || doc.from_label} → ${doc.parties_snapshot?.to_label || doc.to_label}`,
    date: doc.handover_on,
    dateTitle: "实际交接",
    details: recordPath("document", doc),
    invalid: doc.status === "voided",
  };
}, [() => route.fullPath]);
</script>
<template>
  <section class="card narrow scan-card">
    <p class="eyebrow">设备簿 · 扫码核对</p>
    <h1>{{ title }}</h1>
    <template v-if="!valid"
      ><p role="alert">
        此二维码链接无效，请核对纸质单号或联系经办人。
      </p></template
    >
    <template v-else>
      <p class="reference-code">{{ code }}</p>
      <p v-if="!account.signedIn">
        请登录后查看对应记录。二维码用于定位记录，不作为交接或签字已经确认的证明。
      </p>
      <template v-else-if="!allowed"
        ><p>当前账号尚无查看权限，请核对审核状态或联系管理员。</p>
        <RouterLink to="/account">查看账号状态</RouterLink></template
      >
      <QueryState
        :loading="loading"
        :error="error"
        loading-text="正在读取最新记录…"
        retry-label="重新读取"
        @retry="load"
      />
      <template v-if="data">
        <h2>{{ data.name }}</h2>
        <p :class="data.invalid ? 'notice error' : 'notice'">
          {{ data.status }}
        </p>
        <dl class="asset-fields">
          <div>
            <dt>编号</dt>
            <dd class="reference-code">{{ data.code }}</dd>
          </div>
          <div>
            <dt>{{ kind === "asset" ? "当前持有方" : "交接双方" }}</dt>
            <dd>{{ data.destination }}</dd>
          </div>
          <div>
            <dt>{{ data.dateTitle }}</dt>
            <dd>{{ data.date || "未填写" }}</dd>
          </div>
        </dl>
        <ActionGroup
          ><RouterLink class="button" :to="data.details"
            >查看完整{{ kind === "asset" ? "设备" : "单据" }}</RouterLink
          ></ActionGroup
        >
        <p class="hint">请以系统当前记录和实际签字原件核对结果为准。</p>
      </template>
      <ActionGroup v-if="!account.signedIn"
        ><RouterLink
          class="button"
          :to="{ path: '/login', query: { next: route.fullPath } }"
          >登录后继续查看</RouterLink
        ></ActionGroup
      >
    </template>
  </section>
</template>
