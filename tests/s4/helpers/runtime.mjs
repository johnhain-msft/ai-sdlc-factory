// A dispatched run of one AI adaptation workflow, executed for real in bash against local git checkouts: the rendered pre-agent-steps, the commands of the prompt (what
// the agent is told to run) and the rendered post-steps. `gh` and `npm` are stand-ins on PATH (a read-only gh that answers the GETs of the workflows from files, an npm that
// records the preset's commands and reproduces their local file effects); everything else is the real thing: bash, git, node and the helper commands.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BashSandbox } from "../../s1/helpers/bash-runtime.mjs";
import { installFactory } from "../../helpers/adopter.mjs";
import { presetAbs } from "../../helpers/preset.mjs";
import { abs, commitAll, git, installVitestStub, passingReport, readText, tempDir, writeFiles } from "./fixtures.mjs";
import { CHANGED_SOURCE, INPUT_REPORTS, RUNS, commandPlan, downstreamFiles, downstreamName, fileIn, upstreamFiles } from "./example-world.mjs";
import { edgeOf, workflowOf } from "./workflows.mjs";

const forward = (value) => value.replace(/\\/g, "/");
const WINDOWS = process.platform === "win32";
export const IDENTITY = { GIT_AUTHOR_NAME: "S4 Agent", GIT_AUTHOR_EMAIL: "agent@example.invalid", GIT_COMMITTER_NAME: "S4 Agent", GIT_COMMITTER_EMAIL: "agent@example.invalid" };

const GH = `#!/usr/bin/env bash
# a read-only gh for the runtime tests: it logs every call, refuses every write, and answers the GETs that the workflows make from files that the test supplies
printf '%s\\n' "gh $*" >> "$STUB_LOG"
if [ "\${1:-}" != "api" ]; then echo "stub gh: not available: $*" >&2; exit 97; fi
for argument in "$@"; do
  case "$argument" in
    -X|--method|--method=*|-f|-F|--field|--raw-field|--input) echo "WRITE gh $*" >> "$STUB_LOG"; echo "stub gh: a write is refused" >&2; exit 98 ;;
  esac
done
case "\${2:-}" in
  repos/*/pulls\\?*) cat "$STUB_PULL" ;;
  repos/*/actions/runs\\?*) cat "$STUB_RUNS" ;;
  *) echo "stub gh: unexpected request \${2:-}" >&2; exit 97 ;;
esac
`;

/** Derive a strict shell allowlist once. Commands with no fixture effect need no extra Node process. */
function packageShim(tool, plan, upstream) {
  const pattern = (args) => `"${args.map((argument) => forward(argument) === forward(upstream)
    ? "$UPSTREAM_DIR"
    : argument.replace(/[\\"$`]/g, "\\$&")).join(" ")}"`;
  const cases = [];
  if (tool === "npm" && plan.inputCheck) cases.push(`  ${pattern(plan.inputCheck)}) cat "$STUB_INPUT_REPORT" || exit 2; exit "\${STUB_INPUT_RC:-0}" ;;`);
  const effects = tool === "npm" ? [plan.inputAccept, plan.generated ? plan.build : null].filter(Boolean) : [];
  if (effects.length > 0) cases.push(`  ${effects.map(pattern).join("|")}) exec node "$STUB_DIR/command-runner.mjs" ${tool} "$@" ;;`);
  const allowed = [...new Set(plan.allowed[tool].map(pattern))];
  if (allowed.length > 0) cases.push(`  ${allowed.join("|")}) exit 0 ;;`);
  const prefix = `STUB_${tool.toUpperCase()}_FAIL`;
  return `#!/usr/bin/env bash
printf '%s\\n' "${tool} $*" >> "$STUB_LOG"
if [ -n "\${${prefix}:-}" ] && [ "$*" = "$${prefix}" ]; then echo "stub ${tool}: $* fails on purpose" >&2; exit "\${${prefix}_RC:-1}"; fi
case "$*" in
${cases.join("\n")}
  *) echo "stub ${tool}: unexpected command: $*" >&2; exit 97 ;;
esac
`;
}

