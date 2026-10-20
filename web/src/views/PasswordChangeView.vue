<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { onBeforeUnmount, ref, watch } from "vue";
import {
  account,
  accountAccess,
  finishPasswordChange,
  safeError,
} from "../accounts";
import { createPasswordChangeFlow } from "../password-change";
import PasswordFields from "../components/PasswordFields.vue";
import ActionGroup from "../components/ActionGroup.vue";
const flow = createPasswordChangeFlow();
const currentPassword = ref(""),
  password = ref(""),
  confirmation = ref("");
const accepted = ref(false),
  busy = ref(false),
  error = ref("");
let generation = 0;
function clear() {
  generation++;
  currentPassword.value = "";
  password.value = "";
  confirmation.value = "";
  accepted.value = false;
  busy.value = false;
  error.value = "";
  void flow.cancel();
}
watch([accountAccess, () => account.profile?.membership?.id], clear, {
  flush: "sync",
});
onBeforeUnmount(clear);
async function save() {
  if (!accountAccess.value || busy.value) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    const identity = await flow.update(
      currentPassword.value,
      password.value,
      confirmation.value,
      accepted.value,
    );
    if (current !== generation || !accountAccess.value) return;
    account.message = "密码已更新，请使用新密码重新登录。";
    await finishPasswordChange(identity);
  } catch (failure) {
    if (current === generation && accountAccess.value)
      error.value = safeError(failure);
  } finally {
    currentPassword.value = "";
    password.value = "";
    confirmation.value = "";
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section class="card narrow">
    <h1>修改密码</h1>
    <form v-if="accountAccess" class="stack" @submit.prevent="save">
      <FormField
        label="当前密码"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        required
        :disabled="busy"
      />
      <PasswordFields
        v-model:password="password"
        v-model:confirmation="confirmation"
        v-model:accepted="accepted"
        :disabled="busy"
      />
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <p class="hint">
        提交前会重新验证当前密码。若提交时连接中断，密码可能已更新，请先尝试新密码登录；系统不会自动重复修改。
      </p>
      <ActionGroup
        ><button type="submit" :disabled="busy">
          {{ busy ? "正在修改…" : "确认修改密码" }}</button
        ><RouterLink to="/account">返回我的账号</RouterLink
        ><RouterLink v-if="account.recoveryEnabled" to="/recover"
          >忘记当前密码</RouterLink
        ></ActionGroup
      >
    </form>
    <template v-else
      ><p>仅已验证、已启用的登录账号可以主动修改密码。</p>
      <RouterLink to="/login">前往登录</RouterLink></template
    >
  </section>
</template>
