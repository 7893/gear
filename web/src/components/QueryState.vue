<script setup lang="ts">
withDefaults(
  defineProps<{
    loading?: boolean;
    error?: string;
    loadingText?: string;
    retryLabel?: string;
  }>(),
  { loadingText: "正在读取…", retryLabel: "重新读取" },
);
defineEmits<{ retry: [] }>();
</script>
<template>
  <p v-if="loading" role="status">{{ loadingText }}</p>
  <div v-if="error" class="notice error" role="alert">
    <p>{{ error }}</p>
    <button
      v-if="retryLabel"
      class="quiet"
      type="button"
      @click="$emit('retry')"
    >
      {{ retryLabel }}
    </button>
  </div>
  <slot />
</template>
