// The edge-declared preflights of the router (SPEC-03 AC20-AC23, AC40): the checks that decide, before a cascade is dispatched, whether an upstream advance
// changed anything that the downstream depends on. They are data of the edge, and the engine reads no command by its shape:
//
//   - `preflightCommands` are run with the downstream checkout as the working directory (a `git` command in the workspace, where it can compare two commits of
//     the upstream checkout) and the upstream checkout, at the target, bound as "$UPSTREAM_DIR"; none is run with --accept. `<checkout>` is that checkout,
//     `<factory>` the directory that the manifest's factory block names, `<factory-dir>` the same relative to the workspace.
//   - the verdict of a command is its exit code: 0 no drift, 1 drift, anything else a failure of the preflight (which fails the job and writes nothing). A
//     command that prints a report that its exit code does not tell (a check that exits 1 whenever the commit differs, whatever the inputs say) names a
//     `classifier` in the same position of the edge's `preflightChecks`: a command that the router runs after the check, in the same directory and with the same
//     scrubbed environment, plus SDLC_PREFLIGHT_INDEX (the position of the check, from 0), SDLC_PREFLIGHT_COMMAND (the command as the manifest declares it),
//     SDLC_PREFLIGHT_EXIT_CODE, SDLC_PREFLIGHT_STDOUT_FILE and SDLC_PREFLIGHT_STDERR_FILE (the two streams of the check, in files that are removed afterwards).
//     Its exit code is then the verdict, by the same rule, and it is told the exit code of the check, so that it is the one that decides what that means.
//   - a check may name the `scope` that a drift of its command asks the dispatch for, and the `noopAction` that an unchanged result is recorded as.
//
// All the commands run before any is judged. A drift asks for the scope of the checks that drifted (the one scope when they agree, both when they differ, none
// when no drifted check names one); an unchanged result is recorded as the noop action that a check declares, else as no material drift; and a commit-only
// advance of an edge that bumps the provenance is dispatched with the same rule applied to every check.
//
// One thing is looked at before any command runs. A command (or a classifier) that starts a node script names a file, and node exits 1 for a file that is not
// there; by the exit-code rule that is a drift, and the router would dispatch a cascade for an orchestrator that lacks a helper that its manifest declares. A script
// that is not there is therefore a failure of the preflight. Only a script that is named plainly is looked for (see declaredScript); every other command is judged
// by its exit code and nothing else.
//
// The router never changes the downstream checkout that it made.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fillPlaceholders, resolveFactory } from "../lib/factory-block.mjs";
import { childEnvironment, ensureCheckout, execute, toShellPath } from "./git.mjs";
import { splitSlug } from "./edges.mjs";

const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_NOOP_ACTION = "noop-no-material-drift";
const SCRIPT_FILE = /\.(?:mjs|cjs|js|mts|cts|ts)$/;
// options of node whose word is code, or a module that is loaded first: what runs is then not the first word that is not an option
const NODE_OPTIONS_THAT_RUN_CODE = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader", "-c", "--check", "-i", "--interactive"]);

/** A preflight that cannot decide: the router job fails and writes nothing (AC20, AC23, AC28). */
export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreflightError";
  }
}

/** `<checkout>` in a command is the absolute path of the upstream checkout. (The router also expands `<factory>` and `<factory-dir>`: fillPlaceholders.) */
export const fillCheckout = (command) => String(command).split("<checkout>").join('"$UPSTREAM_DIR"');

