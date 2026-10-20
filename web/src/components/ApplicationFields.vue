<script setup lang="ts">
import { computed, ref } from "vue";
import FormField from "./FormField.vue";
import {
  applicationNameError,
  applicationNameMessage,
  applicationPhoneError,
  applicationPhoneMessage,
  mainlandMobilePattern,
} from "../application-validation";

const displayName = defineModel<string>("displayName", { required: true });
const contactPhone = defineModel<string>("contactPhone", { required: true });
defineProps<{ disabled?: boolean }>();
const nameTouched = ref(false);
const phoneTouched = ref(false);
const nameError = computed(() =>
  nameTouched.value || displayName.value
    ? applicationNameError(displayName.value)
    : "",
);
const phoneError = computed(() =>
  phoneTouched.value || contactPhone.value
    ? applicationPhoneError(contactPhone.value)
    : "",
);
</script>
<template>
  <FormField
    label="姓名"
    v-model="displayName"
    name="display-name"
    autocomplete="name"
    required
    minlength="2"
    maxlength="80"
    :disabled="disabled"
    :error="nameError"
    :validation-message="applicationNameError(displayName)"
    :hint="applicationNameMessage"
    @blur="nameTouched = true"
  />
  <FormField
    label="手机号"
    v-model="contactPhone"
    name="contact-phone"
    type="tel"
    inputmode="numeric"
    autocomplete="tel-national"
    required
    minlength="11"
    maxlength="11"
    :pattern="mainlandMobilePattern"
    :disabled="disabled"
    :error="phoneError"
    :validation-message="applicationPhoneError(contactPhone)"
    :hint="applicationPhoneMessage + ' 仅作联系方式，不验证号码归属。'"
    @blur="phoneTouched = true"
  />
</template>
