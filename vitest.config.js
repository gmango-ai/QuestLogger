import { defineConfig } from "vitest/config";

export default defineConfig({
  // Use the automatic JSX runtime (react/jsx-runtime) so component files and
  // jsdom component tests render without an explicit `import React`. The pure
  // node tests never render JSX, so this only matters once we mount components.
  esbuild: { jsx: "automatic" },
  test: {
    // Default env is node (fast, no DOM) — most tests are pure logic. Component
    // tests that need a DOM opt into jsdom per-file with a
    // `@vitest-environment jsdom` docblock (see *.dom.test.jsx). Keeping node the
    // default avoids slowing the ~340 pure tests and needs no global DOM setup.
    environment: "node",
    include: ["src/**/*.test.js", "src/**/*.test.jsx", "electron/src/**/*.test.ts"],
  },
});
