<script setup lang="ts">
import FormField from "./FormField.vue";
import { computed, ref } from "vue";
import {
  inventoryAccess,
  listPartyAssets,
  partyRelationships,
  type Party,
  type PartyRelationship,
} from "../inventory";
import { partyAssetsCsv } from "../inventory-export";
import { useAuthorizedQuery } from "../useAuthorizedQuery";
import ListExport from "./ListExport.vue";
import ListResults from "./ListResults.vue";
import AssetTable from "./AssetTable.vue";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ party: Party }>();
const relationship = ref<PartyRelationship>("holding");
const allowed = computed(() => inventoryAccess.value && !!props.party.id);
const query = () => listPartyAssets(props.party.id, relationship.value);
const { data, error, loading, load } = useAuthorizedQuery(allowed, query, [
  () => props.party.id,
  relationship,
]);
</script>
<template>
  <section aria-label="持有与关联设备">
    <h3>持有与关联设备</h3>
    <p>
      仅列当前在管的分配，停用接收对象的未归还设备仍保留。团队持有方、负责人和具体使用人分别核对；遗失、报废和已退回设备请查原设备历史。
    </p>
    <ActionGroup>
      <FormField
        label="清单范围"
        v-model="relationship"
        :disabled="loading"
        :options="partyRelationships"
        v-if="party.kind === 'person'"
      />
      <button class="quiet" type="button" :disabled="loading" @click="load">
        刷新持有清单
      </button>
    </ActionGroup>
    <ListExport
      :key="party.id + ':' + relationship"
      :allowed="allowed"
      :disabled="loading"
      label="导出持有清单 CSV"
      filename="持有与关联设备清单"
      :query="async () => partyAssetsCsv(await query())"
    />
    <ListResults
      :items="data?.items ?? null"
      :loading="loading"
      :error="error"
      loading-text="正在读取持有清单…"
      label="持有清单分页"
      empty-text="此范围暂无当前分配的设备。"
      @retry="load"
    >
      <template #summary v-if="data">
        <p>
          核对对象：{{ data.party.name }}；业务日期：{{
            data.business_on
          }}（东八区）；共 {{ data.matched }} 台。
        </p>
      </template>
      <template #default="{ items }"
        ><AssetTable :items="items" :party="party"
      /></template>
    </ListResults>
  </section>
</template>
