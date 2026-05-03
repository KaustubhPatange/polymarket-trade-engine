import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    // logs/ is a sibling of analysis/ — allow Vite to read from the repo root
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: {
      "@logs": path.resolve(repoRoot, "logs"),
    },
  },
});
