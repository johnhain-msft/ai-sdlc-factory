#!/usr/bin/env node
// First pre-agent step of every drift workflow: the run context (SPEC-02 AC8).
//
//   node src/drift/prepare-run.mjs --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" \
//     --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN" \
//     [--factory-dir <directory> --stage-scripts <script>[,<script>...]]
//
// The configured target repository comes from CONFIGURED_TARGET_REPO (or --configured-target-repo), and the target
// checkout is <workspace>/<repository name> unless --checkout names another directory.
//
// The step exits 1, before the agent starts, when a non-empty target_repo differs from the configured repository. It
// writes <out>/run-context.json with the correlation id, the dispatch inputs and the base commit of the target checkout
// (`baseSha`). The verification steps that run after the agent do not read that file for the base commit, because the agent can
// edit anything under <out>: when the runner provides GITHUB_ENV, this step also appends SDLC_BASE_SHA=<base commit> to it, and
// the runner hands that variable to every later step (the validator of the audit compares the checkout against it). For a
// dry run it also leaves <out>/dry-run-proposal.json, the file in which the agent records the pull request it would have proposed and the
// drift report it would have filed (both null until it does).
// The same holds for the code that the verification steps run. A project that declares `driftAudit.stagedScripts` has the renderer pass --factory-dir (the
// directory of the workspace that the factory package runs from: `.` for the workspace itself) and --stage-scripts (those scripts, as workspace-relative
// paths). When the runner provides RUNNER_TEMP, this step then copies those scripts, the factory's modules (src/drift/lib/) and its package.json to
// ${RUNNER_TEMP}/gh-aw/sdlc-validator/, read-only, in a layout that mirrors the workspace: a script at <workspace>/<path> is at <stage>/<path>, and the factory
// at <workspace>/<factory-dir>/... is at <stage>/<factory-dir>/.... The compiled agent step mounts ${RUNNER_TEMP}/gh-aw read-only and the workspace, where
// those files also are, read-write, so an agent that rewrites the workspace copy cannot rewrite this one. The verification step compares the two and then runs the STAGED
// script, not the workspace one, because Node finds what `ai-sdlc-factory/drift-lib` is from where the script is (SPEC-02 AC22). Without --factory-dir nothing is staged.
// The script only reads the checkout and writes under --out (and appends the one line to GITHUB_ENV, and stages the copy under RUNNER_TEMP).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { factoryDirProblem, normalizeFactoryDir, stagedScriptProblem } from "../lib/factory-block.mjs";
import { parseBoolean, parseFlags, repoName, requireSlug, UsageError } from "./lib/args.mjs";
import { writeFilesAtomically } from "./lib/atomic.mjs";
import { BASE_SHA_VARIABLE, outDirectory, resolveIo, runAsMain, stableJson, VALIDATOR_STAGE_DIRECTORY, workspaceOf } from "./lib/cli.mjs";
import { CORRELATION_ID, runCorrelationId } from "./lib/correlation.mjs";

const OPTIONS = {
  out: { type: "string" },
  "target-repo": { type: "string" },
  "configured-target-repo": { type: "string" },
  checkout: { type: "string" },
  "correlation-id": { type: "string" },
  "extra-instructions": { type: "string" },
  "dry-run": { type: "string" },
  "factory-dir": { type: "string" },
  "stage-scripts": { type: "string" },
};

/** The package that holds this script (src/drift/prepare-run.mjs is two directories below its root): the factory whose modules are staged. */
const PACKAGE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const MAX_EXTRA_INSTRUCTIONS = 64 * 1024;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class RunFailure extends Error {}

/**
 * What the two staging flags ask for: null when --factory-dir is not given (nothing is staged), else the factory directory, normalized, and the scripts.
 * Everything is checked here, before anything is read or written, by the rules that the schema states for `factory.dir` and `stagedScripts`.
 */
function stagingRequest(flags) {
  const given = flags["factory-dir"];
  const list = flags["stage-scripts"];
  if (given === undefined) {
    if (list !== undefined) throw new UsageError("--stage-scripts needs --factory-dir (the directory of the workspace that the factory package runs from; . is the workspace itself)");
    return null;
  }
  if (given.trim() === "") throw new UsageError("--factory-dir must name a directory of the workspace (. is the workspace itself)");
  const dirProblem = factoryDirProblem(given);
  if (dirProblem !== null) throw new UsageError(`--factory-dir '${given.slice(0, 80)}' ${dirProblem}`);
  const scripts = [];
  for (const entry of list === undefined || list === "" ? [] : list.split(",")) {
    if (entry === "") throw new UsageError("--stage-scripts has an empty entry (the entries are separated by single commas)");
    const problem = stagedScriptProblem(entry);
    if (problem !== null) throw new UsageError(`--stage-scripts entry '${entry.slice(0, 80)}' ${problem}`);
    if (scripts.includes(entry)) throw new UsageError(`--stage-scripts lists '${entry}' twice`);
    scripts.push(entry);
  }
  return { factoryDir: normalizeFactoryDir(given), scripts };
}

