import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const mode = process.argv[2];
if (!["package", "sign"].includes(mode)) {
  console.error("Usage: node scripts/firefox-release.mjs package|sign");
  process.exit(1);
}
if (mode === "sign" && (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET)) {
  console.error("Signing requires WEB_EXT_API_KEY and WEB_EXT_API_SECRET. Set them in your local environment, then rerun npm run sign:firefox. Never commit credentials.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const releaseName = `catan-copilot-${manifest.version}`;
const artifacts = join(root, "dist", "firefox");
const staging = join(artifacts, "extension");
mkdirSync(artifacts, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}
function webExt(args) {
  run(process.execPath, [join(root, "node_modules/web-ext/bin/web-ext.js"), ...args]);
}

run("npm", ["run", "build"]);
// Only these three runtime files enter the add-on, even if extension/ has extras.
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging);
for (const file of ["manifest.json", "content.js", "inject.js"]) {
  copyFileSync(join(root, "extension", file), join(staging, file));
}
webExt(["lint", "--source-dir", staging, "--self-hosted"]);
webExt([
  "build", "--source-dir", staging, "--artifacts-dir", artifacts,
  "--filename", `${releaseName}-unsigned.zip`, "--overwrite-dest",
]);

// Explicit source allowlist: no credentials, captured games, logs, or git history.
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
const sources = [
  "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
  "vite.inject.config.ts", "extension/manifest.json", "BUILDING.md",
  "scripts/firefox-release.mjs", ...sourceFiles("src"),
].sort();
const sourceArchive = join(artifacts, `${releaseName}-source.zip`);
rmSync(sourceArchive, { force: true });
run("zip", ["-q", "-X", sourceArchive, "-@"], {
  input: sources.join("\n") + "\n", stdio: ["pipe", "inherit", "inherit"],
});
console.log(`Unsigned package: ${join(artifacts, `${releaseName}-unsigned.zip`)}`);
console.log(`Review sources: ${sourceArchive}`);
if (mode === "sign") {
  // web-ext reads credentials from the environment; never place them in argv.
  webExt([
    "sign", "--source-dir", staging, "--artifacts-dir", artifacts,
    "--channel", "unlisted", "--upload-source-code", sourceArchive,
  ]);
} else {
  console.log("This ZIP is unsigned. Run npm run sign:firefox to obtain a persistently installable XPI.");
}
