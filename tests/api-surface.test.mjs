// The public API of the package (design sections E5 and L.1): what an adopter may import, pinned name by name.
//
//   ai-sdlc-factory/script-kit   the only surface that an orchestrator's own scripts rely on
//   ai-sdlc-factory/drift-lib    the modules of src/drift/lib that are staged read-only for a validator: they import nothing but node: modules and each other
//   ai-sdlc-factory/reconcile    the renderer and the reconciler
//   ai-sdlc-factory/schemas/*    the manifest schema and the routing schema
//   ai-sdlc-factory/package.json
//
// The exports map blocks every deep import into src/. A name that is added, removed or renamed in any of these lists is a change of the public API: it fails
// here, and the person who made it either meant it (and updates the list and the changelog) or did not.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const names = (module) => Object.keys(module).sort();

/** The names of ai-sdlc-factory/script-kit: exactly what the scripts that moved to the orchestrator use, and nothing else. */
const SCRIPT_KIT = [
  // the flags and the process of a script (src/drift/lib/args.mjs, cli.mjs, atomic.mjs)
  "BASE_SHA_VARIABLE", "UsageError", "outDirectory", "parseBoolean", "parseFlags", "repoName", "requireSlug", "resolveIo", "runAsMain", "stableJson", "workspaceOf", "writeFilesAtomically",
  // the manifest that a helper reads (src/adaptation/manifest.mjs)
  "ManifestError", "aiEdges", "helperSection", "isInside", "locateManifest", "readManifest", "relativePath", "resolvePointer", "workflowIdOf",
  // reading TypeScript (src/adaptation/ts-scan.mjs)
  "inComment", "matchingBracket", "scan",
  // git and checkouts (src/routing/git.mjs)
  "childEnvironment", "ensureCheckout", "execute", "git", "isolatedClone", "toShellPath",
  // the REST client (src/routing/rest.mjs)
  "RestError", "assertInstallationToken", "createRestClient", "encodePath", "repoPath", "resolveApiBase",
].sort();

/** The names of ai-sdlc-factory/drift-lib: every export of args, cli, atomic, git-artifacts, correlation and yaml-load. */
const DRIFT_LIB = [
  // args.mjs
  "REPO_SLUG", "UsageError", "parseBoolean", "parseFlags", "repoName", "requireSlug",
  // cli.mjs
  "BASE_SHA_VARIABLE", "DEFAULT_OUT", "VALIDATOR_STAGE_DIRECTORY", "isMain", "outDirectory", "resolveIo", "runAsMain", "stableJson", "workspaceOf",
  // atomic.mjs
  "writeFilesAtomically",
  // correlation.mjs
  "CORRELATION_ID", "runCorrelationId",
  // yaml-load.mjs
  "loadYaml",
  // git-artifacts.mjs
  "COMMIT_LIMIT", "FILE_LIMIT_BYTES", "GIT_OPTIONS", "TRANSPORT_FILE", "branchTips", "bundleCommits", "commitsAhead", "git", "gitMessage", "indexFileText", "indexPaths", "listRefs", "openScratch",
  "patchTrees", "refsByCommit", "replaceRefs", "repositoryDirectories", "snapshotTransportFiles", "transportFiles", "workTreePaths",
].sort();

/**
 * The names of ai-sdlc-factory/reconcile: the four of the public API (design L.1), and nothing else. The package's own commands and tools need five more names of
 * the implementation module, src/reconcile.mjs; they reach them by its relative path, and the exports map does not publish that file.
 */
const RECONCILE_PUBLIC = ["buildAcks", "checkRendered", "reconcile", "renderFleet"];
const RECONCILE_INTERNAL = ["REPO_CONFIG_PATH", "ROUTER_PATH", "ghAwEnvironment", "main", "renderOnboardPayload"];

test("the exports map is exactly the public surface: script-kit, drift-lib, reconcile, the schemas and package.json", () => {
  assert.deepEqual(pkg.exports, {
    "./script-kit": "./src/script-kit.mjs",
    "./drift-lib": "./src/drift/lib/index.mjs",
    "./reconcile": "./src/reconcile-api.mjs",
    "./schemas/*": "./schemas/*",
    "./package.json": "./package.json",
  });
  for (const target of Object.values(pkg.exports).filter((entry) => !entry.includes("*"))) assert.ok(fs.existsSync(path.join(ROOT, target)), `${target} exists`);
});

test("ai-sdlc-factory/script-kit exports exactly what the scripts of an orchestrator use", async () => {
  const kit = await import("ai-sdlc-factory/script-kit");
  assert.deepEqual(names(kit), SCRIPT_KIT);
  assert.equal(SCRIPT_KIT.length, new Set(SCRIPT_KIT).size, "no name twice");
});

