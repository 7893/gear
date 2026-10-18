<script setup lang="ts">
import { ref } from "vue";
import {
  account,
  apply,
  refreshProfile,
  safeError,
  roleLabels,
  statusLabels,
} from "../accounts";
const displayName = ref("");
const busy = ref(false);
const error = ref("");
async function submit() {
  busy.value = true;
  error.value = "";
  try {
    await apply(displayName.value);
  } catch (failure) {
    error.value = safeError(failure);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="card narrow">
    <p class="eyebrow">设备簿</p>
    <h1>我的账号</h1>
    <p v-if="account.loading">正在核对账号状态…</p>
    <template v-else-if="!account.signedIn"
      ><p class="muted">登录后可查看使用申请和账号状态。</p>
      <RouterLink class="button" to="/login">前往登录</RouterLink></template
    >
    <template v-else-if="account.profile">
      <p class="muted">{{ account.profile.email }}</p>
      <p v-if="!account.profile.email_verified">请先完成邮箱验证。</p>
      <form v-else-if="!account.profile.membership" @submit.prevent="submit">
        <p>邮箱已验证，请填写姓名并提交使用申请。</p>
        <label
          >姓名<input
            v-model="displayName"
            autocomplete="name"
            required
            maxlength="80"
        /></label>
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <button type="submit" :disabled="busy">提交使用申请</button>
      </form>
      <template v-else>
        <p class="status-badge">
          {{ statusLabels[account.profile.membership.status] }}
        </p>
        <h2>{{ account.profile.membership.display_name }}</h2>
        <p v-if="account.profile.membership.status === 'pending'">
          申请已提交，等待管理员审核。审核前无法查看设备信息。
        </p>
        <p v-else-if="account.profile.membership.status === 'rejected'">
          本次申请未通过，如需重新申请，请联系管理员。
        </p>
        <p v-else-if="account.profile.membership.status === 'disabled'">
          账号已停用，如需恢复，请联系管理员。
        </p>
        <template v-else
          ><p>
            当前权限：{{
              account.profile.membership.role
                ? roleLabels[account.profile.membership.role]
                : ""
            }}
          </p>
          <RouterLink
            v-if="account.inventoryEnabled"
            class="button"
            to="/assets"
            >查看设备台账</RouterLink
          >
          <p v-else class="muted">账号已启用。设备台账将在下一步接入。</p>
          <RouterLink
            v-if="account.profile.membership.role === 'admin'"
            class="button"
            to="/members"
            >管理使用申请</RouterLink
          ></template
        >
        <p v-if="account.profile.membership.review_note" class="muted">
          处理说明：{{ account.profile.membership.review_note }}
        </p>
      </template>
      <button
        class="quiet refresh"
        type="button"
        :disabled="account.loading"
        @click="refreshProfile"
      >
        刷新账号状态
      </button>
    </template>
    <button v-else class="quiet" type="button" @click="refreshProfile">
      重新获取账号状态
    </button>
  </section>
</template>