const tailOf = (result) => `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-6).join(" | ");

/**
 * The sync_scope that a dispatch carries, within what the edge's workflow accepts.
 * @param {string | null} wanted the scope that the preflight outcome names
 * @param {string[] | undefined} allowed the edge's syncScopes (undefined: every scope is accepted)
 */
export function chooseSyncScope(wanted, allowed) {
  const scope = wanted ?? "both";
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes(scope)) return scope;
  return allowed.includes("both") ? "both" : allowed[0];
}

/** The scope that a set of checks asks for: the one that they declare, both when they declare different ones, none when none does. */
function scopeOf(verdicts) {
  const scopes = [...new Set(verdicts.map((verdict) => verdict.scope).filter((scope) => scope !== null))];
  return scopes.length === 0 ? null : scopes.length === 1 ? scopes[0] : "both";
}

/**
 * The leading words of a shell command: quotes removed, nothing expanded, up to the first control operator or line end. Enough to read what a command starts; it
 * is not a shell.
 */
function leadingWords(command, limit = 16) {
  const words = [];
  let word = null;
  let index = 0;
  const finish = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  while (index < command.length && words.length < limit) {
    const char = command[index];
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) return words;
      word = (word ?? "") + command.slice(index + 1, close);
      index = close + 1;
    } else if (char === '"') {
      let text = "";
      let cursor = index + 1;
      while (cursor < command.length && command[cursor] !== '"') {
        if (command[cursor] === "\\" && cursor + 1 < command.length && '"\\$`'.includes(command[cursor + 1])) cursor += 1;
        text += command[cursor];
        cursor += 1;
      }
      if (cursor >= command.length) return words;
      word = (word ?? "") + text;
      index = cursor + 1;
    } else if (char === "\\") {
      word = (word ?? "") + (command[index + 1] ?? "");
      index += 2;
    } else if (/[\r\n;&|<>()]/.test(char)) {
      finish();
      return words;
    } else if (/\s/.test(char)) {
      finish();
      index += 1;
    } else {
      word = (word ?? "") + char;
      index += 1;
    }
  }
  finish();
  return words;
}

/**
 * The script file that a command starts, when it starts one plainly: `node [options] <file>.mjs|.cjs|.js|.ts ...`, the file given relative to where the command
 * runs, or under $GITHUB_WORKSPACE or $UPSTREAM_DIR (`<checkout>`). Anything that the shell would have to expand first (another variable, a substitution, a glob, ~),
 * an absolute path, a file that is not a script and a command that does not start with node are not guessed at: null.
 * @returns {{ script: string, file: string } | null} the word as written (without quotes) and the file that it names
 */
