// Builds the published migration command, build/cli.js (package @momentum-js/migrate,
// command momentum-migrate): src/bin.ts bundled for Node with the momentum source the catalog
// was proven against. TypeScript and temporal-polyfill stay external, as the package's
// dependencies. The package's README and license are copies of docs/migrate.md and LICENSE.md at the repository root.

import { chmod, copyFile, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);

await rm("build", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/bin.ts"],
  outdir: "build",
  naming: "cli.js",
  format: "esm",
  target: "node",
  external: ["typescript", "typescript/*", "temporal-polyfill", "temporal-polyfill/*"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const cli = "build/cli.js";
const text = (await Bun.file(cli).text()).replace(/^#!.*\n/, "");
await Bun.write(cli, `#!/usr/bin/env node\n${text}`);
await chmod(cli, 0o755);
await copyFile("../../docs/migrate.md", "README.md");
await copyFile("../../LICENSE.md", "LICENSE.md");
console.log(`${cli}  ${(Bun.file(cli).size / 1024).toFixed(1)} kB`);
