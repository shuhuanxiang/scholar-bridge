import { defineConfig } from "vitest/config";

// happy-dom provides the `window` global (window.setTimeout etc.) that the
// plugin code targets for popout-window compatibility.
export default defineConfig({
  test: {
    environment: "happy-dom",
  },
});
