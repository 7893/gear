<script setup lang="ts">
import { account } from "../accounts";
import { inventoryAccess } from "../inventory";
import AuthView from "./AuthView.vue";
import InventoryView from "./InventoryView.vue";
import StatusView from "./StatusView.vue";
</script>
<template>
  <InventoryView v-if="inventoryAccess" /><StatusView
    v-else-if="
      account.signedIn || account.callbackPending || account.restoringSession
    "
  /><AuthView v-else mode="login" />
</template>
