<script setup lang="ts">
import QueryState from "../components/QueryState.vue";
import { recordCode } from "../references";
import { computed, ref, watch } from "vue";
import { account, inventoryRpc } from "../accounts";
import {
  inventoryWriteAccess,
  listParties,
  businessToday,
  categories,
} from "../inventory";
import {
  parseInventoryCsv,
  importHeaders,
  type ImportRow,
} from "../inventory-import";
import { downloadCsv } from "../csv";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import { useAuthorizedAction } from "../useAuthorizedAction";
import InventoryGate from "../components/InventoryGate.vue";
import ActionGroup from "../components/ActionGroup.vue";
import ListPagination from "../components/ListPagination.vue";
const {
  data: parties,
  error: readError,
  loading,
  load,
} = useAuthorizedQuery(inventoryWriteAccess, listParties);
const rows = ref<ImportRow[]>([]),
  problems = ref<string[]>([]),
  ack = ref(false),
  duplicate = ref(false),
  message = ref("");
const { busy, error, run, reset } = useAuthorizedAction(inventoryWriteAccess);
const pageSize = ref(20);
const previewRows = computed(() =>
  rows.value.map((row, index) => ({ row, line: index + 2 })),
);
let generation = 0;
function clear() {
  generation++;
  rows.value = [];
  problems.value = [];
  ack.value = false;
  duplicate.value = false;
  message.value = "";
  reset();
}
watch(
  [
    inventoryWriteAccess,
    () => account.profile?.membership?.id,
    () => account.profile?.membership?.role,
  ],
  clear,
  { flush: "sync" },
);
const allowed = computed(
  () =>
    inventoryWriteAccess.value &&
    !!parties.value &&
    rows.value.length > 0 &&
    !problems.value.length &&
    ack.value,
);
async function selected(event: Event) {
  clear();
  const current = generation;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !parties.value) return;
  if (file.size > 1048576) {
    problems.value = ["CSV 文件最多 1 MB。"];
    return;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    if (current !== generation || !inventoryWriteAccess.value) return;
    const parsed = parseInventoryCsv(text, parties.value, businessToday());
    rows.value = parsed.rows;
    problems.value = parsed.errors;
  } catch {
    if (current === generation)
      problems.value = [
        "文件不是有效 UTF-8 CSV，请在表格软件中另存为 CSV UTF-8。",
      ];
  }
}
function template() {
  downloadCsv(
    { headers: importHeaders, rows: [], businessOn: businessToday() },
    "已有设备导入模板",
  );
}
function references() {
  if (parties.value)
    downloadCsv(
      {
        headers: ["对象编码", "名称", "类型", "所属单位"],
        rows: parties.value.map((p) => [
          recordCode(p.kind === "team" ? "TM" : "PE", p),
          p.name,
          p.kind === "person" ? "个人" : p.kind === "team" ? "团队" : "交付方",
          p.organization_name || "",
        ]),
        businessOn: businessToday(),
      },
      "导入对象对照表",
    );
}
function apply() {
  if (!allowed.value) return;
  const payload = { rows: rows.value, allow_legacy_duplicate: duplicate.value };
  void run(
    payload,
    (id) =>
      inventoryRpc("import_assets", { ...payload, request_id: id }) as Promise<{
        imported: number;
      }>,
    (result) => {
      rows.value = [];
      ack.value = false;
      message.value = `已导入 ${result.imported} 台设备。可进入设备详情补传历史凭证。`;
    },
  );
}
</script>
<template>
  <section v-if="inventoryWriteAccess" class="card">
    <RouterLink to="/assets">返回设备台账</RouterLink>
    <h1>批量导入已有设备</h1>
    <p>
      用 Excel 等工具填写模板，另存为 CSV UTF-8。每行一台设备，最多 200
      台；只新增，不覆盖已有设备。起始日期不知道时留空，不补造交接单。对象按 ID
      区分，避免同名混淆。
    </p>
    <ActionGroup
      ><button class="quiet" type="button" :disabled="busy" @click="template">
        下载空白导入模板</button
      ><button
        class="quiet"
        type="button"
        :disabled="busy || !parties"
        @click="references"
      >
        下载对象 编码对照表</button
      ><RouterLink to="/parties">维护人员和团队</RouterLink></ActionGroup
    >
    <p class="hint">
      分类填写中文分类名称或分类代码，状况填“正常”或“故障”；使用类型填“长期”或“临时”；日期格式为
      YYYY-MM-DD。临时使用必须有预计归还日期。个人持有的负责人填同一个
      ID，库存设备的持有关系留空。
    </p>
    <p class="hint">可用分类：{{ Object.values(categories).join("、") }}。</p>
    <QueryState
      :loading="loading"
      :error="readError"
      loading-text="正在读取对象清单…"
      retry-label="重新读取对象"
      @retry="load"
    />
    <label
      >选择导入 CSV<input
        type="file"
        accept=".csv,text/csv"
        :disabled="busy || !parties"
        @change="selected"
    /></label>
    <ul v-if="problems.length" class="notice error" role="alert">
      <li v-for="problem in problems" :key="problem">{{ problem }}</li>
    </ul>
    <template v-if="rows.length"
      ><h2>导入预览（{{ rows.length }} 台）</h2>
      <p class="hint">
        预览只做文件校验；提交时还会核对最新权限、对象和重复编号，失败则整批不导入。设备编号允许因回滚出现空号。
      </p>
      <ListPagination
        :items="previewRows"
        label="导入预览分页"
        v-model:page-size="pageSize"
        v-slot="page"
        ><div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>行</th>
                <th>设备</th>
                <th>分类</th>
                <th>状况</th>
                <th>原编号</th>
                <th>持有方</th>
                <th>负责人</th>
                <th>具体使用人</th>
                <th>起始日期</th>
                <th>归还日期</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="{ row, line } in page.items" :key="line">
                <td>{{ line }}</td>
                <td>{{ row.details.name }}</td>
                <td>{{ categories[row.details.category] }}</td>
                <td>
                  {{ row.details.condition === "faulty" ? "故障" : "正常" }}
                </td>
                <td>{{ row.details.legacy_code || "未填写" }}</td>
                <td>
                  {{
                    parties?.find((p) => p.id === row.placement.holder_party_id)
                      ?.name || "库存"
                  }}
                </td>
                <td>
                  {{
                    parties?.find(
                      (p) => p.id === row.placement.responsible_person_id,
                    )?.name || "不适用"
                  }}
                </td>
                <td>
                  {{
                    parties?.find((p) => p.id === row.actual_user_id)?.name ||
                    "未填写"
                  }}
                </td>
                <td>{{ row.placement.known_on || "未知" }}</td>
                <td>{{ row.placement.due_on || "不适用" }}</td>
              </tr>
            </tbody>
          </table>
        </div></ListPagination
      >
      <form class="stack" @submit.prevent="apply">
        <label class="check"
          ><input
            v-model="duplicate"
            type="checkbox"
            :disabled="busy"
          />允许原资产编号重复（仍生成不同的内部编号）</label
        ><label class="check"
          ><input
            v-model="ack"
            type="checkbox"
            :disabled="busy"
          />已核对本批设备，确认尚未导入</label
        ><ActionGroup
          ><button type="submit" :disabled="!allowed || busy">
            {{ busy ? "正在导入…" : "确认整批导入" }}
          </button></ActionGroup
        >
      </form></template
    >
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">
      {{ message }} <RouterLink to="/assets">查看台账</RouterLink>
    </p>
  </section>
  <InventoryGate v-else title="批量导入已有设备" />
</template>
