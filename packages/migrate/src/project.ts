// Loads a TypeScript or JavaScript project through TypeScript 7's compiler API (the async client,
// which runs under Bun as well as Node). Without a tsconfig.json, a temporary one includes every
// JavaScript and TypeScript file under the directory and lets TypeScript infer types from JSDoc
// and from momentum's declarations.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { API, type Project } from "typescript/unstable/async";

export interface LoadedProject {
  api: API;
  project: Project;
  root: string;
  configFile: string;
  /** Source files of the project itself: no declarations, nothing under node_modules. */
  files: string[];
  /** Whether the project had no tsconfig.json and types come from inference. */
  inferred: boolean;
  reload(changed: readonly string[]): Promise<Project>;
  close(): Promise<void>;
}

export async function loadProject(directory: string, tsconfig?: string): Promise<LoadedProject> {
  const root = resolve(directory);
  let configFile = tsconfig === undefined ? join(root, "tsconfig.json") : resolve(tsconfig);
  let temp: string | null = null;
  if (!existsSync(configFile)) {
    if (tsconfig !== undefined) throw new Error(`${tsconfig} does not exist`);
    temp = mkdtempSync(join(tmpdir(), "momentum-migrate-"));
    configFile = join(temp, "tsconfig.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          typeRoots: [join(root, "node_modules/@types")],
        },
        include: [join(root, "**/*")],
        exclude: ["node_modules", "dist", "build", "coverage"].map((d) => join(root, "**", d)),
      })
    );
  }
  const api = new API({ cwd: root });
  let snapshot = await api.updateSnapshot({ openProjects: [configFile] });
  let project = snapshot.getProject(configFile);
  if (project === undefined) {
    await api.close();
    throw new Error(`TypeScript could not load ${configFile}`);
  }
  const prefix = `${root}/`.toLowerCase();
  const files = (await project.program.getSourceFileNames()).filter(
    (f) =>
      f.toLowerCase().startsWith(prefix) &&
      !f.includes("/node_modules/") &&
      !/\.d\.[cm]?ts$/.test(f)
  );
  return {
    api,
    project,
    root,
    configFile,
    files,
    inferred: temp !== null,
    async reload(changed) {
      snapshot = await api.updateSnapshot({ fileChanges: { changed: [...changed] } });
      project = snapshot.getProject(configFile)!;
      return project;
    },
    async close() {
      await api.close();
      if (temp !== null) rmSync(dirname(configFile), { recursive: true, force: true });
    },
  };
}
