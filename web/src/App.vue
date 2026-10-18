<script setup lang="ts">
import { account, signOut, safeError } from "./accounts";
import { inventoryAccess } from "./inventory";
import { flowAccess, flowWriteAccess } from "./flows";
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
        <RouterLink v-if="flowWriteAccess" to="/flows">流转办理</RouterLink>
        <RouterLink v-if="flowAccess" to="/documents">单据记录</RouterLink>
        <RouterLink to="/account">我的账号</RouterLink>
        <RouterLink
          v-if="
            account.profile?.email_verified &&
            account.profile.membership?.status === 'active' &&
            account.profile.membership.role === 'admin'
          "
          to="/members"
          >账号管理</RouterLink
        >
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
    <p v-if="!account.enabled" class="notice">
      账号服务尚未开放，暂不能注册或登录。
    </p>
    <RouterView />
  </main>
</template>