export function declaredScript(command, { workspace, upstreamDir, cwd }) {
  const words = leadingWords(String(command));
  if (words[0] !== "node") return null;
  let script = null;
  for (const word of words.slice(1)) {
    if (word.startsWith("-")) {
      if (NODE_OPTIONS_THAT_RUN_CODE.has(word)) return null;
      continue;
    }
    script = word;
    break;
  }
  if (script === null || !SCRIPT_FILE.test(script)) return null;
  let base = cwd;
  let rest = script;
  const rooted = /^\$(?:\{(GITHUB_WORKSPACE|UPSTREAM_DIR)\}|(GITHUB_WORKSPACE|UPSTREAM_DIR))(?=\/)/.exec(script);
  if (rooted !== null) {
    base = (rooted[1] ?? rooted[2]) === "GITHUB_WORKSPACE" ? workspace : upstreamDir;
    rest = script.slice(rooted[0].length).replace(/^\/+/, "");
  }
  if (rest === "" || /[$`*?[\]{}~]/.test(rest) || /^(?:\/|[A-Za-z]:)/.test(rest)) return null;
  return { script, file: path.resolve(base, ...rest.split("/")) };
}

/**
 * @param {object} ctx
 * @param {object} ctx.edge the router edge
 * @param {object | undefined} ctx.manifestEdge the same edge as the manifest has it: its syncScopes, preflightChecks and logProvenance
 * @param {object | undefined} ctx.factory the manifest's factory block, resolved (resolveFactory); absent is the factory in the workspace
 * @param {string} ctx.targetSha
 * @param {string} ctx.lastMergedSha
 * @param {string} ctx.downstreamSha the head of the downstream's default branch that was read
 * @param {string} ctx.workspace GITHUB_WORKSPACE
 * @param {string} ctx.serverUrl
 * @param {Record<string, string | undefined>} ctx.environment the environment of the router (only allowlisted variables reach a child)
 * @param {(slug: string) => string} ctx.readTokenFor
 * @param {string} [ctx.bash]
 * @param {(line: string) => void} ctx.log
 * @returns {Promise<{ drift: boolean, scope: string | null, noopAction: string | null, summary: string }>}
 * @throws {PreflightError | import("./git.mjs").CheckoutError | RoutingDataError}
 */
export async function runPreflight(ctx) {
  const { edge, log } = ctx;
  // the processes that a preflight starts; a test may replace them to exercise the classification without a shell
  const deps = { ensureCheckout, execute, ...(ctx.deps ?? {}) };
  const allowed = ctx.manifestEdge?.syncScopes;
  const commands = edge.preflightCommands;
  if (commands.length === 0) {
    return { drift: true, scope: chooseSyncScope(null, allowed), noopAction: null, summary: "the edge declares no preflight" };
  }
  if (ctx.manifestEdge === undefined) {
    throw new PreflightError(`the manifest has no dependencyEdges entry for ${edge.upstreamRepo}, so the preflightChecks of ${edge.edgeId} are not known and its preflight cannot be judged`);
  }
  const checks = ctx.manifestEdge.preflightChecks ?? commands.map(() => ({}));
  if (!Array.isArray(checks) || checks.length !== commands.length) {
    throw new PreflightError(`${edge.edgeId} declares ${Array.isArray(checks) ? checks.length : "no list of"} preflightChecks for ${commands.length} preflightCommands (one entry for each command, in order)`);
  }
  const classifierOf = (index) => (typeof checks[index]?.classifier === "string" && checks[index].classifier.trim() !== "" ? checks[index].classifier : null);

  const factory = ctx.factory ?? resolveFactory({});
  const downstreamName = splitSlug(edge.downstreamRepo).repo;
  const upstreamName = splitSlug(edge.upstreamRepo).repo;
  const downstreamDir = path.join(ctx.workspace, downstreamName);
  const upstreamDir = path.join(ctx.workspace, "upstream", upstreamName);
  const bash = ctx.bash ?? "bash";
  const readToken = ctx.readTokenFor(edge.upstreamRepo);

  let upstreamReady = false;
  const referencesLastMerged = [...commands, ...commands.map((_, index) => classifierOf(index) ?? "")].some((text) => text.includes("LAST_MERGED_SHA"));
  const prepareUpstream = async () => {
    if (upstreamReady) return;
    await deps.ensureCheckout({
      dir: upstreamDir,
      serverUrl: ctx.serverUrl,
      slug: edge.upstreamRepo,
      sha: ctx.targetSha,
      branch: edge.upstreamDefaultBranch,
      // a command that compares two commits needs the history that holds both; the others read the tree of the target
      history: referencesLastMerged ? "full" : "shallow",
      mustContain: referencesLastMerged ? [ctx.lastMergedSha] : [],
      token: readToken,
      environment: ctx.environment,
    });
    upstreamReady = true;
  };
  let downstreamReady = false;
  const prepareDownstream = async () => {
    if (downstreamReady) return;
    await deps.ensureCheckout({
      dir: downstreamDir,
      serverUrl: ctx.serverUrl,
      slug: edge.downstreamRepo,
      sha: ctx.downstreamSha,
      token: ctx.readTokenFor(edge.downstreamRepo),
      environment: ctx.environment,
    });
    downstreamReady = true;
    if (commands.some((text) => /^\s*(npm|npx)\s/.test(text))) {
      // the downstream's own scripts need its dependencies; lifecycle scripts of a dependency never run in the router
      const install = await deps.execute(bash, ["--noprofile", "--norc", "-c", "npm ci --include=dev --ignore-scripts"], {
        cwd: downstreamDir,
        env: commandEnvironment(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (install.error !== null || install.code !== 0) throw new PreflightError(`installing the dependencies of ${edge.downstreamRepo} failed (exit ${install.code}): ${tailOf(install)}`);
    }
  };
  const commandEnvironment = (extra = {}) =>
    childEnvironment(ctx.environment, {
      GITHUB_WORKSPACE: toShellPath(ctx.workspace),
      UPSTREAM_DIR: toShellPath(upstreamDir),
      TARGET_SHA: ctx.targetSha,
      LAST_MERGED_SHA: ctx.lastMergedSha,
      GH_TOKEN: readToken,
      ...extra,
    });
  const runShell = (command, cwd, extra) =>
    deps.execute(bash, ["--noprofile", "--norc", "-c", fillPlaceholders(command, factory)], { cwd, env: commandEnvironment(extra), timeoutMs: COMMAND_TIMEOUT_MS });

  // A git command compares commits of the upstream checkout and runs in the workspace; every other command runs in the downstream checkout.
  const runsInWorkspace = (text) => /^\s*git\s/.test(text);
  await prepareUpstream();
  if (commands.some((text) => !runsInWorkspace(text))) await prepareDownstream();
  // a node script that is not there would exit 1, which is a drift: it is a failure of the preflight instead, found before anything is run
  for (const [index, text] of commands.entries()) {
    const cwd = runsInWorkspace(text) ? ctx.workspace : downstreamDir;
    for (const [kind, command] of [["command", text], ["classifier", classifierOf(index)]]) {
      if (command === null) continue;
      const named = declaredScript(fillPlaceholders(command, factory), { workspace: ctx.workspace, upstreamDir, cwd });
      if (named === null || fs.existsSync(named.file)) continue;
      const shown = path.relative(ctx.workspace, named.file).split(path.sep).join("/");
      const of = kind === "classifier" ? ` of the check '${text}'` : "";
      throw new PreflightError(
        `the preflight ${kind} '${command}'${of} runs ${shown.startsWith("..") ? named.script : shown}, which does not exist in the workspace: node exits 1 for a file that is not there and exit 1 is a drift, ` +
          `so ${edge.edgeId} cannot be judged. Add the script to the orchestrator, or correct the ${kind} in the manifest`,
      );
    }
  }
  // the commands run first, in the order that the edge lists them, all of them before any is judged
  const outcomes = [];
  for (const [index, text] of commands.entries()) {
    log(`preflight: ${text}`);
    const cwd = runsInWorkspace(text) ? ctx.workspace : downstreamDir;
    outcomes.push({ index, text, cwd, result: await runShell(text, cwd) });
  }

  const findings = [];
  const verdicts = [];
  let scratch = null;
  try {
    for (const { index, text, cwd, result } of outcomes) {
      if (result.error !== null && result.code === null) throw new PreflightError(`the preflight command '${text}' could not be run: ${result.error}`);
      if (result.timedOut) throw new PreflightError(`the preflight command '${text}' did not finish in ${COMMAND_TIMEOUT_MS / 60000} minutes`);
      const classifier = classifierOf(index);
      let drift;
      if (classifier === null) {
        if (result.code !== 0 && result.code !== 1) throw new PreflightError(`'${text}' exited with ${result.code}: ${tailOf(result)}`);
        drift = result.code === 1;
        findings.push(`check '${text}': exit ${result.code}`);
      } else {
        // the check's two streams, in files that only this job can read and that are removed with the directory when the preflight ends
        scratch ??= fs.mkdtempSync(path.join(ctx.environment.RUNNER_TEMP || os.tmpdir(), "sdlc-preflight-"));
        const stdoutFile = path.join(scratch, `check-${index}.stdout`);
        const stderrFile = path.join(scratch, `check-${index}.stderr`);
        fs.writeFileSync(stdoutFile, result.stdout);
        fs.writeFileSync(stderrFile, result.stderr);
        log(`preflight: classifier ${classifier}`);
        const verdict = await runShell(classifier, cwd, {
          SDLC_PREFLIGHT_INDEX: String(index),
          SDLC_PREFLIGHT_COMMAND: text,
          SDLC_PREFLIGHT_EXIT_CODE: String(result.code),
          SDLC_PREFLIGHT_STDOUT_FILE: toShellPath(stdoutFile),
          SDLC_PREFLIGHT_STDERR_FILE: toShellPath(stderrFile),
        });
        if (verdict.error !== null && verdict.code === null) throw new PreflightError(`the classifier '${classifier}' of the check '${text}' could not be run: ${verdict.error}`);
        if (verdict.timedOut) throw new PreflightError(`the classifier '${classifier}' of the check '${text}' did not finish in ${COMMAND_TIMEOUT_MS / 60000} minutes`);
        if (verdict.code !== 0 && verdict.code !== 1) throw new PreflightError(`the classifier '${classifier}' of the check '${text}' exited with ${verdict.code}: ${tailOf(verdict)}`);
        drift = verdict.code === 1;
        findings.push(`check '${text}': exit ${result.code}, classified as ${drift ? "drift" : "no drift"}`);
      }
      verdicts.push({ drift, scope: checks[index]?.scope ?? null, noopAction: checks[index]?.noopAction ?? null });
    }
  } finally {
    if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
  }

  const summary = findings.join("; ");
  const drifted = verdicts.filter((verdict) => verdict.drift);
  if (drifted.length > 0) return { drift: true, scope: chooseSyncScope(scopeOf(drifted), allowed), noopAction: null, summary };
  if (edge.onCommitOnlyAdvance === "bump-provenance") {
    return { drift: true, scope: chooseSyncScope(scopeOf(verdicts), allowed), noopAction: null, summary: `${summary}; a commit-only advance is bumped into the provenance (onCommitOnlyAdvance)` };
  }
  return { drift: false, scope: null, noopAction: verdicts.map((verdict) => verdict.noopAction).find((action) => action !== null) ?? DEFAULT_NOOP_ACTION, summary };
}
