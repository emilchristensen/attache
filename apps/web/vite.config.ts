import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const service = process.env.ATTACHE_DEV_SERVICE ?? "http://127.0.0.1:7427";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true, target: "es2022" },
  server: {
    port: 5173,
    proxy: { "/api": { target: service, changeOrigin: true } },
  },
});
