<script setup lang="ts" generic="T extends { id: string }">
import type { TableColumn } from "../table";
defineProps<{ items: T[]; columns: readonly TableColumn<T>[] }>();
defineSlots<{ [key: string]: (props: { row: T }) => unknown }>();
function cell(row: T, column: TableColumn<T>) {
  return column.value ? column.value(row) : row[column.key as keyof T];
}
</script>
<template>
  <div class="table-scroll">
    <table class="inventory-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.key">
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in items" :key="row.id">
          <td v-for="column in columns" :key="column.key">
            <slot :name="column.key" :row="row">{{ cell(row, column) }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