test("every name of the script kit is the function or value of the module that it comes from, not a copy", async () => {
  const kit = await import("ai-sdlc-factory/script-kit");
  const sources = {
    "../src/drift/lib/args.mjs": ["parseFlags", "parseBoolean", "requireSlug", "repoName", "UsageError"],
    "../src/drift/lib/cli.mjs": ["resolveIo", "runAsMain", "workspaceOf", "outDirectory", "stableJson", "BASE_SHA_VARIABLE"],
    "../src/drift/lib/atomic.mjs": ["writeFilesAtomically"],
    "../src/adaptation/manifest.mjs": ["readManifest", "locateManifest", "helperSection", "relativePath", "resolvePointer", "isInside", "ManifestError", "aiEdges", "workflowIdOf"],
    "../src/adaptation/ts-scan.mjs": ["scan", "matchingBracket", "inComment"],
    "../src/routing/git.mjs": ["childEnvironment", "ensureCheckout", "execute", "git", "isolatedClone", "toShellPath"],
    "../src/routing/rest.mjs": ["createRestClient", "repoPath", "encodePath", "resolveApiBase", "assertInstallationToken", "RestError"],
  };
  let count = 0;
  for (const [file, exported] of Object.entries(sources)) {
    const module = await import(new URL(file, import.meta.url).href);
    for (const name of exported) {
      assert.equal(kit[name], module[name], `${name} of ${file}`);
      count += 1;
    }
  }
  assert.equal(count, SCRIPT_KIT.length, "every name of the kit was compared");
});

test("ai-sdlc-factory/drift-lib exports every name of the six modules that are staged for a validator, and nothing else", async () => {
  const lib = await import("ai-sdlc-factory/drift-lib");
  assert.deepEqual(names(lib), DRIFT_LIB);
  const barrel = fs.readFileSync(path.join(ROOT, "src", "drift", "lib", "index.mjs"), "utf8");
  const modules = [...barrel.matchAll(/from "\.\/([a-z-]+)\.mjs"/g)].map((match) => match[1]).sort();
  assert.deepEqual(modules, ["args", "atomic", "cli", "correlation", "git-artifacts", "yaml-load"]);
  for (const name of modules) {
    const module = await import(new URL(`../src/drift/lib/${name}.mjs`, import.meta.url).href);
    for (const exported of Object.keys(module)) assert.equal(lib[exported], module[exported], `${exported} of ${name}`);
  }
});

test("drift-lib is staged-safe: its modules import nothing but node: modules and each other, so a copy of src/drift/lib runs on its own", () => {
  const barrel = path.join(ROOT, "src", "drift", "lib");
  for (const file of ["index", "args", "atomic", "cli", "correlation", "git-artifacts", "yaml-load"]) {
    const text = fs.readFileSync(path.join(barrel, `${file}.mjs`), "utf8");
    for (const match of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith("node:") || /^\.\/[a-z-]+\.mjs$/.test(specifier), `${file}.mjs imports ${specifier}`);
    }
  }
});

test("ai-sdlc-factory/reconcile exports exactly the four names of the public API: renderFleet, reconcile, checkRendered and buildAcks", async () => {
  const reconcile = await import("ai-sdlc-factory/reconcile");
  assert.deepEqual(names(reconcile), RECONCILE_PUBLIC);
  for (const name of RECONCILE_PUBLIC) assert.equal(typeof reconcile[name], "function", name);
});

test("every name of ai-sdlc-factory/reconcile is the function of src/reconcile.mjs, not a copy", async () => {
  const reconcile = await import("ai-sdlc-factory/reconcile");
  const implementation = await import("../src/reconcile.mjs");
  for (const name of RECONCILE_PUBLIC) assert.equal(reconcile[name], implementation[name], name);
});

test("the five names that the package's own commands use stay on src/reconcile.mjs and are not published by the exports map", async () => {
  const reconcile = await import("ai-sdlc-factory/reconcile");
  const implementation = await import("../src/reconcile.mjs");
  for (const name of RECONCILE_INTERNAL) {
    assert.ok(name in implementation, `${name} is exported by src/reconcile.mjs, for the commands and tools of the package`);
    assert.equal(name in reconcile, false, `${name} is not part of ai-sdlc-factory/reconcile`);
  }
});

test("the exports map blocks every deep import into src/, and the schemas and package.json resolve", async () => {
  for (const specifier of ["ai-sdlc-factory/src/reconcile.mjs", "ai-sdlc-factory/src/drift/lib/args.mjs", "ai-sdlc-factory/bin/sdlc-reconcile.mjs", "ai-sdlc-factory/tests/api-surface.test.mjs"]) {
    await assert.rejects(import(specifier), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED", specifier);
  }
  for (const [specifier, key] of [["ai-sdlc-factory/schemas/sdlc.schema.json", "$schema"], ["ai-sdlc-factory/schemas/sdlc-routing.schema.json", "$schema"], ["ai-sdlc-factory/package.json", "name"]]) {
    const file = fileURLToPath(import.meta.resolve(specifier));
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8"))[key], specifier);
  }
  assert.equal(JSON.parse(fs.readFileSync(fileURLToPath(import.meta.resolve("ai-sdlc-factory/package.json")), "utf8")).name, "ai-sdlc-factory");
});

test("the bins of the package are the three commands, and each of them is a file", () => {
  assert.deepEqual(pkg.bin, { "sdlc-bootstrap": "bin/sdlc-bootstrap.mjs", "sdlc-onboard": "bin/sdlc-onboard.mjs", "sdlc-reconcile": "bin/sdlc-reconcile.mjs" });
  for (const file of Object.values(pkg.bin)) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
});
