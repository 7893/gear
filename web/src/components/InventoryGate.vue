<script setup lang="ts">
import { useRoute } from "vue-router";
import { account } from "../accounts";
import { returnPath } from "../references";
import ActionGroup from "./ActionGroup.vue";
defineProps<{ title?: string }>();
const route = useRoute();
</script>
<template>
  <section class="card narrow">
    <h1>{{ title || "设备台账" }}</h1>
    <p v-if="account.initializing && account.restoringSession">
      正在连接账号服务…
    </p>
    <p v-else-if="!account.inventoryEnabled">设备台账尚未开放。</p>
    <p v-else-if="account.loading">正在核对账号权限…</p>
    <p v-else>当前账号无法执行此操作，请登录或查看账号状态。</p>
    <ActionGroup class="links">
      <RouterLink
        v-if="!account.signedIn"
        class="button"
        :to="
          returnPath(route.fullPath)
            ? { path: '/login', query: { next: route.fullPath } }
            : '/login'
        "
        >前往登录</RouterLink
      >
      <RouterLink
        :class="account.signedIn ? 'button' : 'button quiet'"
        to="/account"
        >查看我的账号</RouterLink
      >
    </ActionGroup>
  </section>
</template>
