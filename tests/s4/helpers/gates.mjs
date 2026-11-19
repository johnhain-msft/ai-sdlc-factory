// Immutable-gate scenarios: a committed neutral downstream, a separate trusted manifest workspace, and the real frozen command.
import path from "node:path";
import { gatePolicyFor } from "../../../src/adaptation/manifest.mjs";
import { HELPERS, commitAll, installVitestStub, jsonOf, passingReport, readText, runNode, writeFiles } from "./fixtures.mjs";
import { createGateFleet, gateManifest } from "./gate-fleet.mjs";

export const preset = gateManifest();
export const edgeOf = (edgeId) => preset.dependencyEdges.find((edge) => edge.edgeId === edgeId);
export const WORKFLOWS = preset.dependencyEdges.filter((edge) => edge.mode === "ai-adaptation").map((edge) => `cascade-ai-${edge.edgeId}`);
export const policyOf = (workflow) => edgeOf(workflow.replace(/^cascade-ai-/, "")).immutableGates;
const workspaces = new Map();

export const read = (dir, relative) => readText(path.join(dir, ...relative.split("/")));

/**
 * @param {object} [options]
 * @param {(dir: string) => object} [options.prepare] files (null deletes) committed as part of the base
 * @param {(dir: string) => object} [options.mutate] files (null deletes) committed on top of the base: the change that is checked
 * @param {object} [options.report] the Vitest report that the stand-in writes (default: every locked block of the workflow passed)
 * @param {boolean} [options.commit] false leaves the mutation uncommitted, in the work tree
 * @param {object} [options.manifest] a test-specific copy of the neutral fleet manifest
 * @param {boolean} [options.vitest] false leaves Vitest uninstalled
 */
export function scenario({ workflow = WORKFLOWS[0], prepare, mutate, report, commit = true, manifest = gateManifest(), vitest = true } = {}) {
  const { workspace, dir, base: original } = createGateFleet(manifest);
  workspaces.set(dir, workspace);
  if (vitest) installVitestStub(dir, report ?? passingReport(gatePolicyFor(manifest, workflow).lockedTestBlocks, "/work/downstream"));
  let base = original;
  if (prepare) {
    writeFiles(dir, prepare(dir));
    base = commitAll(dir, "prepare the base");
  }
  if (mutate) {
    writeFiles(dir, mutate(dir));
    if (commit) commitAll(dir, "the change under test");
  }
  return {
    dir,
    base,
    workspace,
    run: (options = {}) => runGates(dir, base, workflow, options),
  };
}

/** Runs the command; the result carries the parsed JSON of its standard output. */
export function runGates(dir, base, workflow, { cwd = workspaces.get(dir), frozen = true, env = {}, args } = {}) {
  const result = runNode(HELPERS.gates, args ?? ["--downstream", dir, "--base", base, "--workflow", workflow], { cwd, frozen, env });
  return { ...result, json: jsonOf(result.stdout) };
}

/** The message that a failed assertion shows: both streams of the command. */
export const shown = (result) => `exit ${result.code}\n${result.stdout}\n${result.stderr}`;

/** The text of a locked block (or any substring) replaced once; the replacement must change the text. */
export function replaceOnce(text, from, to) {
  if (!text.includes(from)) throw new Error(`the fixture does not contain: ${from}`);
  return text.replace(from, () => to);
}
