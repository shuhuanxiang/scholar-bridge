import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// happy-dom provides the `window` global (window.setTimeout etc.) that the
// plugin code targets for popout-window compatibility.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/helpers/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
  },
});