/** The ten dispatch inputs of a run (strings, as the dispatch API carries them), with the values that a test overrides. */
export function dispatchInputs(spec, overrides = {}) {
  return {
    correlation_id: "example-dispatch-1",
    upstream_repo: spec.upstreamRepo,
    previous_sha: "",
    upstream_sha: "",
    upstream_etag: '"etag-1"',
    upstream_pr_number: "7",
    downstream_repo: edgeOf(spec).downstreamRepo,
    sync_scope: spec.scopes[0],
    on_commit_only_advance: "noop",
    dry_run: "",
    ...overrides,
  };
}

/** Replaces the `${{ inputs.x }}`, `${{ github.token }}` and `${{ secrets.x }}` of a step's env with the values of the run. */
function resolveEnv(env, inputs) {
  const resolved = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    resolved[name] = String(value).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expression) => {
      if (expression.startsWith("inputs.")) {
        const key = expression.slice("inputs.".length);
        if (!Object.hasOwn(inputs, key)) throw new Error(`the dispatch carries no input ${key}`);
        return inputs[key];
      }
      if (expression === "github.token" || expression.startsWith("secrets.") || /^steps\.(?:app_token|factory_token)\.outputs\.token$/.test(expression)) return "stub-token";
      throw new Error(`this runtime cannot resolve \${{ ${expression} }}`);
    });
  }
  return resolved;
}

function init(directory) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(directory, ["config", "core.autocrlf", "false"]);
  git(directory, ["config", "core.safecrlf", "false"]);
}

const templates = new Map();
let baseTemplate;
/** All dispatch variants start with the same committed source and downstream bytes; only the target upstream commit differs. */
function base() {
  if (!baseTemplate) {
    const root = tempDir("sdlc-s4-run-base-");
    const downstream = path.join(root, "downstream");
    const upstream = path.join(root, "upstream");
    init(upstream);
    writeFiles(upstream, upstreamFiles());
    const previousSha = commitAll(upstream, "previous");
    init(downstream);
    writeFiles(downstream, downstreamFiles(previousSha));
    const baseSha = commitAll(downstream, "the last merged downstream revision");
    const workspace = path.join(root, "workspace");
    installFactory(workspace);
    fs.cpSync(presetAbs("scripts"), path.join(workspace, "scripts"), { recursive: true });
    fs.copyFileSync(presetAbs("sdlc.yaml"), path.join(workspace, "sdlc.yaml"));
    baseTemplate = { downstream, upstream, workspace, previousSha, baseSha };
  }
  return baseTemplate;
}

/**
 * The two checkouts of a run, built once for each kind of upstream change and copied for every run (a copy of a copy is cheap; starting git and node is not): the
 * downstream at the last merged revision (a git work tree, with a Vitest stand-in under node_modules, which git ignores) and the upstream checkout with the previous
 * and the target commit.
 */
function template(sourceChanged) {
  if (!templates.has(sourceChanged)) {
    const initial = base();
    const root = tempDir("sdlc-s4-run-template-");
    const upstream = path.join(root, "upstream");
    fs.cpSync(initial.upstream, upstream, { recursive: true });
    const source = fileIn(upstream, CHANGED_SOURCE);
    if (sourceChanged) fs.appendFileSync(source, "\nAn additional example paragraph.\n");
    else {
      fs.mkdirSync(path.join(upstream, "docs"), { recursive: true });
      fs.writeFileSync(path.join(upstream, "docs", "changelog.md"), "Only the changelog changed.\n");
    }
    const upstreamSha = commitAll(upstream, "target");
    templates.set(sourceChanged, { ...initial, upstream, upstreamSha });
  }
  return templates.get(sourceChanged);
}

