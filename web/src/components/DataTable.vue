<script setup lang="ts" generic="T extends { id: string }">
import type { TableColumn } from "../table";
defineProps<{ items: T[]; columns: readonly TableColumn<T>[] }>();
defineSlots<{ [key: string]: (props: { row: T }) => unknown }>();
function cell(row: T, column: TableColumn<T>) {
  return column.value ? column.value(row) : row[column.key as keyof T];
}
function isMutedValue(val: unknown) {
  const text = String(val ?? "").trim();
  return ["未填写", "不适用", "型号未填写", "无", "未知"].includes(text);
}
</script>
<template>
  <div class="data-list" role="table">
    <div class="data-list-header" role="rowgroup">
      <div
        class="data-header-row"
        role="row"
        :style="{ '--col-count': columns.length }"
      >
        <span
          v-for="column in columns"
          :key="column.key"
          class="data-header-cell"
          role="columnheader"
        >
          {{ column.label }}
        </span>
      </div>
    </div>
    <div class="data-list-body" role="rowgroup">
      <article
        v-for="row in items"
        :key="row.id"
        class="data-card-row"
        role="row"
        :style="{ '--col-count': columns.length }"
      >
        <div
          v-for="column in columns"
          :key="column.key"
          class="data-cell"
          :class="[
            'data-cell-' + column.key,
            { 'is-muted-cell': isMutedValue(cell(row, column)) },
          ]"
          role="cell"
          :data-label="column.label"
        >
          <slot :name="column.key" :row="row">{{ cell(row, column) }}</slot>
        </div>
      </article>
    </div>
  </div>
</template>
