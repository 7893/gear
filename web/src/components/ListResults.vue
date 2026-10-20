<script setup lang="ts" generic="T">
import { ref } from "vue";
import { defaultPageSize } from "../pagination";
import QueryState from "./QueryState.vue";
import ListPagination from "./ListPagination.vue";
defineProps<{
  items: T[] | null;
  label: string;
  loading: boolean;
  error: string;
  loadingText: string;
  emptyText?: string;
  retryLabel?: string;
}>();
defineEmits<{ retry: [] }>();
defineSlots<{
  default(props: { items: T[] }): unknown;
  summary?(): unknown;
  empty?(): unknown;
  footer?(): unknown;
}>();
const pageSize = ref(defaultPageSize);
</script>
<template>
  <QueryState
    :loading="loading && !items"
    :error="error"
    :loading-text="loadingText"
    :retry-label="retryLabel"
    @retry="$emit('retry')"
  >
    <template v-if="items">
      <p class="query-update muted" role="status" aria-live="polite">
        {{ loading ? "正在更新…" : error ? "更新未完成，请重试。" : "" }}
      </p>
      <slot name="summary" />
      <ListPagination
        v-model:page-size="pageSize"
        :items="items"
        :label="label"
        v-slot="{ items: pageItems }"
      >
        <slot v-if="pageItems.length" :items="pageItems" />
        <slot v-else name="empty"
          ><p>{{ emptyText || "暂无符合条件的记录。" }}</p></slot
        >
      </ListPagination>
      <slot name="footer" />
    </template>
  </QueryState>
</template>
