import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { PRODUCT_NAME } from "./src/brand";

export default defineConfig({
  plugins: [react(), { name: "product-name", transformIndexHtml: (h: string) => h.replace("%PRODUCT_NAME%", PRODUCT_NAME) }],
  define: { "process.env": {} },
  test: { css: true, environment: "jsdom", setupFiles: ["src/__tests__/setup.ts"], include: ["src/__tests__/**/*.test.tsx"] },
});
