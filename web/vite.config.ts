import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  // Recognition is lazy; prebundle it before the first upload to avoid a dev reload.
  optimizeDeps: { include: ["jsqr", "pdfjs-dist"] },
});
