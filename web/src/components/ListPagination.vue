<script setup lang="ts" generic="T">
import { computed, ref, watch } from "vue";
import { pageSizes } from "../pagination";
import ActionGroup from "./ActionGroup.vue";
const props = defineProps<{ items: T[]; label: string }>();
const pageSize = defineModel<number>("pageSize", { required: true });
defineSlots<{ default(props: { items: T[] }): unknown }>();
const page = ref(1);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(props.items.length / pageSize.value)),
);
const pageStart = computed(() =>
  props.items.length ? (page.value - 1) * pageSize.value + 1 : 0,
);
const pageEnd = computed(() =>
  Math.min(page.value * pageSize.value, props.items.length),
);
const visibleItems = computed(() =>
  props.items.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);
watch([() => props.items, pageSize], () => (page.value = 1));
watch(pageCount, (count) => (page.value = Math.min(page.value, count)));
</script>
<template>
  <nav class="inventory-pagination" :aria-label="label">
    <label
      >每页显示<select v-model.number="pageSize">
        <option v-for="size in pageSizes" :key="size" :value="size">
          {{ size }} 条
        </option>
      </select></label
    >
    <p role="status">
      第 {{ page }} / {{ pageCount }} 页<span v-if="items.length"
        >，显示第 {{ pageStart }} 至 {{ pageEnd }} 条</span
      >，共 {{ items.length }} 条
    </p>
    <ActionGroup class="pagination-actions">
      <button
        class="quiet"
        type="button"
        :disabled="page === 1"
        @click="page = 1"
      >
        首页
      </button>
      <button
        class="quiet"
        type="button"
        :disabled="page === 1"
        @click="page--"
      >
        上一页
      </button>
      <button
        class="quiet"
        type="button"
        :disabled="page >= pageCount"
        @click="page++"
      >
        下一页
      </button>
      <button
        class="quiet"
        type="button"
        :disabled="page >= pageCount"
        @click="page = pageCount"
      >
        末页
      </button>
    </ActionGroup>
  </nav>
  <slot :items="visibleItems" />
</template>
