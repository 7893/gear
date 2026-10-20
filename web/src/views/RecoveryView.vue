<script setup lang="ts">
import FormField from "../components/FormField.vue";
import { onBeforeUnmount, ref } from "vue";
import { account, safeError } from "../accounts";
import PasswordFields from "../components/PasswordFields.vue";
import ActionGroup from "../components/ActionGroup.vue";
import { createRecoveryFlow } from "../recovery";
const flow = createRecoveryFlow();
const stage = ref<"request" | "verify" | "password" | "done">("request");
const email = ref("");
const code = ref("");
const password = ref("");
const confirmation = ref("");
const accepted = ref(false);
const busy = ref(false);
const notice = ref("");
const error = ref("");
async function submit(existingCode = false) {
  if (busy.value || !account.enabled || !account.recoveryEnabled) return;
  busy.value = true;
  error.value = "";
  try {
    if (stage.value === "request") {
      if (existingCode) await flow.useExistingCode(email.value);
      else await flow.request(email.value);
      stage.value = "verify";
      notice.value = existingCode
        ? "请输入已收到的六位找回验证码。"
        : "若该邮箱对应已验证、已启用的账号，将收到六位验证码，请在此输入。";
    } else if (stage.value === "verify") {
      await flow.verify(code.value);
      stage.value = "password";
      notice.value = "验证通过，请设置新密码。";
    } else if (stage.value === "password") {
      await flow.update(password.value, confirmation.value, accepted.value);
      stage.value = "done";
      notice.value = "密码已更新，请使用新密码重新登录。";
    }
  } catch (failure) {
    error.value = safeError(failure);
  } finally {
    code.value = "";
    password.value = "";
    confirmation.value = "";
    busy.value = false;
  }
}
async function restart() {
  if (busy.value) return;
  busy.value = true;
  await flow.cancel();
  stage.value = "request";
  notice.value = "";
  error.value = "";
  accepted.value = false;
  busy.value = false;
}
onBeforeUnmount(() => {
  void flow.cancel();
});
async function returnToLogin(event: MouseEvent) {
  event.preventDefault();
  if (busy.value) return;
  await flow.cancel();
  window.location.assign("/#/login");
}
</script>
<template>
  <section class="card narrow">
    <p class="eyebrow">设备簿</p>
    <h1>找回密码</h1>
    <p v-if="!account.recoveryEnabled" class="notice">
      密码找回尚未开放，请联系管理员。
    </p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <form v-if="stage !== 'done'" @submit.prevent="submit()">
      <FormField
        label="注册邮箱"
        v-model="email"
        type="email"
        autocomplete="email"
        maxlength="254"
        required
        :readonly="stage !== 'request'"
      />
      <FormField
        label="验证码"
        v-model="code"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{6}"
        minlength="6"
        maxlength="6"
        required
        v-if="stage === 'verify'"
      />
      <PasswordFields
        v-if="stage === 'password'"
        v-model:password="password"
        v-model:confirmation="confirmation"
        v-model:accepted="accepted"
        :disabled="busy"
      />
      <ActionGroup>
        <button
          :disabled="busy || !account.enabled || !account.recoveryEnabled"
          type="submit"
        >
          {{
            busy
              ? "处理中…"
              : stage === "request"
                ? "发送找回验证码"
                : stage === "verify"
                  ? "验证找回验证码"
                  : "设置新密码"
          }}
        </button>
        <button
          v-if="stage === 'request'"
          class="quiet"
          type="submit"
          :disabled="busy || !account.enabled || !account.recoveryEnabled"
          @click.prevent="
            (
              $event.currentTarget as HTMLButtonElement
            ).form?.reportValidity() && submit(true)
          "
        >
          已有找回验证码
        </button>
      </ActionGroup>
    </form>
    <p v-if="stage === 'password'" class="hint">
      请在本页完成操作。若提交时连接中断，密码可能已更新，可尝试使用新密码登录。
    </p>
    <ActionGroup class="links">
      <button
        v-if="stage === 'verify' || stage === 'password'"
        class="quiet"
        type="button"
        :disabled="busy"
        @click="restart"
      >
        重新发送或更换邮箱
      </button>
      <a href="/#/login" @click="returnToLogin">返回登录</a>
    </ActionGroup>
  </section>
</template>
