// Importing a script of examples/ inside a test process (design H.5, I.3).
//
// A script of an orchestrator imports the factory by its package name (`ai-sdlc-factory/script-kit`, `ai-sdlc-factory/drift-lib`). Inside this repository the
// package is not installed under node_modules, and a file under examples/ is not in the scope of this package.json (examples/ has the package.json of its own, as an
// adopter's orchestrator does), so node cannot resolve the name. A resolve hook maps it to the files of this repository through the `exports` map, exactly as an
// installed copy would resolve, and the import then shares its module instances with the tests that import src/ directly.
//
//   const { run } = await importExampleScript("validate-example.mjs");
//   const code = await run(["--self-improve"], { cwd: checkout, stdout, stderr });
//
// A test that needs the real node_modules layout (a child process that is started in a workspace) uses tests/helpers/adopter.mjs instead.

import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_ROOT, presetAbs } from "./preset.mjs";

let registered = false;

/** Makes `import "ai-sdlc-factory/<subpath>"` resolve to this repository, for every module that is imported afterwards. Idempotent. */
export function resolveFactoryImports() {
  if (registered) return;
  registered = true;
  const { exports: exportsMap } = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("ai-sdlc-factory/")) {
        const target = exportsMap[`./${specifier.slice("ai-sdlc-factory/".length)}`];
        if (typeof target === "string" && !target.includes("*")) return { url: pathToFileURL(path.join(ENGINE_ROOT, target)).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

/** The module of a script of the preset's scripts/ directory (examples/scripts/<name>), imported in this process. */
export async function importExampleScript(name) {
  resolveFactoryImports();
  return import(pathToFileURL(presetAbs("scripts", name)).href);
}
