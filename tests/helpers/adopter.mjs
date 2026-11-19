// An adopter's workspace for the tests that run the scripts of examples/: a scratch directory that holds files of examples/ and the factory installed under
// node_modules/ai-sdlc-factory the way npm installs a package, as a copy of the files that the package ships (never a link), so that
// `import "ai-sdlc-factory/script-kit"` and `import "ai-sdlc-factory/drift-lib"` resolve for a script as they do in a real orchestrator.
//
//   const adopter = createAdopter(t, { examples: ["scripts", "sdlc.yaml"] });
//   adopter.write("hub/apps/site/sources.json", "...");
//   const out = adopter.node("scripts/check-sources.mjs", ["--downstream", "hub", ...], { cwd: "hub", env: { ... } });
//
// Only src/ and package.json are copied: the exports that a script imports need no third-party package (the YAML reader of the drift library falls back to its own).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_ROOT, presetAbs } from "./preset.mjs";

/** Copies the package files that a script needs into `<dir>/node_modules/ai-sdlc-factory`. */
export function installFactory(dir, { entries = ["package.json", "src"] } = {}) {
  const target = path.join(dir, "node_modules", "ai-sdlc-factory");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of entries) fs.cpSync(path.join(ENGINE_ROOT, entry), path.join(target, entry), { recursive: true });
  return target;
}

/**
 * @param {import("node:test").TestContext} t the directory is removed when the test ends
 * @param {{ examples?: string[], factory?: boolean }} [options] the files of examples/ to copy (default: scripts and sdlc.yaml), and whether to install the factory
 */
export function createAdopter(t, { examples = ["scripts", "sdlc.yaml"], factory = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-adopter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (factory) installFactory(dir);
  for (const entry of examples) fs.cpSync(presetAbs(entry), path.join(dir, entry), { recursive: true });
  const abs = (...parts) => path.join(dir, ...parts);
  return {
    dir,
    abs,
    write(relative, text) {
      const target = abs(...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      return target;
    },
    read: (relative) => fs.readFileSync(abs(...relative.split("/")), "utf8"),
    exists: (relative) => fs.existsSync(abs(...relative.split("/"))),
    /** Runs a script of the workspace with node, from `cwd` (relative to the workspace, default the workspace). */
    node(script, args = [], { cwd = ".", env = {}, input } = {}) {
      const run = spawnSync(process.execPath, [abs(...script.split("/")), ...args], {
        cwd: abs(...cwd.split("/")),
        env: { ...process.env, ...env },
        encoding: "utf8",
        input,
        windowsHide: true,
        timeout: 120000,
      });
      return { code: run.status, stdout: run.stdout, stderr: run.stderr };
    },
  };
}
