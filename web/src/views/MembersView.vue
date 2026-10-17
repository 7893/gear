<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  account,
  listMembers,
  setMemberAccess,
  refreshProfile,
  safeError,
  roleLabels,
  statusLabels,
  type Member,
  type MemberStatus,
  type Role,
} from "../accounts";
const members = ref<Member[]>([]);
const loading = ref(false);
const busyId = ref("");
const error = ref("");
const notice = ref("");
const choices = ref<Record<string, { role: Role; reason: string }>>({});
const retries = new Map<string, string>();
let generation = 0;
const isAdmin = computed(
  () =>
    account.profile?.email_verified &&
    account.profile?.membership?.status === "active" &&
    account.profile.membership.role === "admin",
);
async function load() {
  const current = ++generation;
  members.value = [];
  loading.value = true;
  error.value = "";
  try {
    const result = await listMembers();
    if (current !== generation || !isAdmin.value) return;
    members.value = result;
    choices.value = Object.fromEntries(
      result.map((member) => [
        member.id,
        { role: member.role || "viewer", reason: "" },
      ]),
    );
  } catch (failure) {
    if (current === generation) error.value = safeError(failure);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  isAdmin,
  (value) => {
    if (value) void load();
    else {
      generation++;
      members.value = [];
      choices.value = {};
      loading.value = false;
    }
  },
  { immediate: true },
);
async function review(member: Member, status: MemberStatus) {
  if (busyId.value || !isAdmin.value) return;
  const choice = choices.value[member.id];
  const role = status === "active" ? choice.role : null;
  if (
    role === "admin" &&
    member.role !== "admin" &&
    !window.confirm("将此账号设为管理员？管理员可以审核成员并管理系统权限。")
  )
    return;
  const signature = JSON.stringify([
    member.id,
    member.version,
    status,
    role,
    choice.reason.trim(),
  ]);
  const requestId = retries.get(signature) || crypto.randomUUID();
  retries.set(signature, requestId);
  busyId.value = member.id;
  error.value = "";
  notice.value = "";
  try {
    await setMemberAccess(member, status, role, choice.reason, requestId);
    retries.delete(signature);
    notice.value = "账号处理已保存。";
    await refreshProfile();
    if (isAdmin.value) await load();
  } catch (failure) {
    error.value = safeError(failure);
  } finally {
    busyId.value = "";
  }
}
</script>
<template>
  <section v-if="isAdmin" class="card">
    <div class="section-heading">
      <div>
        <p class="eyebrow">管理</p>
        <h1>账号管理</h1>
      </div>
      <button
        class="quiet"
        type="button"
        :disabled="loading || !!busyId"
        @click="load"
      >
        刷新列表
      </button>
    </div>
    <p class="muted">
      批准申请时默认为查询人。拒绝、停用、恢复和角色变更需填写原因。
    </p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="loading">正在读取账号列表…</p>
    <p v-else-if="!members.length">暂无使用申请。</p>
    <form
      v-for="member in members"
      :key="member.id"
      class="member-row"
      @submit.prevent
    >
      <div>
        <h2>{{ member.display_name }}</h2>
        <p class="muted">{{ member.email || "认证身份已不存在" }}</p>
        <span class="status-badge">{{ statusLabels[member.status] }}</span>
      </div>
      <label
        >角色<select
          v-model="choices[member.id].role"
          :disabled="member.status === 'rejected' || !!busyId"
        >
          <option v-for="(label, role) in roleLabels" :key="role" :value="role">
            {{ label }}
          </option>
        </select></label
      >
      <label
        >处理原因<input
          v-model="choices[member.id].reason"
          maxlength="500"
          :disabled="!!busyId"
      /></label>
      <div class="row-actions">
        <template v-if="member.status === 'pending'"
          ><button
            type="button"
            :disabled="!!busyId || !member.email_verified"
            @click="review(member, 'active')"
          >
            批准申请</button
          ><button
            class="quiet danger"
            type="button"
            :disabled="!!busyId"
            @click="review(member, 'rejected')"
          >
            拒绝
          </button></template
        >
        <template v-else-if="member.status === 'active'"
          ><button
            type="button"
            :disabled="!!busyId || choices[member.id].role === member.role"
            @click="review(member, 'active')"
          >
            保存角色</button
          ><button
            class="quiet danger"
            type="button"
            :disabled="!!busyId"
            @click="review(member, 'disabled')"
          >
            停用
          </button></template
        >
        <button
          v-else-if="member.status === 'disabled'"
          type="button"
          :disabled="!!busyId || !member.email_verified"
          @click="review(member, 'active')"
        >
          恢复使用</button
        ><button
          v-else
          class="quiet"
          type="button"
          :disabled="!!busyId"
          @click="review(member, 'pending')"
        >
          恢复待审核
        </button>
      </div>
    </form>
  </section>
  <section v-else class="card narrow">
    <h1>账号管理</h1>
    <p>仅管理员可以查看和处理使用申请。</p>
    <RouterLink to="/">返回我的账号</RouterLink>
  </section>
</template>
