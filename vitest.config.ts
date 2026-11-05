import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

const live = process.env.AGENTCITY_LIVE === "1";

export default defineConfig({
  resolve: {
    alias: {
      "@agentcity/core": src("core"),
      "@agentcity/safety": src("safety"),
      "@agentcity/org": src("org"),
      "@agentcity/world/shared": fileURLToPath(new URL("./packages/world/src/shared/index.ts", import.meta.url)),
      "@agentcity/world": src("world"),
      "@agentcity/cli": src("cli"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    exclude: live ? ["**/node_modules/**"] : ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
