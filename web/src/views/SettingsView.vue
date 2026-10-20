<script setup lang="ts">
import QueryState from "../components/QueryState.vue";
import { adminAccess } from "../accounts";
import { useUnitSettings } from "../useUnitSettings";
import { timestamp } from "../inventory";
import DocumentHeaderForm from "../components/DocumentHeaderForm.vue";
import ActionGroup from "../components/ActionGroup.vue";
import DueSettingsForm from "../components/DueSettingsForm.vue";
const {
  data,
  error,
  loading,
  load,
  disabled,
  busy,
  saveError,
  notice,
  saveHeader,
  saveDue,
} = useUnitSettings();
</script>
<template>
  <section class="card narrow">
    <h1>单位设置</h1>
    <template v-if="adminAccess">
      <ActionGroup
        ><button
          class="quiet"
          type="button"
          :disabled="loading || busy"
          @click="load"
        >
          刷新设置
        </button></ActionGroup
      >
      <p v-if="notice" role="status">{{ notice }}</p>
      <QueryState
        :loading="loading"
        :error="error"
        loading-text="正在读取设置…"
        retry-label=""
      />
      <p v-if="saveError" class="notice error" role="alert">{{ saveError }}</p>
      <template v-if="data"
        ><DocumentHeaderForm
          :settings="data.header"
          :disabled="disabled"
          :busy="busy"
          :submit-changes="saveHeader"
        />
        <DueSettingsForm
          :settings="data.due"
          :disabled="disabled"
          :submit-changes="saveDue"
        />
        <h2>修改历史</h2>
        <ol v-if="data.header.history.length" class="asset-history">
          <li v-for="entry in data.header.history" :key="entry.id">
            <p>
              {{ timestamp(entry.recorded_at) }}（东八区）；经办人：{{
                entry.actor_label
              }}
            </p>
            <p class="preserve-text">
              {{ entry.before_header }} → {{ entry.after_header }}
            </p>
            <p class="preserve-text">原因：{{ entry.reason }}</p>
          </li>
        </ol>
        <p v-else>暂无单位抬头修改记录。</p>
      </template> </template
    ><template v-else
      ><p>仅有效管理员可以查看和修改单位设置。</p>
      <RouterLink to="/account">查看我的账号</RouterLink></template
    >
  </section>
</template>
