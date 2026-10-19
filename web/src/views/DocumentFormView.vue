<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { account, safeError } from "../accounts";
import {
  listAssets,
  listParties,
  categories,
  partyLabel,
  dueLabel,
  businessToday,
  requestFor,
  type Asset,
  type Party,
} from "../inventory";
import {
  blankDetails,
  flowWriteAccess,
  flowKinds,
  transferModes,
  getDocument,
  saveDocument,
  confirmDocument,
  type FlowDocument,
  type FlowItem,
  type FlowKind,
  type NewAssetData,
} from "../flows";
import FlowGate from "../components/FlowGate.vue";
import PartyQuickCreate from "../components/PartyQuickCreate.vue";
import ActionGroup from "../components/ActionGroup.vue";
const route = useRoute();
const router = useRouter();
const initialKind = (): FlowKind =>
  Object.hasOwn(flowKinds, String(route.query.kind))
    ? (route.query.kind as FlowKind)
    : "issue";
const form = reactive(blankDetails(initialKind()));
type EditableItem = FlowItem & { key: string };
const items = ref<EditableItem[]>([]);
const draft = ref<FlowDocument | null>(null);
const assets = ref<Asset[]>([]);
const parties = ref<Party[]>([]);
const loading = ref(false);
const ready = ref(false);
const busy = ref(false);
const partyBusy = ref(false);
const error = ref("");
const notice = ref("");
const reviewing = ref(false);
const search = ref("");
const requests = new Map<string, string>();
let generation = 0;
const template = reactive({
  name: "",
  category: "",
  brand: "",
  model: "",
  count: 1,
  condition: "",
  location: "",
  note: "",
});
const people = computed(() => parties.value.filter((p) => p.kind === "person"));
const target = computed(() =>
  parties.value.find((p) => p.id === form.to_party_id),
);
const responsibility = computed(
  () => form.kind === "transfer" && form.transfer_mode === "responsibility",
);
const assignsUsage = computed(
  () =>
    form.kind === "issue" ||
    (form.kind === "transfer" && !responsibility.value),
);
const sources = computed(() => [
  ...new Map(
    assets.value
      .filter(
        (a) =>
          a.holder_party_id &&
          (!responsibility.value || a.holder_kind === "team"),
      )
      .map((a) => [
        a.holder_party_id!,
        { id: a.holder_party_id!, name: a.holder_name || "未命名持有方" },
      ]),
  ).values(),
]);
const sourcePeople = computed(() => [
  ...new Map(
    assets.value
      .filter(
        (a) =>
          a.holder_party_id === form.from_party_id && a.responsible_person_id,
      )
      .map((a) => [
        a.responsible_person_id!,
        {
          id: a.responsible_person_id!,
          name: a.responsible_name || "未命名负责人",
        },
      ]),
  ).values(),
]);
const available = computed(() =>
  assets.value
    .filter((a) => {
      if (form.kind === "receipt")
        return a.management_status === "returned_upstream";
      if (a.management_status !== "managed") return false;
      if (form.kind === "issue")
        return a.display_status === "inventory_available";
      if (
        form.kind === "transfer" &&
        !responsibility.value &&
        a.condition !== "normal"
      )
        return false;
      return form.from_kind === "inventory"
        ? !a.holder_party_id
        : a.holder_party_id === form.from_party_id &&
            a.responsible_person_id === form.from_person_id;
    })
    .filter((a) =>
      [a.asset_code, a.legacy_code, a.name, a.model, a.holder_name]
        .join(" ")
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ),
);
const selectedIds = computed(() => new Set(items.value.map((i) => i.asset_id)));
function itemLabel(item: FlowItem) {
  const asset = selectedAsset(item);
  return item.asset_id
    ? `${asset?.asset_code || "已选设备"} · ${asset?.name || "请刷新设备清单核对"}`
    : "新设备，确认后生成内部编号";
}
function selectedAsset(item: FlowItem) {
  return assets.value.find((a) => a.id === item.asset_id);
}
function normalizedItems(): FlowItem[] {
  return items.value.map((item) => ({
    asset_id: item.asset_id,
    new_asset_data: item.new_asset_data,
    expected_asset_version: item.expected_asset_version,
    condition_on_handover: item.condition_on_handover,
    location: item.location,
    note: item.note,
    allow_legacy_duplicate: item.allow_legacy_duplicate,
  }));
}
function clear() {
  items.value = [];
  assets.value = [];
  parties.value = [];
  draft.value = null;
  reviewing.value = false;
  busy.value = false;
  loading.value = false;
  ready.value = false;
  error.value = "";
  notice.value = "";
  Object.assign(form, blankDetails(initialKind()));
  requests.clear();
}
async function load() {
  const current = ++generation;
  error.value = "";
  loading.value = true;
  ready.value = false;
  try {
    const [stock, recipients, saved] = await Promise.all([
      listAssets({
        search: "",
        category: null,
        state: null,
        holder_kind: null,
      }),
      listParties(),
      route.params.id
        ? getDocument(String(route.params.id))
        : Promise.resolve(null),
    ]);
    if (current !== generation || !flowWriteAccess.value) return;
    assets.value = stock.items;
    parties.value = recipients;
    if (saved) {
      if (saved.status !== "draft") {
        await router.replace("/documents/" + saved.id);
        return;
      }
      const details = blankDetails(saved.kind);
      for (const key of Object.keys(details) as (keyof typeof details)[])
        Object.assign(details, { [key]: saved[key] ?? details[key] });
      Object.assign(form, details);
      draft.value = saved;
      items.value = saved.items.map((i) => ({
        key: crypto.randomUUID(),
        asset_id: i.asset_id,
        new_asset_data: i.new_asset_data,
        expected_asset_version: i.expected_asset_version,
        condition_on_handover: i.condition_on_handover,
        location: i.location,
        note: i.note,
        allow_legacy_duplicate: i.allow_legacy_duplicate,
      }));
    }
    ready.value = true;
  } catch (failure) {
    if (current === generation && flowWriteAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function refreshAssets() {
  if (busy.value || partyBusy.value || !flowWriteAccess.value) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await listAssets({
      search: "",
      category: null,
      state: null,
      holder_kind: null,
    });
    if (current === generation && flowWriteAccess.value)
      assets.value = result.items;
  } catch (failure) {
    if (current === generation && flowWriteAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
watch(
  [
    flowWriteAccess,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
    () => route.params.id,
    () => route.query.kind,
  ],
  () => {
    generation++;
    clear();
    if (flowWriteAccess.value) void load();
  },
  { immediate: true },
);
watch(
  () => form.to_party_id,
  () => {
    if (loading.value) return;
    form.to_person_id =
      target.value?.kind === "person"
        ? target.value.id
        : target.value?.default_responsible_id || null;
  },
  { flush: "sync" },
);
watch(
  () => form.from_party_id,
  () => {
    if (!loading.value)
      form.from_person_id =
        sourcePeople.value.length === 1 ? sourcePeople.value[0].id : null;
  },
  { flush: "sync" },
);
watch(
  () => form.from_kind,
  (kind) => {
    if (!loading.value && kind === "inventory" && form.kind === "return")
      form.to_kind = "external";
  },
  { flush: "sync" },
);
watch(
  [() => form.transfer_mode, () => form.from_party_id],
  () => {
    if (loading.value || form.kind !== "transfer") return;
    form.to_party_id = responsibility.value ? form.from_party_id : null;
    form.to_person_id = null;
    form.usage_kind = responsibility.value ? null : "long_term";
    form.due_on = null;
  },
  { flush: "sync" },
);
watch(
  () => form.usage_kind,
  (usage) => {
    if (usage !== "temporary") form.due_on = null;
  },
);
onBeforeUnmount(() => generation++);
function toggle(asset: Asset) {
  if (selectedIds.value.has(asset.id)) {
    items.value = items.value.filter((i) => i.asset_id !== asset.id);
    return;
  }
  if (items.value.length >= 100) {
    error.value = "每单最多 100 件设备。";
    return;
  }
  items.value.push({
    key: crypto.randomUUID(),
    asset_id: asset.id,
    expected_asset_version: asset.version ?? null,
    new_asset_data: null,
    condition_on_handover:
      form.kind === "issue" ||
      (form.kind === "transfer" && !responsibility.value)
        ? "normal"
        : responsibility.value
          ? asset.condition
          : null,
    location: asset.location,
    note:
      responsibility.value && asset.condition === "faulty"
        ? "保留当前故障状况，仅交接负责人"
        : "",
    allow_legacy_duplicate: false,
  });
}
function expand() {
  if (
    !Number.isInteger(template.count) ||
    template.count < 1 ||
    items.value.length + template.count > 100 ||
    !template.name.trim() ||
    !template.category ||
    !["normal", "faulty"].includes(template.condition) ||
    (template.condition === "faulty" && !template.note.trim())
  ) {
    error.value =
      "请填写设备名称、分类、实际状况；故障须说明，整单不超过 100 件。";
    return;
  }
  for (let i = 0; i < template.count; i++) {
    const data: NewAssetData = {
      name: template.name,
      category: template.category,
      brand: template.brand,
      model: template.model,
      legacy_code: "",
      serial_number: "",
      note: "",
    };
    items.value.push({
      key: crypto.randomUUID(),
      asset_id: null,
      new_asset_data: data,
      expected_asset_version: null,
      condition_on_handover: template.condition as "normal" | "faulty",
      location: template.location,
      note: template.note,
      allow_legacy_duplicate: false,
    });
  }
  error.value = "";
}
function createdParty(party: Party) {
  parties.value = [...parties.value.filter((p) => p.id !== party.id), party];
  form.to_party_id = party.id;
}
function details() {
  const data = {
    ...form,
    handover_on: form.handover_on || null,
    due_on: form.due_on || null,
  };
  if (data.kind === "receipt") {
    data.from_kind = "external";
    data.to_kind = "inventory";
    data.from_party_id = null;
    data.to_party_id = null;
    data.from_person_id = null;
    data.to_person_id = null;
  }
  if (data.kind === "issue") {
    data.from_kind = "inventory";
    data.to_kind = "party";
    data.from_party_id = null;
    data.from_person_id = null;
  }
  if (data.kind === "return") {
    data.to_party_id = null;
    data.to_person_id = null;
    if (data.from_kind === "inventory") {
      data.from_party_id = null;
      data.from_person_id = null;
    }
  }
  if (data.kind === "transfer") {
    data.from_kind = "party";
    data.to_kind = "party";
    if (responsibility.value) data.to_party_id = data.from_party_id;
  } else data.transfer_mode = null;
  if (!assignsUsage.value) {
    data.usage_kind = null;
    data.due_on = null;
  }
  if (data.from_kind === "inventory") data.from_label = "经办人库存";
  if (data.to_kind === "inventory") data.to_label = "经办人库存";
  if (data.from_kind === "party")
    data.from_label =
      sources.value.find((p) => p.id === data.from_party_id)?.name ||
      data.from_label;
  if (data.to_kind === "party")
    data.to_label = target.value?.name || data.to_label;
  return data;
}
async function save(review = false) {
  if (
    busy.value ||
    partyBusy.value ||
    loading.value ||
    !ready.value ||
    !flowWriteAccess.value
  )
    return;
  const data = details();
  if (
    review &&
    data.kind === "transfer" &&
    (!data.from_party_id ||
      !data.from_person_id ||
      !data.to_party_id ||
      !data.to_person_id ||
      (responsibility.value
        ? data.from_party_id !== data.to_party_id ||
          data.from_person_id === data.to_person_id
        : data.from_party_id === data.to_party_id))
  ) {
    error.value = safeError(new Error("invalid_transfer_parties"));
    return;
  }
  if (
    review &&
    (!data.handover_on ||
      data.handover_on > businessToday() ||
      !data.sender_name.trim() ||
      !data.receiver_name.trim() ||
      !items.value.length ||
      items.value.some(
        (i) =>
          !i.condition_on_handover ||
          (i.condition_on_handover === "faulty" && !i.note?.trim()),
      ))
  ) {
    error.value =
      "请补齐实际交接日期、移交人、接收人、设备及状况；故障须说明。";
    return;
  }
  if (
    review &&
    ((data.kind === "receipt" && !data.from_label.trim()) ||
      (assignsUsage.value &&
        (!data.to_party_id ||
          !data.to_person_id ||
          (data.usage_kind === "temporary" &&
            (!data.due_on || data.due_on < (data.handover_on || ""))))) ||
      (data.kind === "return" &&
        (!data.remarks.trim() ||
          (data.from_kind === "party" &&
            (!data.from_party_id || !data.from_person_id)) ||
          (data.to_kind === "external" && !data.to_label.trim()))))
  ) {
    error.value = "请补齐交接双方及负责人、临时期限或退回说明。";
    return;
  }
  const current = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  const lines = normalizedItems();
  const payload = {
    action: "save",
    details: data,
    items: lines,
    document_id: draft.value?.id || null,
    expected_version: draft.value?.version ?? null,
  };
  try {
    const result = await saveDocument(
      data,
      lines,
      requestFor(requests, payload),
      draft.value,
    );
    if (current !== generation || !flowWriteAccess.value) return;
    draft.value = result;
    notice.value = "草稿已保存，尚未改变设备去向。";
    reviewing.value = review;
  } catch (failure) {
    if (current === generation && flowWriteAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function confirm() {
  if (!draft.value || busy.value || !reviewing.value || !flowWriteAccess.value)
    return;
  const current = generation;
  busy.value = true;
  error.value = "";
  const payload = {
    action: "confirm",
    id: draft.value.id,
    version: draft.value.version,
  };
  try {
    const result = await confirmDocument(
      draft.value,
      requestFor(requests, payload),
    );
    if (current === generation && flowWriteAccess.value)
      await router.push("/documents/" + result.id);
  } catch (failure) {
    if (current === generation && flowWriteAccess.value)
      error.value = safeError(failure);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section v-if="flowWriteAccess" class="card">
    <RouterLink to="/flows">返回流转办理</RouterLink>
    <h1 class="refresh">
      {{ draft ? "编辑" : "新建" }}{{ flowKinds[form.kind] }}单
    </h1>
    <p class="hint">
      东八区业务日期。保存草稿不占库存；实际交接后才确认。刷新前先保存，确认响应不明时先查单据记录。
    </p>
    <p v-if="loading" role="status">正在读取设备和名单…</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button
      v-if="error && !items.length && loading === false"
      type="button"
      class="quiet"
      :disabled="busy"
      @click="load"
    >
      重新读取
    </button>
    <fieldset
      v-if="!loading && ready"
      :disabled="busy || reviewing || partyBusy"
    >
      <div class="flow-grid">
        <label
          >办理类型<select
            v-model="form.kind"
            :disabled="items.length > 0 || !!draft"
            @change="Object.assign(form, blankDetails(form.kind))"
          >
            <option
              v-for="(label, kind) in flowKinds"
              :key="kind"
              :value="kind"
            >
              {{ label }}
            </option>
          </select></label
        >
        <label
          >实际交接日期<input
            v-model="form.handover_on"
            type="date"
            :max="businessToday()"
        /></label>
        <label
          >实际移交人<input v-model="form.sender_name" maxlength="120" /></label
        ><label
          >实际接收人<input v-model="form.receiver_name" maxlength="120"
        /></label>
      </div>
      <label v-if="form.kind === 'transfer'"
        >转交方式<select
          v-model="form.transfer_mode"
          :disabled="items.length > 0"
        >
          <option
            v-for="(label, mode) in transferModes"
            :key="mode"
            :value="mode"
          >
            {{ label }}
          </option>
        </select></label
      >
      <label v-if="form.kind === 'receipt'"
        >来源单位或交付方<input v-model="form.from_label" maxlength="120"
      /></label>
      <div
        v-if="form.kind === 'return' || form.kind === 'transfer'"
        class="flow-grid"
      >
        <label v-if="form.kind === 'return'"
          >交出方类型<select
            v-model="form.from_kind"
            :disabled="items.length > 0"
          >
            <option value="party">个人或团队</option>
            <option value="inventory">经办人库存</option>
          </select></label
        >
        <template v-if="form.from_kind === 'party'"
          ><label
            >当前持有方<select
              v-model="form.from_party_id"
              :disabled="items.length > 0"
            >
              <option :value="null">请选择持有方</option>
              <option
                v-for="source in sources"
                :key="source.id"
                :value="source.id"
              >
                {{ source.name }}
              </option>
            </select></label
          >
          <label
            >交出负责人<select
              v-model="form.from_person_id"
              :disabled="items.length > 0"
            >
              <option :value="null">请选择负责人</option>
              <option
                v-for="person in sourcePeople"
                :key="person.id"
                :value="person.id"
              >
                {{ person.name }}
              </option>
            </select></label
          ></template
        >
        <label v-if="form.kind === 'return'"
          >退回去向<select v-model="form.to_kind">
            <option v-if="form.from_kind === 'party'" value="inventory">
              经办人库存
            </option>
            <option value="external">上游单位或交付方</option>
          </select></label
        >
        <label v-if="form.kind === 'return' && form.to_kind === 'external'"
          >上游接收单位<input v-model="form.to_label" maxlength="120"
        /></label>
      </div>
      <template v-if="form.kind === 'issue' || form.kind === 'transfer'">
        <div class="flow-grid">
          <label
            >接收对象<select
              v-model="form.to_party_id"
              :disabled="responsibility"
            >
              <option :value="null">请选择个人或团队</option>
              <option
                v-for="party in parties"
                :key="party.id"
                :value="party.id"
              >
                {{ partyLabel(party) }}
              </option>
            </select></label
          >
          <label
            >接收负责人<select
              v-model="form.to_person_id"
              :disabled="target?.kind === 'person'"
            >
              <option :value="null">请选择个人</option>
              <option
                v-for="person in people"
                :key="person.id"
                :value="person.id"
              >
                {{ partyLabel(person) }}
              </option>
            </select></label
          >
          <label v-if="assignsUsage"
            >使用方式<select v-model="form.usage_kind">
              <option value="long_term">长期使用</option>
              <option value="temporary">临时使用</option>
            </select></label
          >
          <label v-if="assignsUsage && form.usage_kind === 'temporary'"
            >预计归还日期<input
              v-model="form.due_on"
              type="date"
              :min="form.handover_on || undefined"
          /></label>
        </div>
        <PartyQuickCreate
          v-if="!responsibility"
          v-model:busy="partyBusy"
          :people="people"
          :allowed="flowWriteAccess"
          :disabled="busy || reviewing"
          @created="createdParty"
        />
      </template>
      <label
        >{{ form.kind === "return" ? "退回原因（必填）" : "用途或备注"
        }}<textarea v-model="form.remarks" maxlength="2000" />
      </label>
      <p v-if="form.kind === 'transfer'" class="hint">
        普通转交重新确定使用期限；同团队负责人交接保留当前分配和逐件期限，不处理或清除故障。
      </p>
      <template v-if="form.kind === 'receipt'">
        <h2>添加新领入设备</h2>
        <div class="flow-grid">
          <label
            >批量设备名称<input
              v-model="template.name"
              maxlength="120" /></label
          ><label
            >批量设备分类<select v-model="template.category">
              <option value="">请选择分类</option>
              <option
                v-for="(label, key) in categories"
                :key="key"
                :value="key"
              >
                {{ label }}
              </option>
            </select></label
          >
          <label
            >批量品牌<input v-model="template.brand" maxlength="120" /></label
          ><label
            >批量型号<input v-model="template.model" maxlength="120"
          /></label>
          <label
            >数量<input
              v-model.number="template.count"
              type="number"
              min="1"
              max="100" /></label
          ><label
            >批量实际状况<select v-model="template.condition">
              <option value="">请核对状况</option>
              <option value="normal">正常</option>
              <option value="faulty">故障</option>
            </select></label
          >
          <label
            >批量存放位置<input
              v-model="template.location"
              maxlength="120" /></label
          ><label
            >批量状况说明<input v-model="template.note" maxlength="2000"
          /></label>
        </div>
        <button type="button" class="quiet" @click="expand">
          展开为逐件明细
        </button>
      </template>
      <h2 class="refresh">
        {{
          form.kind === "receipt" ? "或选择已退上游的原设备领回" : "选择设备"
        }}
      </h2>
      <div class="flow-grid">
        <label>搜索可选设备<input v-model="search" maxlength="120" /></label
        ><button type="button" class="quiet" @click="refreshAssets">
          刷新设备清单
        </button>
      </div>
      <div class="asset-picker">
        <label v-for="asset in available" :key="asset.id" class="checkbox-row"
          ><input
            type="checkbox"
            :checked="selectedIds.has(asset.id)"
            @change="toggle(asset)"
          /><span
            >{{ asset.asset_code }} · {{ asset.name }}
            {{
              asset.legacy_code ? "（旧号：" + asset.legacy_code + "）" : ""
            }}</span
          ></label
        >
        <p v-if="!available.length">暂无符合条件的可选设备。</p>
      </div>
      <h2 class="refresh">已选 {{ items.length }} 件设备</h2>
      <article v-for="(item, index) in items" :key="item.key" class="flow-item">
        <h3>第 {{ index + 1 }} 件 · {{ itemLabel(item) }}</h3>
        <p v-if="responsibility && selectedAsset(item)" class="hint">
          保留原起始日期：{{
            selectedAsset(item)?.started_on || "未知"
          }}；预计归还：{{ dueLabel(selectedAsset(item)!) }}。
        </p>
        <div v-if="item.new_asset_data" class="flow-grid">
          <label
            >名称<input
              v-model="item.new_asset_data.name"
              maxlength="120" /></label
          ><label
            >分类<select v-model="item.new_asset_data.category">
              <option
                v-for="(label, key) in categories"
                :key="key"
                :value="key"
              >
                {{ label }}
              </option>
            </select></label
          >
          <label
            >原资产编号<input
              v-model="item.new_asset_data.legacy_code"
              maxlength="120" /></label
          ><label
            >出厂序列号<input
              v-model="item.new_asset_data.serial_number"
              maxlength="120"
          /></label>
          <label
            >品牌<input
              v-model="item.new_asset_data.brand"
              maxlength="120" /></label
          ><label
            >型号<input v-model="item.new_asset_data.model" maxlength="120"
          /></label>
          <label
            >设备备注<textarea
              v-model="item.new_asset_data.note"
              maxlength="2000"
            />
          </label>
        </div>
        <div class="flow-grid">
          <label
            >实际交接状况<select
              v-model="item.condition_on_handover"
              :disabled="form.kind === 'issue' || form.kind === 'transfer'"
            >
              <option :value="null">请核对状况</option>
              <option value="normal">正常</option>
              <option value="faulty">故障</option>
            </select></label
          ><label
            >交接后位置<input v-model="item.location" maxlength="120" /></label
          ><label
            >交接说明<textarea v-model="item.note" maxlength="2000" />
          </label>
        </div>
        <label v-if="item.new_asset_data" class="checkbox-row"
          ><input v-model="item.allow_legacy_duplicate" type="checkbox" /><span
            >已核对：如旧编号重复，本件为另一件实物，允许单独建账。</span
          ></label
        >
        <button
          type="button"
          class="quiet danger"
          @click="items.splice(index, 1)"
        >
          移除第 {{ index + 1 }} 件
        </button>
      </article>
      <ActionGroup class="links">
        <button type="button" @click="save(false)">保存草稿</button
        ><button type="button" @click="save(true)">保存并核对交接</button>
      </ActionGroup>
    </fieldset>
    <section v-if="reviewing && draft" class="notice" aria-label="交接确认">
      <h2>请核对实际交接</h2>
      <p>
        {{ flowKinds[draft.kind] }} {{ draft.items.length }} 件；交接日期
        {{ draft.handover_on }}。移交人：{{ draft.sender_name }}；接收人：{{
          draft.receiver_name
        }}。
      </p>
      <p>
        交出方：{{
          draft.from_kind === "inventory"
            ? "经办人库存"
            : draft.from_kind === "external"
              ? draft.from_label
              : sources.find((p) => p.id === draft?.from_party_id)?.name
        }}；接收方：{{
          draft.to_kind === "inventory"
            ? "经办人库存"
            : draft.to_kind === "external"
              ? draft.to_label
              : parties.find((p) => p.id === draft?.to_party_id)?.name
        }}。
      </p>
      <p v-if="draft.usage_kind">
        {{
          draft.usage_kind === "temporary"
            ? "临时使用，预计归还：" + draft.due_on
            : "长期使用"
        }}。
      </p>
      <p v-if="draft.kind === 'transfer'">
        {{ transferModes[draft.transfer_mode || "holder"] }}
      </p>
      <p v-if="responsibility">
        只交接所选设备的负责人，保留当前分配、原起始日期和各自期限，故障状况不变。
      </p>
      <p>确认后更新设备去向、历史并生成正式单号。打印不会重复办理。</p>
      <ActionGroup class="links">
        <button type="button" :disabled="busy" @click="confirm">
          {{ busy ? "正在确认…" : "确认实际交接" }}</button
        ><button
          type="button"
          class="quiet"
          :disabled="busy"
          @click="reviewing = false"
        >
          返回修改
        </button>
      </ActionGroup>
    </section>
  </section>
  <FlowGate v-else title="流转办理" />
</template>
