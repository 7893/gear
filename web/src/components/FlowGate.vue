<script setup lang="ts">
import { account } from "../accounts";
defineProps<{ title?: string }>();
</script>
<template>
  <section class="card narrow">
    <h1>{{ title || "流转与单据" }}</h1>
    <p v-if="account.initializing">正在连接账号服务…</p>
    <p v-else-if="!account.flowsEnabled">流转办理与单据尚未开放。</p>
    <p v-else-if="account.loading">正在核对账号权限…</p>
    <p v-else>当前账号无法执行此操作，请登录或查看账号状态。</p>
    <RouterLink to="/account">查看我的账号</RouterLink>
  </section>
</template>
