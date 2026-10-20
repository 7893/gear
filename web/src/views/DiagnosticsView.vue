<script setup lang="ts">
import { onMounted, ref } from "vue";
import { configuration } from "../configuration";
type State = "pending" | "success" | "failure";
const gateway = ref<State>("pending");
const supabase = ref<State>("pending");
const busy = ref(false);
const checkedAt = ref("");
const labels = { pending: "检测中", success: "正常", failure: "失败" };
async function run() {
  busy.value = true;
  gateway.value = "pending";
  supabase.value = "pending";
  try {
    const config = await configuration();
    const check = async (
      path: string,
      headers?: HeadersInit,
    ): Promise<State> => {
      try {
        const response = await fetch(new URL(path, config.apiUrl), {
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        const value = (await response.json()) as Record<string, unknown>;
        return response.ok &&
          (path === "/healthz"
            ? value.status === "ready"
            : typeof value.external === "object")
          ? "success"
          : "failure";
      } catch {
        return "failure";
      }
    };
    [gateway.value, supabase.value] = await Promise.all([
      check("/healthz"),
      check("/auth/v1/settings", { apikey: config.publishableKey }),
    ]);
  } catch {
    gateway.value = "failure";
    supabase.value = "failure";
  } finally {
    busy.value = false;
    checkedAt.value = `检测时间：${new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date())}`;
  }
}
onMounted(() => void run());
</script>
<template>
  <section class="card narrow">
    <h1>连接检测</h1>
    <ul aria-live="polite">
      <li id="page-status" data-state="success">页面脚本：正常</li>
      <li id="gateway-status" :data-state="gateway">
        后端连接：{{ labels[gateway] }}
      </li>
      <li id="supabase-status" :data-state="supabase">
        Supabase 连接：{{ labels[supabase] }}
      </li>
    </ul>
    <button id="retry" type="button" :disabled="busy" @click="run">
      重新检测
    </button>
    <p id="checked-at" class="hint">{{ checkedAt }}</p>
  </section>
</template>
