<script setup lang="ts">
import { computed } from "vue";
import qrcode from "qrcode-generator";
import { scanPath } from "../references";
const props = defineProps<{ kind: "document" | "asset"; reference: string }>();
const title = computed(() => (props.kind === "document" ? "单据" : "设备"));
const url = computed(
  () =>
    new URL(
      "/#" + scanPath(props.kind, props.reference),
      window.location.origin,
    ).href,
);
const qr = computed(() => {
  const code = qrcode(0, "M");
  code.addData(url.value);
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row++)
    for (let column = 0; column < count; column++)
      if (code.isDark(row, column)) path += `M${column + 4},${row + 4}h1v1h-1z`;
  return { path, size: count + 8 };
});
</script>
<template>
  <figure class="record-qr">
    <a :href="url" :aria-label="'打开' + title + '核对页面'">
      <svg
        :viewBox="`0 0 ${qr.size} ${qr.size}`"
        width="112"
        height="112"
        role="img"
        :aria-label="title + '查询二维码'"
        shape-rendering="crispEdges"
      >
        <title>{{ title }} {{ reference }}</title>
        <rect :width="qr.size" :height="qr.size" fill="#fff" />
        <path :d="qr.path" fill="#000" />
      </svg>
    </a>
    <figcaption>扫码核对{{ title }}<small>登录后查看详情</small></figcaption>
  </figure>
</template>
