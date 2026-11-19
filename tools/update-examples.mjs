#!/usr/bin/env node
// Regenerates the committed render of examples/: the golden files of the engine's tests (design H.4).
//
//   node tools/update-examples.mjs              render examples/ with renderFleet() into examples/.github/workflows (the 13 workflow sources, the router and
//                                               aw.json) and remove the workflow sources that the manifest no longer renders
//   node tools/update-examples.mjs --compile    also compile them with `gh aw compile --strict --purge` into the 13 *.lock.yml, with the gh-aw release that
//                                               examples/.gh-aw-version names, in a scratch copy of examples/ (the compiler's side files never reach the tree)
//
// An engine change that alters rendered output has to regenerate examples/ in the same commit; `git diff -- examples` is then the behaviour change of that commit.
// A compile needs the right gh-aw: when the global `gh aw` is older, point SDLC_GH_AW_DATA_HOME at an isolated install of the release in .gh-aw-version.
// Exit codes: 0 done, 1 the render or the compile was refused (nothing was written), 2 usage or the wrong gh-aw.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ghAwEnvironment, reconcile, renderFleet } from "../src/reconcile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = path.join(ROOT, "examples");
const WORKFLOWS = ".github/workflows";
const ACTIONS_LOCK = ".github/aw/actions-lock.json";
/** What the renderer owns in the workflows directory: its sources and their locks. The router and aw.json are rendered files of their own. */
const MANAGED = /^(?:drift-.+|implement-.+|cascade-mechanical-.+|cascade-ai-.+|sdlc-onboard)\.(?:md|lock\.yml)$/;

/** A render or a compile that the factory refused, or a usage error: the message is the whole report, and nothing was written. */
class Stop extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const readText = (file) => fs.readFileSync(file, "utf8");
const listWorkflows = (dir) => (fs.existsSync(path.join(dir, WORKFLOWS)) ? fs.readdirSync(path.join(dir, WORKFLOWS)).sort() : []);

/** The errors of a refused render or compile, one line each. */
function describe(result) {
  const results = result.result?.validationResults ?? result.validationResults ?? [];
  return results.flatMap((entry) => (entry.errors ?? []).map((error) => `  ${entry.file}: ${error}`)).join("\n");
}

function ghAwVersion(env) {
  const run = spawnSync("gh", ["aw", "version"], { env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  return /v?(\d+\.\d+\.\d+)/.exec(`${run.stdout}${run.stderr}`)?.[1] ?? null;
}

/** Writes `files` (a Map of examples-relative path to text) and removes the managed workflow files whose name is not in `kept`. */
function install(files, kept) {
  for (const [relative, text] of files) {
    const target = path.join(EXAMPLES, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  for (const name of listWorkflows(EXAMPLES)) {
    if (MANAGED.test(name) && !kept.has(name)) fs.rmSync(path.join(EXAMPLES, WORKFLOWS, name), { force: true });
  }
}

async function update({ compile }) {
  const request = JSON.parse(readText(path.join(EXAMPLES, "request.reference.json")));
  const rendered = renderFleet(request, { cwd: EXAMPLES });
  if (!rendered.ok) throw new Stop(`the render of examples/ was refused:\n${describe(rendered)}`, 1);

  if (!compile) {
    // the locks stay as they were: a lock is kept while its workflow source is still rendered
    const names = [...rendered.files.keys()].map((file) => path.posix.basename(file));
    install(rendered.files, new Set([...names, ...names.filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, ".lock.yml"))]));
    process.stdout.write(`rendered ${rendered.files.size} files into examples/${WORKFLOWS} (no compile: the locks are as they were)\n`);
    return;
  }

  const env = ghAwEnvironment({ ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
  const wanted = readText(path.join(EXAMPLES, ".gh-aw-version")).trim().replace(/^v/, "");
  const found = ghAwVersion(env);
  if (found !== wanted) {
    throw new Stop(`gh aw is ${found === null ? "not installed" : `v${found}`}, and the goldens are compiled with v${wanted} (examples/.gh-aw-version): point SDLC_GH_AW_DATA_HOME at an isolated install of v${wanted}`, 2);
  }

  // the compile runs in a scratch copy of the adopter's files: the compiler keeps files of its own beside the workflows, and none of them belongs in examples/
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-examples-"));
  try {
    for (const entry of ["sdlc.yaml", "package.json", "instructions", ".github/aw"]) {
      if (fs.existsSync(path.join(EXAMPLES, entry))) fs.cpSync(path.join(EXAMPLES, entry), path.join(scratch, entry), { recursive: true });
    }
    const init = spawnSync("git", ["init", "-q"], { cwd: scratch, env, windowsHide: true });
    if (init.status !== 0) throw new Stop("git init failed in the scratch copy of examples/", 1);
    const result = await reconcile({ ...request, dryRun: false }, { cwd: scratch, env });
    if (result.status !== "ok") throw new Stop(`the compile of examples/ was refused:\n${describe(result)}`, 1);
    // The goldens are the render (all 15 files, aw.json included) and the locks that the compiler made of it. The compiler's own aw.json is the strict-only fallback
    // that gh-aw v1.0.1 needs (it refuses protected_files), which is not what the renderer produces; the sources that it read must be the ones that were rendered.
    const files = new Map(rendered.files);
    for (const [relative, text] of rendered.files) {
      if (!relative.endsWith("/aw.json") && readText(path.join(scratch, relative)) !== text) throw new Stop(`${relative} is not what was rendered: the compile ran on other sources`, 1);
    }
    const locks = listWorkflows(scratch).filter((name) => name.endsWith(".lock.yml"));
    for (const name of locks) files.set(`${WORKFLOWS}/${name}`, readText(path.join(scratch, WORKFLOWS, name)));
    // the pins that the compiler resolved are an input of the next compile: they are kept with the goldens
    if (fs.existsSync(path.join(scratch, ACTIONS_LOCK))) files.set(ACTIONS_LOCK, readText(path.join(scratch, ACTIONS_LOCK)));
    install(files, new Set([...files.keys()].map((file) => path.posix.basename(file))));
    process.stdout.write(`rendered ${rendered.files.size} files and compiled ${locks.length} locks into examples/${WORKFLOWS} with gh aw v${wanted}\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  const argv = process.argv.slice(2);
  for (const argument of argv) if (argument !== "--compile") throw new Stop(`unknown argument ${argument}\nusage: node tools/update-examples.mjs [--compile]`, 2);
  await update({ compile: argv.includes("--compile") });
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code;
}
