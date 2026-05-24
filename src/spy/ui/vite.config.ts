import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiRoot = import.meta.dirname;

export default defineConfig({
  root: uiRoot,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(uiRoot, "../../../dist/spy-ui"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:6174",
    },
  },
});
