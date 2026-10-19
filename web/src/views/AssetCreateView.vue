<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { account, safeError } from "../accounts";
import {
  inventoryWriteAccess,
  listParties,
  initializeAsset,
  categories,
  partyLabel,
  businessToday,
  requestFor,
  type Party,
  type AssetInput,
  type Category,
  type Placement,
} from "../inventory";
import InventoryGate from "../components/InventoryGate.vue";
import PartyQuickCreate from "../components/PartyQuickCreate.vue";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
const router = useRouter();
const form = reactive<
  Omit<AssetInput, "category" | "condition"> & {
    category: Category | "";
    condition: "" | "normal" | "faulty";
  }
>({
  name: "",
  category: "",
  condition: "",
  legacy_code: "",
  serial_number: "",
  brand: "",
  model: "",
  location: "",
  note: "",
});
const holderMode = ref<"inventory" | "person" | "team">("inventory");
const holderId = ref("");
const responsibleId = ref("");
const usage = ref<"long_term" | "temporary">("long_term");
const knownOn = ref("");
const dueOn = ref("");
const {
  data: partyData,
  loading: partyLoading,
  error: partyError,
  load: loadParties,
} = useAuthorizedQuery(inventoryWriteAccess, listParties);
const parties = computed(() => partyData.value || []);
const people = computed(() => parties.value.filter((p) => p.kind === "person"));
const holders = computed(() =>
  parties.value.filter((p) => p.kind === holderMode.value),
);
const partyBusy = ref(false);
const busy = ref(false);
const error = ref("");
const duplicatePrompt = ref(false);
const acknowledged = ref(false);
const requests = new Map<string, string>();
watch(
  holderMode,
  () => {
    holderId.value = "";
    responsibleId.value = "";
    knownOn.value = "";
    dueOn.value = "";
    usage.value = "long_term";
  },
  { flush: "sync" },
);
watch(
  holderId,
  (value) => {
    const selected = parties.value.find((p) => p.id === value);
    responsibleId.value =
      selected?.kind === "person"
        ? selected.id
        : selected?.default_responsible_id || "";
  },
  { flush: "sync" },
);
watch(
  () => form.legacy_code,
  () => {
    acknowledged.value = false;
    duplicatePrompt.value = false;
  },
);
function createdParty(created: Party) {
  partyData.value = [
    ...parties.value.filter((p) => p.id !== created.id),
    created,
  ];
  holderMode.value = created.kind;
  holderId.value = created.id;
}
async function save() {
  if (
    !inventoryWriteAccess.value ||
    busy.value ||
    partyBusy.value ||
    !form.category ||
    !form.condition
  )
    return;
  const owner = account.profile?.membership?.id;
  busy.value = true;
  error.value = "";
  const details: AssetInput = {
    ...form,
    category: form.category,
    condition: form.condition,
  };
  const placement: Placement = {
    holder_party_id: holderMode.value === "inventory" ? null : holderId.value,
    responsible_person_id:
      holderMode.value === "inventory" ? null : responsibleId.value,
    usage_kind: holderMode.value === "inventory" ? null : usage.value,
    known_on: knownOn.value || null,
    due_on:
      holderMode.value !== "inventory" && usage.value === "temporary"
        ? dueOn.value || null
        : null,
  };
  const payload = { details, placement, allowDuplicate: acknowledged.value };
  try {
    const saved = await initializeAsset(
      details,
      placement,
      requestFor(requests, payload),
      acknowledged.value,
    );
    if (inventoryWriteAccess.value && owner === account.profile?.membership?.id)
      await router.push("/assets/" + saved.id);
  } catch (failure) {
    if (inventoryWriteAccess.value) {
      error.value = safeError(failure);
      if (
        failure &&
        typeof failure === "object" &&
        "message" in failure &&
        failure.message === "legacy_code_duplicate"
      )
        duplicatePrompt.value = true;
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="inventoryWriteAccess" class="card">
    <RouterLink to="/assets">返回设备台账</RouterLink>
    <h1 class="refresh">登记已有设备</h1>
    <p class="muted">
      记录当前真实情况。已有编号原样保留；内部编号由系统生成。未知历史日期留空，建账不会生成历史交接单。
    </p>
    <PartyQuickCreate
      v-model:busy="partyBusy"
      :people="people"
      :allowed="inventoryWriteAccess"
      :disabled="busy || partyLoading"
      @created="createdParty"
    />
    <p v-if="partyLoading" role="status">正在读取人员与团队…</p>
    <div v-if="partyError" class="notice error" role="alert">
      <p>{{ partyError }}</p>
      <button class="quiet" type="button" @click="loadParties">
        刷新人员与团队
      </button>
    </div>
    <form class="form-grid" @submit.prevent="save">
      <label
        >设备名称<input v-model="form.name" maxlength="120" required
      /></label>
      <label
        >设备分类<select v-model="form.category" required>
          <option value="">请选择分类</option>
          <option v-for="(label, code) in categories" :key="code" :value="code">
            {{ label }}
          </option>
        </select></label
      >
      <label
        >设备状况<select v-model="form.condition" required>
          <option value="">请核对实际状况</option>
          <option value="normal">正常</option>
          <option value="faulty">故障</option>
        </select></label
      >
      <label
        >原资产编号<input
          v-model="form.legacy_code"
          aria-label="原资产编号"
          maxlength="120"
        /><span class="hint"
          >可留空；保留原格式和前导零，不作为唯一编号。</span
        ></label
      >
      <label>品牌<input v-model="form.brand" maxlength="120" /></label
      ><label>型号<input v-model="form.model" maxlength="120" /></label>
      <label
        >出厂序列号<input v-model="form.serial_number" maxlength="120" /></label
      ><label>位置<input v-model="form.location" maxlength="120" /></label>
      <label
        >当前持有情况<select v-model="holderMode">
          <option value="inventory">经办人库存</option>
          <option value="person">个人持有</option>
          <option value="team">团队持有</option>
        </select></label
      >
      <template v-if="holderMode !== 'inventory'">
        <label
          >持有方<select v-model="holderId" required>
            <option value="">请选择，或在上方新增</option>
            <option v-for="p in holders" :key="p.id" :value="p.id">
              {{ partyLabel(p) }}
            </option>
          </select></label
        >
        <label v-if="holderMode === 'team'"
          >本设备负责人<select v-model="responsibleId" required>
            <option value="">请选择个人负责人</option>
            <option v-for="p in people" :key="p.id" :value="p.id">
              {{ partyLabel(p) }}
            </option>
          </select></label
        >
        <label
          >使用期限<select v-model="usage">
            <option value="long_term">长期使用</option>
            <option value="temporary">临时使用</option>
          </select></label
        >
        <label v-if="usage === 'temporary'"
          >预计归还日期<input
            v-model="dueOn"
            type="date"
            required
            :min="knownOn || undefined"
        /></label>
      </template>
      <label
        >{{ holderMode === "inventory" ? "已知到手日期" : "已知领用起始日期"
        }}<input v-model="knownOn" type="date" :max="businessToday()" /><span
          class="hint"
          >历史日期不知道就留空，不使用今天代填。</span
        ></label
      >
      <label class="form-wide"
        >设备备注<textarea
          v-model="form.note"
          maxlength="2000"
          rows="3"
          placeholder="配件、外观、历史来源等"
        />
      </label>
      <div class="form-wide">
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <label v-if="duplicatePrompt" class="checkbox-row"
          ><input
            v-model="acknowledged"
            type="checkbox"
          />已核对重复旧编号，确认是不同实物，继续独立建账</label
        >
        <p class="hint">
          提交未完成时，保持原内容重试可避免重复登记；若修改内容或刷新页面，请先核对台账。
        </p>
        <button
          type="submit"
          :disabled="busy || partyBusy || (duplicatePrompt && !acknowledged)"
        >
          {{ busy ? "正在保存…" : "保存并查看设备" }}
        </button>
      </div>
    </form>
  </section>
  <InventoryGate v-else title="登记已有设备" />
</template>
