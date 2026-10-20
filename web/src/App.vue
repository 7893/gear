<script setup lang="ts">
import { computed } from "vue";
import { account, adminAccess, signOut, safeError } from "./accounts";
import { inventoryAccess } from "./inventory";
import { flowAccess, flowWriteAccess } from "./flows";
// Vue owns the bounded, memory-only page cache; never persist private records.
const pageOwner = computed(() =>
  JSON.stringify([
    account.signedIn,
    account.profile?.email,
    account.profile?.membership?.id,
    account.profile?.membership?.status,
    account.profile?.membership?.role,
  ]),
);
async function logout() {
  try {
    await signOut();
  } catch (error) {
    account.error = safeError(error);
  }
}
</script>
<template>
  <header class="site-header">
    <RouterLink to="/" class="brand">设备簿 <span>gear</span></RouterLink>
    <nav aria-label="主导航">
      <template v-if="account.signedIn">
        <RouterLink v-if="inventoryAccess" to="/assets">设备台账</RouterLink>
        <RouterLink v-if="inventoryAccess" to="/due">临时使用与到期</RouterLink>
        <RouterLink v-if="inventoryAccess" to="/parties">人员与团队</RouterLink>
        <RouterLink v-if="flowWriteAccess" to="/flows">流转办理</RouterLink>
        <RouterLink v-if="flowAccess" to="/documents">单据记录</RouterLink>
        <RouterLink v-if="flowAccess" to="/documents?evidence=awaiting_upload"
          >签字件待办</RouterLink
        >
        <RouterLink to="/account">我的账号</RouterLink>
        <RouterLink v-if="adminAccess" to="/members">账号管理</RouterLink>
        <RouterLink v-if="adminAccess" to="/settings">单位设置</RouterLink>
        <button class="quiet" type="button" @click="logout">退出登录</button>
      </template>
      <template v-else
        ><RouterLink to="/login">登录</RouterLink
        ><RouterLink to="/register">注册</RouterLink></template
      >
    </nav>
  </header>
  <main class="page">
    <p v-if="account.message" class="notice" role="status">
      {{ account.message }}
    </p>
    <p v-if="account.error" class="notice error" role="alert">
      {{ account.error }}
    </p>
    <p v-if="account.initializing" class="notice" role="status">
      正在连接账号服务…
    </p>
    <p v-else-if="!account.enabled" class="notice">
      账号服务尚未开放，暂不能注册或登录。
    </p>
    <RouterView v-slot="{ Component, route }">
      <KeepAlive
        :key="pageOwner"
        include="HomeView,InventoryView,DueView,PartiesView,DocumentsView"
        :max="6"
      >
        <component
          :is="Component"
          :key="route.meta.retain ? route.path : undefined"
        />
      </KeepAlive>
    </RouterView>
  </main>
</template>