/** The correlation id: the given one, else one derived from the run (`run-<run id>-<attempt>`, shared with the failure escalation), else "local". */
function resolveCorrelationId(given, env) {
  const text = String(given ?? "").trim();
  if (text !== "") {
    if (!CORRELATION_ID.test(text)) throw new RunFailure("correlation_id must be 1 to 128 characters of letters, digits and . _ : / + = -, starting with a letter or digit");
    return text;
  }
  return runCorrelationId(env) ?? "local";
}

function baseCommitOf(checkout, env) {
  let output;
  try {
    output = execFileSync("git", ["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? "").trim().split("\n")[0];
    throw new RunFailure(`the base commit of the target checkout '${checkout}' cannot be read: ${detail}`);
  }
  if (!COMMIT.test(output)) throw new RunFailure(`the target checkout '${checkout}' did not report a commit id`);
  return output;
}

/**
 * Hands the base commit to the later steps of the job: the runner reads the file that GITHUB_ENV names when this step ends and sets the
 * variable for every step after it. Outside Actions (no GITHUB_ENV) there is nothing to hand it to. The commit id was checked above to be
 * hexadecimal, so the line cannot carry anything else into the environment file.
 */
function exportBaseCommit(baseSha, io) {
  const file = String(io.env.GITHUB_ENV ?? "").trim();
  if (file === "") return false;
  try {
    io.fs.appendFileSync(file, `${BASE_SHA_VARIABLE}=${baseSha}\n`);
  } catch (error) {
    throw new RunFailure(`the base commit cannot be exported to the later steps through GITHUB_ENV (${file}): ${String(error.message ?? error).split("\n")[0]}`);
  }
  return true;
}

/**
 * The files of the factory package that the staged validator imports, as POSIX paths relative to the package root: every file below src/drift/lib/ and
 * package.json. Anything that is neither a file nor a directory (a link) cannot be copied as it is and is refused.
 */
function factoryFiles(factoryRoot, fs) {
  const found = ["package.json"];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(factoryRoot, ...relative.split("/")), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
      else throw new Error(`${child} is neither a file nor a directory`);
    }
  };
  walk(path.posix.join("src", "drift", "lib"));
  return found;
}

/** Whether `file` is a regular file itself (a link to one is not: `lstat` does not follow it). */
function isRegularFile(fs, file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** Makes a staged tree writable again, so that a second run in the same RUNNER_TEMP can replace it; a missing entry is nothing to do. */
function makeWritable(target, fs) {
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
    fs.chmodSync(target, 0o755);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) makeWritable(child, fs);
    else fs.chmodSync(child, 0o644);
  }
}

/**
 * Stages the scripts that the post-step verification runs under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, in a layout that mirrors the workspace, and makes them
 * read-only (files 0444, directories 0555): each declared script at its own workspace-relative path, and the factory's src/drift/lib/ and package.json under the
 * factory directory (the factory package is the one that holds this script, unless a test names another). The agent step that follows can write the workspace,
 * where the same files are, but not ${RUNNER_TEMP}/gh-aw, which the compiled `awf` command mounts read-only; the verification step that runs a script compares
 * the workspace copy with this one and then runs this one, the staged copy. Outside Actions (no RUNNER_TEMP) there is nothing to stage the copy for. Everything is checked before the stage is
 * touched, so a request that cannot be met leaves nothing behind.
 * @param {{ env: Record<string, string | undefined>, fs: typeof import("node:fs") }} io
 * @param {{ workspace: string, factoryDir: string, factoryRoot?: string, scripts?: string[] }} request
 * @returns {{ directory: string, files: number } | null}
 */
