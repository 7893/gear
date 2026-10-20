<script
  setup
  lang="ts"
  generic="T extends string | number | null | undefined = string"
>
import { computed, ref, useAttrs, useId, watchEffect } from "vue";
defineOptions({ inheritAttrs: false });
const model = defineModel<T>({ required: true });
const props = withDefaults(
  defineProps<{
    label: string;
    type?: string;
    options?:
      Readonly<Record<string, string>> | readonly { value: T; label: string }[];
    emptyLabel?: string;
    emptyValue?: T;
    hint?: string;
    wide?: boolean;
    error?: string;
    validationMessage?: string;
  }>(),
  { type: "text" },
);
const input = ref<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
const errorId = useId();
const labelId = useId();
const attrs = useAttrs();
const labelledBy = computed(() =>
  typeof attrs["aria-labelledby"] === "string"
    ? attrs["aria-labelledby"]
    : labelId,
);
const describedBy = computed(
  () =>
    [
      typeof attrs["aria-describedby"] === "string"
        ? attrs["aria-describedby"]
        : "",
      props.error ? errorId : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined,
);
watchEffect(() =>
  input.value?.setCustomValidity(props.validationMessage || ""),
);
const choices = computed(() =>
  Array.isArray(props.options)
    ? props.options
    : Object.entries(props.options || {}).map(([value, label]) => ({
        value,
        label,
      })),
);
</script>
<template>
  <label :class="{ 'form-wide': wide }"
    ><span :id="labelId">{{ label }}</span>
    <select
      v-if="options"
      ref="input"
      v-model="model"
      v-bind="$attrs"
      :aria-labelledby="labelledBy"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
    >
      <option
        v-if="emptyLabel !== undefined"
        :value="emptyValue === undefined ? '' : emptyValue"
      >
        {{ emptyLabel }}
      </option>
      <option
        v-for="(choice, index) in choices"
        :key="index"
        :value="choice.value"
      >
        {{ choice.label }}
      </option>
    </select>
    <textarea
      v-else-if="type === 'textarea'"
      ref="input"
      v-model="model"
      v-bind="$attrs"
      :aria-labelledby="labelledBy"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
    />
    <input
      v-else
      ref="input"
      v-model="model"
      :type="type"
      v-bind="$attrs"
      :aria-labelledby="labelledBy"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
    />
    <span v-if="hint" class="hint">{{ hint }}</span>
    <span v-if="error" :id="errorId" class="field-error" role="alert">{{
      error
    }}</span>
  </label>
</template>