/**
 * @param {object} spec one of AI of helpers/workflows.mjs
 * @param {object} [options]
 * @param {boolean} [options.sourceChanged] a source page changed; false: only docs/changelog.md changes
 * @param {object} [options.inputs] overrides of the dispatch inputs
 * @param {string} [options.pull] the first open pull request for the branch as the stub gh answers it (JSON text), default null
 * @param {string} [options.runs] the actions runs response of the stub gh
 * @param {string} [options.inputReport] the opaque text that the input-check stand-in prints
 * @param {number} [options.inputRc] its exit code
 */
export function createRun(spec, options = {}) {
  const box = new BashSandbox();
  const stubs = path.join(box.root, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  const log = path.join(box.root, "stub-log.txt");
  fs.writeFileSync(log, "");
  for (const [name, text] of [["gh", GH]]) {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, text);
    if (!WINDOWS) fs.chmodSync(file, 0o755);
  }
  fs.copyFileSync(abs("tests", "s4", "helpers", "command-runner.mjs"), path.join(stubs, "command-runner.mjs"));
  fs.writeFileSync(path.join(box.root, "pull.json"), options.pull ?? "null\n");
  fs.writeFileSync(path.join(box.root, "runs.json"), options.runs ?? `${JSON.stringify({ total_count: RUNS.length, workflow_runs: RUNS.map((run) => ({ ...run, status: "completed" })) })}\n`);
  fs.writeFileSync(path.join(box.root, "input-report.txt"), options.inputReport ?? INPUT_REPORTS.clean);

  // The actual package exports and example scripts are copies, never links or network installations.
  const cached = template(options.sourceChanged ?? true);
  const { previousSha, baseSha, upstreamSha } = cached;
  fs.cpSync(cached.workspace, box.work, { recursive: true });
  const downstream = path.join(box.work, downstreamName(spec));
  fs.cpSync(cached.downstream, downstream, { recursive: true });
  installVitestStub(downstream, passingReport(edgeOf(spec).immutableGates.lockedTestBlocks, forward(downstream)));
  const upstream = path.join(box.work, "upstream", spec.repo);
  fs.mkdirSync(path.dirname(upstream), { recursive: true });
  fs.cpSync(cached.upstream, upstream, { recursive: true });
  const plan = commandPlan(spec, upstream);
  fs.writeFileSync(path.join(stubs, "plan.json"), JSON.stringify(plan));
  for (const tool of ["npm", "npx"]) {
    const file = path.join(stubs, tool);
    fs.writeFileSync(file, packageShim(tool, plan, upstream));
    if (!WINDOWS) fs.chmodSync(file, 0o755);
  }

  const inputs = dispatchInputs(spec, { previous_sha: previousSha, upstream_sha: upstreamSha, ...(options.inputs ?? {}) });
  const frontmatter = workflowOf(spec).frontmatter;
  const edge = edgeOf(spec);
  // Use this test process's real Node binary before a host version-manager launcher, without discarding its environment or the rest of PATH.
  const searchPath = [forward(stubs), forward(path.dirname(process.execPath)), process.env.PATH ?? process.env.Path ?? ""].join(WINDOWS ? ";" : ":");

  const run = {
    spec,
    edge,
    box,
    inputs,
    frontmatter,
    downstream,
    upstream,
    baseSha,
    previousSha,
    upstreamSha,
    workspace: box.work,
    log,
    /** The environment of a step: the run's own, the stand-ins, the lines that earlier steps appended to GITHUB_ENV, then the step's. */
    env(step = {}, extra = {}) {
      return {
        PATH: searchPath,
        Path: searchPath,
        STUB_DIR: forward(stubs),
        STUB_LOG: forward(log),
        STUB_PULL: forward(path.join(box.root, "pull.json")),
        STUB_RUNS: forward(path.join(box.root, "runs.json")),
        STUB_PLAN: forward(path.join(stubs, "plan.json")),
        STUB_INPUT_REPORT: forward(path.join(box.root, "input-report.txt")),
        STUB_INPUT_RC: String(options.inputRc ?? 0),
        GIT_CONFIG_GLOBAL: forward(path.join(box.root, "no-global-config")),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GH_TOKEN: "stub-token",
        ...IDENTITY,
        ...box.environment(),
        ...resolveEnv(step.env, inputs),
        ...extra,
      };
    },
    /** Runs one rendered step (a `run:` step of the frontmatter) in its own bash process, in its working directory. */
    step(step, extra = {}) {
      if (typeof step.run !== "string") throw new Error(`step '${step.name}' has no run`);
      return box.run(step.run, run.env(step, extra), step["working-directory"] ?? "");
    },
    /** Runs a script (not a step) from a directory of the workspace. */
    script(text, extra = {}, directory = "") {
      return box.run(text, run.env({}, extra), directory);
    },
    pre: () => frontmatter["pre-agent-steps"],
    post: () => frontmatter["post-steps"],
    /** The post-steps in order, each in its own bash process fed only by the GITHUB_ENV lines of the earlier steps; an action (a `uses:` step) is skipped; stops at the first failure. */
    runPost(extra = {}) {
      const results = [];
      for (const step of run.post()) {
        if (typeof step.run !== "string") {
          results.push({ name: step.name ?? step.uses, skipped: true, status: 0, stdout: "", stderr: "" });
          continue;
        }
        const result = run.step(step, extra);
        results.push({ name: step.name, status: result.status, stdout: result.stdout, stderr: result.stderr });
        if (result.status !== 0) break;
      }
      return results;
    },
    /** What the agent does after reading the evidence: the commands of its prompt, run from the workspace with the environment that the pre-agent-steps exported. */
    agentRuns(extra = {}) {
      return run.script(promptBlock(workflowOf(spec).body), extra);
    },
    /** Every rendered pre-agent step, including the local factory install; action steps have local stand-ins, and the first shell failure stops the sequence. */
    runPre(extra = {}) {
      const results = [];
      for (const step of run.pre()) {
        if (typeof step.run !== "string") {
          results.push({ name: step.name ?? step.uses, skipped: true, status: 0, stdout: "", stderr: "" });
          continue;
        }
        const result = run.step(step, extra);
        results.push({ name: step.name, status: result.status, stdout: result.stdout, stderr: result.stderr });
        if (result.status !== 0) break;
      }
      return results;
    },
    artifact: (name) => box.readArtifact(`agent/${name}`),
    hasArtifact: (name) => fs.existsSync(path.join(box.artifacts, "agent", name)),
    porcelain: () => git(downstream, ["status", "--porcelain", "--untracked-files=all"]).stdout,
    upstreamPorcelain: () => git(upstream, ["status", "--porcelain", "--untracked-files=all"]).stdout,
    head: () => git(downstream, ["rev-parse", "HEAD"]).stdout.trim(),
    /** What the stand-ins were asked, one line per call. */
    calls: () => readText(log).split("\n").filter((line) => line !== ""),
    /** The commands of the prompt's fenced bash block: what the agent is told to run, in order. */
    promptCommands: () => promptBlock(workflowOf(spec).body),
    cleanup: () => box.cleanup(),
  };
  return run;
}

/** The commands of the first fenced bash block of a prompt, as one script. */
export function promptBlock(body) {
  const match = /```bash\n([\s\S]*?)\n```/.exec(body);
  if (!match) throw new Error("the prompt has no fenced bash block");
  return match[1];
}

/** Files written and committed in the synthetic downstream: the state that an agent's commit leaves. */
export function commitInDownstream(run, files, message = "the agent's commit") {
  writeFiles(run.downstream, files);
  return commitAll(run.downstream, message);
}

/** The environment lines that a step appended to GITHUB_ENV, as an object. */
export const exported = (run) => run.box.environment();

export { spawnSync };