export function stageValidator(io, { workspace, factoryDir, factoryRoot = PACKAGE_ROOT, scripts = [] }) {
  const runnerTemp = String(io.env.RUNNER_TEMP ?? "").trim();
  if (runnerTemp === "") return null;
  const target = path.resolve(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY);
  try {
    const dirProblem = factoryDirProblem(factoryDir);
    if (dirProblem !== null) throw new Error(`the factory directory '${factoryDir}' ${dirProblem}`);
    const dir = normalizeFactoryDir(factoryDir);
    /** @type {[string, string][]} the source of each file, and its path relative to the stage */
    const entries = [];
    for (const script of scripts) {
      const problem = stagedScriptProblem(script);
      if (problem !== null) throw new Error(`'${script}' ${problem}`);
      const source = path.join(workspace, ...script.split("/"));
      if (!isRegularFile(io.fs, source)) throw new Error(`${script} is not a file in the workspace`);
      entries.push([source, script]);
    }
    for (const relative of factoryFiles(factoryRoot, io.fs)) {
      const source = path.join(factoryRoot, ...relative.split("/"));
      if (!isRegularFile(io.fs, source)) throw new Error(`${relative} is not a file of the factory package at ${factoryRoot}`);
      entries.push([source, dir === "." ? relative : path.posix.join(dir, relative)]);
    }
    const seen = new Set();
    for (const [, relative] of entries) {
      if (seen.has(relative)) throw new Error(`${relative} would be staged twice (a declared script is at the path of a file of the factory)`);
      seen.add(relative);
    }
    makeWritable(target, io.fs);
    io.fs.rmSync(target, { recursive: true, force: true });
    for (const [source, relative] of entries) {
      const destination = path.join(target, ...relative.split("/"));
      io.fs.mkdirSync(path.dirname(destination), { recursive: true });
      io.fs.copyFileSync(source, destination);
    }
    for (const [, relative] of entries) io.fs.chmodSync(path.join(target, ...relative.split("/")), 0o444);
    const directories = new Set([""]);
    for (const [, relative] of entries) for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) directories.add(parent);
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) io.fs.chmodSync(path.join(target, ...directory.split("/")), 0o555);
    return { directory: target, files: entries.length };
  } catch (error) {
    throw new RunFailure(`the validator cannot be staged under ${target}: ${String(error.message ?? error).split("\n")[0]}`);
  }
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const staging = stagingRequest(flags);
    const configured = requireSlug(flags["configured-target-repo"] ?? io.env.CONFIGURED_TARGET_REPO, "the configured target repository (CONFIGURED_TARGET_REPO)");
    const requested = String(flags["target-repo"] ?? "").trim();
    if (requested !== "" && requested.toLowerCase() !== configured.toLowerCase()) {
      throw new RunFailure(`target_repo '${requested.slice(0, 120)}' does not match the configured target repository '${configured}'; this workflow only runs on its configured repository`);
    }
    const dryRun = parseBoolean(flags["dry-run"], "dry_run");
    const correlationId = resolveCorrelationId(flags["correlation-id"], io.env);
    const extra = String(flags["extra-instructions"] ?? "");
    if (extra.length > MAX_EXTRA_INSTRUCTIONS) throw new RunFailure(`extra_instructions is longer than ${MAX_EXTRA_INSTRUCTIONS} characters`);
    if (extra.includes("\0")) throw new RunFailure("extra_instructions contains a NUL character");

    const checkoutName = flags.checkout ?? repoName(configured);
    const checkout = path.resolve(workspaceOf(io), checkoutName);
    const baseSha = baseCommitOf(checkout, io.env);
    const exported = exportBaseCommit(baseSha, io);
    const staged = staging === null ? null : stageValidator(io, { workspace: workspaceOf(io), ...staging });

    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    const files = [
      {
        path: path.join(out, "run-context.json"),
        data: stableJson({
          version: 1,
          target_repo: configured,
          checkout: checkoutName,
          baseSha,
          correlation_id: correlationId,
          extra_instructions: extra,
          dry_run: dryRun,
        }),
      },
    ];
    if (dryRun) {
      files.push({
        path: path.join(out, "dry-run-proposal.json"),
        data: stableJson({
          version: 1,
          dry_run: true,
          proposal: null,
          report: null,
          instructions:
            "Replace `proposal` with the pull request you would have proposed: { branch, title, body, draft, labels, reviewers, files }, and `report` with the drift report you would have filed: { title, body }. Change this file with the edit tool. Do not call create_pull_request or create_issue.",
        }),
      });
    }
    writeFilesAtomically(files, { fs: io.fs });
    io.stdout(`prepare-run: run context for ${configured} written to ${path.join(out, "run-context.json")} (base ${baseSha.slice(0, 12)}${exported ? `, exported as ${BASE_SHA_VARIABLE}` : ""}${staged === null ? "" : `, ${staged.files} validator files staged read-only under ${staged.directory}`}, dry run: ${dryRun ? "yes" : "no"}, correlation id ${correlationId})\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`prepare-run: ${error.message}\n`);
      return 2;
    }
    io.stderr(`prepare-run: ${error.message}\n`);
    return 1;
  }
}

await runAsMain(import.meta.url, run);
