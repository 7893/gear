<script setup lang="ts">
import { inventoryAccess } from "../inventory";
import InventoryView from "./InventoryView.vue";
import StatusView from "./StatusView.vue";
</script>
<template>
  <InventoryView v-if="inventoryAccess" /><StatusView v-else />
</template>
