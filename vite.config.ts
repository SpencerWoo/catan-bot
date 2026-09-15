import { defineConfig } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { VERSION } from "./src/extension/version";

// Bundles the content script into a single IIFE file the extension can load.
export default defineConfig({
  plugins: [{
    name: "extension-version-title",
    writeBundle() {
      const path = new URL("./extension/manifest.json", import.meta.url);
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const name = `Catan Copilot ${VERSION.split(" ")[0]} for colonist.io`;
      if (manifest.name !== name) {
        manifest.name = name;
        writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
      }
    },
  }],
  build: {
    outDir: "extension",
    emptyOutDir: false,
    lib: {
      entry: "src/extension/content.ts",
      name: "CatanCopilot",
      formats: ["iife"],
      fileName: () => "content.js",
    },
    minify: false,
  },
  test: {
    environment: "jsdom",
  },
} as never);
