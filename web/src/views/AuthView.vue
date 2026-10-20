<script setup lang="ts">
import FormField from "../components/FormField.vue";
import ApplicationFields from "../components/ApplicationFields.vue";
import { computed, ref, watch } from "vue";
import ActionGroup from "../components/ActionGroup.vue";
import { returnPath } from "../references";
import { useRoute, useRouter } from "vue-router";
import {
  account,
  register,
  signIn,
  verifyEmail,
  resendVerification,
  safeError,
} from "../accounts";
const props = defineProps<{ mode: "login" | "register" | "verify" }>();
const router = useRouter();
const route = useRoute();
const email = ref("");
const password = ref("");
const displayName = ref("");
const contactPhone = ref("");
const token = ref("");
const busy = ref(false);
const notice = ref("");
const error = ref("");
const title = computed(
  () =>
    ({ login: "登录设备簿", register: "申请使用设备簿", verify: "验证邮箱" })[
      props.mode
    ],
);
watch(
  () => props.mode,
  () => {
    password.value = "";
    token.value = "";
    notice.value = "";
    error.value = "";
  },
);
async function submit() {
  if (busy.value || !account.enabled) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (props.mode === "login") {
      await signIn(email.value, password.value);
      await router.push(returnPath(route.query.next) || "/");
    } else if (props.mode === "register") {
      await register(
        displayName.value,
        email.value,
        password.value,
        contactPhone.value,
      );
      await router.push("/verify");
      notice.value =
        "若该邮箱可以注册，将收到六位纯数字验证码，请在此输入；已有账号请直接登录。";
    } else {
      await verifyEmail(email.value, token.value);
      await router.push("/");
    }
  } catch (failure) {
    error.value =
      props.mode === "login"
        ? "登录未完成，请核对邮箱和密码，或先完成邮箱验证。"
        : safeError(failure);
  } finally {
    password.value = "";
    token.value = "";
    busy.value = false;
  }
}
async function resend() {
  if (busy.value || !email.value.trim() || !account.enabled) return;
  busy.value = true;
  error.value = "";
  try {
    await resendVerification(email.value);
    notice.value = "若该邮箱需要验证，将收到新的验证邮件，请稍后查收。";
  } catch {
    error.value = "暂时无法发送验证邮件，请稍后再试。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="card narrow">
    <p class="eyebrow">设备簿</p>
    <h1>{{ title }}</h1>
    <p v-if="mode === 'register'" class="muted">
      验证邮箱后提交使用申请，经管理员审核后开放设备信息。
    </p>
    <p v-else-if="mode === 'verify'" class="muted">
      输入注册邮箱和邮件中的六位纯数字验证码。
    </p>
    <form @submit.prevent="submit">
      <ApplicationFields
        v-model:display-name="displayName"
        v-model:contact-phone="contactPhone"
        :disabled="busy"
        v-if="mode === 'register'"
      />
      <FormField
        label="邮箱"
        v-model="email"
        name="email"
        type="email"
        autocomplete="email"
        required
        maxlength="254"
      />
      <FormField
        label="密码"
        v-model="password"
        name="password"
        type="password"
        :autocomplete="
          mode === 'register' ? 'new-password' : 'current-password'
        "
        required
        :minlength="mode === 'register' ? 12 : 1"
        maxlength="128"
        v-if="mode !== 'verify'"
      />
      <p v-if="mode === 'register'" class="hint">
        建议使用密码管理器生成至少 12
        个字符的密码；已有共享账号请使用原账号登录。
      </p>
      <FormField
        label="验证码"
        v-model="token"
        name="code"
        inputmode="numeric"
        autocomplete="one-time-code"
        required
        minlength="6"
        maxlength="6"
        pattern="[0-9]{6}"
        v-if="mode === 'verify'"
      />
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="busy || !account.enabled">
        {{
          busy
            ? "处理中…"
            : mode === "login"
              ? "登录"
              : mode === "register"
                ? "注册并验证邮箱"
                : "验证邮箱"
        }}
      </button>
    </form>
    <ActionGroup class="links">
      <RouterLink
        v-if="mode === 'login' && account.recoveryEnabled"
        to="/recover"
        >忘记密码</RouterLink
      >
      <RouterLink v-if="mode !== 'login'" to="/login"
        >已有账号，去登录</RouterLink
      ><RouterLink v-if="mode === 'login'" to="/register">申请使用</RouterLink>
      <RouterLink v-if="mode !== 'verify'" to="/verify">验证邮箱</RouterLink
      ><button
        v-else
        class="quiet"
        type="button"
        :disabled="busy || !email || !account.enabled"
        @click="resend"
      >
        重新发送
      </button>
    </ActionGroup>
  </section>
</template>
