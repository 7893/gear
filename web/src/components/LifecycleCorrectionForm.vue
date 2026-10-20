<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed, ref } from "vue";
import { adminAccess, inventoryRpc } from "../accounts";
import { useAuthorizedAction } from "../useAuthorizedAction";
import type { Asset, AssetDetails } from "../inventory";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ asset: Asset; history: AssetDetails["history"] }>();
const emit = defineEmits<{ updated: [] }>();
const open = ref(false),
  reason = ref("");
const target = computed(() =>
  props.history.find(
    (e) =>
      [
        "asset_lost",
        "asset_scrapped",
        "asset_found",
        "asset_invalidated",
      ].includes(e.event_type) &&
      !props.history.some((r) => r.reverses_event_id === e.id),
  ),
);
const access = computed(() => adminAccess.value && !!target.value);
const { busy, error, run } = useAuthorizedAction(access, [
  () => props.asset.version,
]);
function save() {
  const event = target.value;
  if (!event) return;
  const payload = {
    asset_id: props.asset.id,
    expected_version: props.asset.version,
    event_id: event.id,
    reason: reason.value.trim(),
  };
  void run(
    payload,
    (id) =>
      inventoryRpc("correct_asset_lifecycle", { ...payload, request_id: id }),
    () => emit("updated"),
  );
}
</script>
<template>
  <section v-if="access" aria-label="异常处置纠错">
    <h3>异常处置纠错</h3>
    <ActionGroup v-if="!open"
      ><button class="quiet" type="button" @click="open = true">
        撤销误登记的处置
      </button></ActionGroup
    >
    <form v-else class="stack" @submit.prevent="save">
      <p>
        撤销最近一条尚未撤销的遗失、报废、找回或误建作废记录（记录
        {{
          target?.id
        }}），恢复该记录之前的状态和持有关系。存在后续状态流转时会拒绝。原记录、原件和编号保留。
      </p>
      <FormField
        label="纠错原因"
        v-model="reason"
        required
        maxlength="2000"
        :disabled="busy"
        type="textarea"
      />
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <ActionGroup
        ><button type="submit" :disabled="busy || !reason.trim()">
          确认撤销误登记</button
        ><button
          class="quiet"
          type="button"
          :disabled="busy"
          @click="open = false"
        >
          取消纠错
        </button></ActionGroup
      >
    </form>
  </section>
</template>
