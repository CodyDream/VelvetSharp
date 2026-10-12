import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@brain": path.resolve(__dirname, "../packages/brain/src"),
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173, strictPort: true },
});
