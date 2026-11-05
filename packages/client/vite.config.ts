import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@agentcity/world/shared": fileURLToPath(new URL("../world/src/shared/index.ts", import.meta.url)),
    },
  },
  // Phaser alone is about 1.2 MB minified.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
