<script setup lang="ts">
import FormField from "./FormField.vue";
import { passwordMinimum, passwordMaximum } from "../auth-support";
defineProps<{ disabled?: boolean }>();
const password = defineModel<string>("password", { required: true });
const confirmation = defineModel<string>("confirmation", { required: true });
const accepted = defineModel<boolean>("accepted", { required: true });
</script>
<template>
  <FormField
    label="新密码"
    v-model="password"
    type="password"
    autocomplete="new-password"
    :minlength="passwordMinimum"
    :maxlength="passwordMaximum"
    required
    :disabled="disabled"
  />
  <FormField
    label="再次输入新密码"
    v-model="confirmation"
    type="password"
    autocomplete="new-password"
    :minlength="passwordMinimum"
    :maxlength="passwordMaximum"
    required
    :disabled="disabled"
  />
  <p class="hint">
    此账号与同一认证服务的其他应用共享密码。修改后，这些应用也需使用新密码，并可能需要重新登录。
  </p>
  <label class="checkbox-row"
    ><input
      v-model="accepted"
      type="checkbox"
      required
      :disabled="disabled"
    />我理解并同意本次共享账号密码变更</label
  >
</template>
