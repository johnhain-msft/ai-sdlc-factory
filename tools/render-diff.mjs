#!/usr/bin/env node
// The compatibility harness of the factory (design G): proves that two renders of one fleet differ only by the classes that a change is allowed to make.
// It is built once here and used for the goldens of examples/, for the parity test of an instance and for every bump of the factory.
//
//   node tools/render-diff.mjs render  --instance <dir> --request <file> --out <dir> [--engine <dir>]
//        renders <dir> (its sdlc.yaml and instructions/) with renderFleet() of the engine, and writes the files that it returns under --out
//   node tools/render-diff.mjs compile --render <dir> --out <dir> [--actions-lock <file>] [--expect-version <v1.0.1>]
//        compiles the workflow sources of a render with `gh aw compile --strict --purge --json` in a scratch git repository, and writes the locks under --out
//   node tools/render-diff.mjs diff    --before <dir> --after <dir> --stage 0|1|2a|2b [--engine <dir>] [--package <name>] [--factory-dir <dir>]
//                                      [--manifest-path <path>] [--instance-scripts <name.mjs,...>]
//        compares two renders (or two sets of locks): the stage names the classes that may differ, every class must change exactly as often as its pattern occurs
//        on the before side, and what is left over is printed as a unified diff and fails the run
//   node tools/render-diff.mjs selftest --render <dir>
//        the harness checks itself on a render: before against before is empty, and an extra step, a changed permission and a swapped order are each reported
//
// The comparison is structural, not a regex over text. Every file is parsed (a workflow source into its frontmatter and its body, the router and the locks into
// their YAML, aw.json into its JSON), the rules of a class rewrite STRING VALUES and the body text of the before side, or the arrays of steps and the `with` of a
// checkout, and the two documents are compared as ordered JSON, so a changed path, flag, step, key order or prompt word is found. Each rule counts its rewrites,
// and the count has to equal the number of occurrences of the rule's own pattern on the before side, measured on its own: a rule cannot hide a change that is not
// its own. The classes (a render of the old shape, the in-repository factory, becomes the render of the new one, the factory in node_modules):
//
//   D1  instance-script path   $GITHUB_WORKSPACE/src/<name>            -> $GITHUB_WORKSPACE/scripts/<name>              for the names of --instance-scripts; in a validator comparison also
//                              the staged copy "$copy/<name>" -> "$copy/scripts/<name>" and the message "src/<name> is not the copy -> "scripts/<name> is not the copy
//   D2  factory-script path    $GITHUB_WORKSPACE/src/<script>          -> $GITHUB_WORKSPACE/<factory dir>/src/<script>  for a path that the engine's src/ holds
//   D3  sparse checkout        `src` `schemas`                         -> `/package.json` `/package-lock.json` `/<manifest>` and sparse-checkout-cone-mode: false
//   D4a install step           nothing                                 -> `- run: npm ci --ignore-scripts` first in the pre-agent-steps of an agent job that runs a factory script
//   D4b factory auth           each factory install step               -> the token step (id factory_token) and the install step with its git rewrites (private only)
//   D5  flag                   verify-immutable-gates.mjs --portfolio  -> --downstream
//   D6  dedupe argument        dedupe-open-prs.mjs ...                 -> ... --project <projectKey>
//   D7  staging arguments      prepare-run.mjs ...                     -> ... --factory-dir <dir> --stage-scripts <list>
//   D8  verification command   drift-lib in a validator comparison -> the expansion of the factory directory. From an instance that held the factory in its own src/: the staged copy
//                              "$copy/drift/lib", the workspace path "$GITHUB_WORKSPACE/src/drift/lib" and the message "src/drift/lib is not the copy. When the stage moves the factory,
//                              also from the stage-1 expansion of <factory> and <factory-dir>: $copy/./src/drift/lib, "$GITHUB_WORKSPACE"/src/drift/lib and ./src/drift/lib is not the copy.
//                              The comparison has two more clauses, and a before side that lacks one gets it (each counted once): the factory's package.json before the clause of drift-lib
//                              (its `exports` say where drift-lib is, and the stage-1 clause moves with the factory), and the refusal of scripts/node_modules after it (Node finds a package there
//                              before it looks in the workspace's node_modules). The command of an instance from before the split, and of the engine before the two clauses, are both explained.
//                              Where the stage moves the factory (2a, 2b) the comparison ends in a run of the STAGED copy: node "$GITHUB_WORKSPACE/scripts/<script>" (an instance script that D1 has moved
//                              from src/ is the same) becomes node "$copy/scripts/<script>", because Node finds what `ai-sdlc-factory/drift-lib` is from where the script is, and in the workspace a
//                              package.json of the agent's that names itself ai-sdlc-factory would be found before any node_modules. At stage 1 the factory is the workspace itself, and the
//                              stage-1 command keeps running the workspace copy: D8 leaves that run as it is
//   D9  onboarding prompt      node bin/sdlc-onboard.mjs               -> node <factory dir>/bin/sdlc-onboard.mjs
//   D10 lock metadata          the frontmatter and body hashes of a lock are masked wherever they differ
//
// Stages: 0 allows nothing (the harness itself); 1 allows D1 D5 D6 D7 D8 D10 (the generalized factory, in the repository); 2a adds D2 D3 D4a D9 (the factory in
// node_modules, no auth); 2b adds D4b (the private factory). Exit codes: 0 the renders agree modulo the allowed classes, 1 they do not or a render/compile
// was refused, 2 usage error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = ".github/workflows";
const WS = "$GITHUB_WORKSPACE";
const INSTALL_COMMAND = "npm ci --ignore-scripts";
const MASK = "<masked>";

export const STAGES = Object.freeze({
  0: [],
  1: ["D1", "D5", "D6", "D7", "D8", "D10"],
  "2a": ["D1", "D2", "D3", "D4a", "D5", "D6", "D7", "D8", "D9", "D10"],
  "2b": ["D1", "D2", "D3", "D4a", "D4b", "D5", "D6", "D7", "D8", "D9", "D10"],
});

export const CLASSES = Object.freeze([
  ["D1", "instance-script path"],
  ["D2", "factory-script path"],
  ["D3", "sparse checkout"],
  ["D4a", "install step in an agent job"],
  ["D4b", "factory auth (private)"],
  ["D5", "flag --portfolio -> --downstream"],
  ["D6", "dedupe argument --project"],
  ["D7", "staging arguments"],
  ["D8", "verification command"],
  ["D9", "onboarding prompt"],
  ["D10", "lock metadata"],
]);

/** A usage error or a refused render: the message is the whole report. */
export class HarnessError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

// ---- documents -----------------------------------------------------------------------------------------------------------------------------------

/** Parses one file of a render into the document that the comparison walks: workflow sources split into frontmatter and body, locks keep their metadata line. */
export function parseDocument(rel, text) {
  if (rel.endsWith(".lock.yml")) {
    const header = /^# gh-aw-metadata: (\{.*\})$/m.exec(text);
    return { rel, kind: "lock", value: YAML.parse(text), meta: header ? JSON.parse(header[1]) : null };
  }
  if (rel.endsWith(".md")) {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!match) throw new HarnessError(`${rel} has no frontmatter`, 1);
    return { rel, kind: "workflow", value: YAML.parse(match[1]), body: match[2] };
  }
  if (/\.ya?ml$/.test(rel)) return { rel, kind: "yaml", value: YAML.parse(text) };
  if (rel.endsWith(".json")) return { rel, kind: "json", value: JSON.parse(text) };
  return { rel, kind: "text", value: text };
}

/** The text that two documents are compared as: ordered JSON, so that key order and array order count. */
export function canonical(doc) {
  const json = (value) => JSON.stringify(value, null, 2);
  if (doc.kind === "workflow") return `${json(doc.value)}\n--- body ---\n${doc.body}`;
  if (doc.kind === "lock") return `${json(doc.meta)}\n--- workflow ---\n${json(doc.value)}`;
  return doc.kind === "text" ? doc.value : json(doc.value);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
/** The plain install step of a job, exactly `- run: npm ci --ignore-scripts` (the install of the target's dependencies has a name and a directory, so it is not one). */
const isBareInstall = (step) => isObject(step) && Object.keys(step).length === 1 && step.run === INSTALL_COMMAND;

function* strings(node) {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const item of node) yield* strings(item);
  else if (isObject(node)) for (const item of Object.values(node)) yield* strings(item);
}

// ---- the rules -----------------------------------------------------------------------------------------------------------------------------------

/** What the rules need to know of the engine, the adopter and the stage. */
function makeContext({ engine, packageName, factoryDir, manifestPath, instanceScripts, stage }) {
  const enginePaths = new Map();
  const engineHas = (relative) => {
    if (!enginePaths.has(relative)) enginePaths.set(relative, fs.existsSync(path.join(engine, "src", ...relative.split("/"))));
    return enginePaths.get(relative);
  };
  return {
    stage,
    enabled: new Set(STAGES[stage]),
    packageName,
    factoryDir,
    manifestPath,
    instanceScripts: new Set(instanceScripts),
    d1Shapes: d1Shapes(instanceScripts),
    engineHas,
    stageDir: stage === "1" ? "." : factoryDir,
    counts: Object.fromEntries(CLASSES.map(([id]) => [id, 0])),
    canonicalAuth: null,
    learnedStageScripts: null,
  };
}

const ENGINE_PATH = /\$GITHUB_WORKSPACE\/src\/([A-Za-z0-9_./-]+)/g;
/** The keys of a workflow's frontmatter whose steps run in the agent job (the custom jobs are not among them: they install the factory on their own). */
const AGENT_SECTIONS = ["pre-steps", "pre-agent-steps", "steps", "post-steps"];

/** The script path of a match, without the sentence punctuation that can follow it in a prompt. */
const pathOf = (match) => match.replace(/[./]+$/, "");

/** True when a string runs a script of the engine from the workspace's src/ (the old shape): the agent job that runs it needs the factory installed. */
function runsEngineScript(text, context) {
  for (const match of text.matchAll(ENGINE_PATH)) {
    const relative = pathOf(match[1]);
    if (!context.instanceScripts.has(relative) && context.engineHas(relative)) return true;
  }
  return false;
}

/** True when the agent job of a workflow runs a factory script on its host, in any of its own sections: it then gets the install step first in pre-agent-steps. */
const agentRunsFactoryScript = (object, context) => AGENT_SECTIONS.some((key) => Array.isArray(object[key]) && [...strings(object[key])].some((text) => runsEngineScript(text, context)));

/**
 * The spellings of drift-lib in a validator comparison, and what each becomes in the stage's directory. First those of an instance whose repository held the factory's
 * sources in its own src/ (the staged copy, the quoted workspace path and the message), which become the expansion of <factory> and <factory-dir> in the stage's
 * directory; then, when the stage moves the factory, those of the stage-1 expansion: the three of drift-lib, and the whole clause that compares package.json. Each pattern
 * is anchored by the quote that opens or closes it, or is a whole clause, so that a longer path or another message is no match.
 */
const d8Shapes = (dir) => {
  const factory = dir === "." ? WS : `${WS}/${dir}`;
  const shapes = [
    ['"$copy/drift/lib"', `"$copy/${dir}/src/drift/lib"`],
    [`"${WS}/src/drift/lib"`, `"${factory}"/src/drift/lib`],
    ['"src/drift/lib is not the copy', `"${dir}/src/drift/lib is not the copy`],
  ];
  if (dir !== ".") {
    shapes.push(
      ["$copy/./src/drift/lib", `$copy/${dir}/src/drift/lib`],
      [`"${WS}"/src/drift/lib`, `"${WS}/${dir}"/src/drift/lib`],
      ["./src/drift/lib is not the copy", `${dir}/src/drift/lib is not the copy`],
      [packageClause("."), packageClause(dir)],
    );
  }
  return shapes;
};

// The clauses of a validator comparison, in the order that a command has them: the script, the package.json of the factory, drift/lib, the refusal of scripts/node_modules.
// Each is a whole clause with its own `|| { echo "<message>" >&2; exit 1; }; `, spelled as the manifest's placeholders expand for a factory directory `dir` (`.` is the workspace).

/** What every comparison says when its file is not the copy that prepare-run made, from the word after the name of the file on. */
const NOT_THE_COPY = 'is not the copy that prepare-run made before the agent started" >&2; exit 1; }; ';
/** The clause that compares the factory's package.json with the copy: its `exports` decide where `ai-sdlc-factory/drift-lib` is found. */
const packageClause = (dir) => `cmp -s "$copy/${dir}/package.json" "${dir === "." ? WS : `${WS}/${dir}`}"/package.json || { echo "${dir}/package.json ${NOT_THE_COPY}`;
/** The clause that compares drift/lib with the copy. */
const libClause = (dir) => `diff -rq "$copy/${dir}/src/drift/lib" "${dir === "." ? WS : `${WS}/${dir}`}"/src/drift/lib >&2 || { echo "${dir}/src/drift/lib ${NOT_THE_COPY}`;
/** The same clause as an instance wrote it when its repository held the factory's sources in its own src/: it has no package.json clause before it. */
const LIB_CLAUSE_BEFORE_THE_SPLIT = `diff -rq "$copy/drift/lib" "${WS}/src/drift/lib" >&2 || { echo "src/drift/lib ${NOT_THE_COPY}`;
/** The clause that refuses a node_modules directory beside the validators: Node looks there for a package before it looks in the node_modules of the workspace. */
const REFUSAL_CLAUSE = `! test -e "${WS}/scripts/node_modules" || { echo "scripts/node_modules ${NOT_THE_COPY}`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The spellings in which a before side holds the drift-lib clause for a stage, and those of the package.json clause that goes before it (the stage-1 spelling moves with the factory). */
const libSpellings = (dir) => [LIB_CLAUSE_BEFORE_THE_SPLIT, libClause("."), ...(dir === "." ? [] : [libClause(dir)])];
const packageSpellings = (dir) => [packageClause("."), ...(dir === "." ? [] : [packageClause(dir)])];

/** Gives each drift-lib clause of a text (already in the stage's spelling) the package.json clause before it and the refusal after it that it lacks, and says how many it added. */
function addMissingClauses(text, dir) {
  const lib = libClause(dir);
  const before = packageClause(dir);
  let added = 0;
  const withPackage = text.replace(new RegExp(`(?<!${escapeRegExp(before)})${escapeRegExp(lib)}`, "g"), (clause) => {
    added += 1;
    return before + clause;
  });
  const complete = withPackage.replace(new RegExp(`${escapeRegExp(lib)}(?!${escapeRegExp(REFUSAL_CLAUSE)})`, "g"), (clause) => {
    added += 1;
    return clause + REFUSAL_CLAUSE;
  });
  return { text: complete, added };
}

/** How many of those clauses a line of the before side lacks, counted by cutting the line at each drift-lib clause of each spelling and reading what ends the part before it and starts the part after it. */
function countMissingClauses(line, dir) {
  let missing = 0;
  for (const lib of libSpellings(dir)) {
    const parts = line.split(lib);
    for (let index = 0; index + 1 < parts.length; index += 1) {
      if (!packageSpellings(dir).some((clause) => parts[index].endsWith(clause))) missing += 1;
      if (!parts[index + 1].startsWith(REFUSAL_CLAUSE)) missing += 1;
    }
  }
  return missing;
}

/**
 * The run that ends a validator comparison where the stage moves the factory: the comparison runs the STAGED copy of the script (`node "$copy/scripts/<script>"`), never the
 * workspace copy that it has just compared, because Node finds what `ai-sdlc-factory/drift-lib` is from where the script is, and in the workspace a package.json that names itself
 * ai-sdlc-factory is found before any node_modules. The before side runs the workspace copy: from scripts/ (the stage-1 command of an instance), or from src/ (before the split),
 * which D1 has moved to scripts/ by the time that D8 reads it. At stage 1 the factory is the workspace itself and the stage-1 command keeps running the workspace copy, so there is
 * no run to turn.
 */
const workspaceRun = () => new RegExp(`${escapeRegExp(REFUSAL_CLAUSE)}node "${escapeRegExp(WS)}/scripts/([A-Za-z0-9_./-]+)"`, "g");

/**
 * How many runs of a workspace copy the before side ends a validator comparison with, on a line, where D8 turns them into the staged copy: cut at each drift-lib clause of each
 * spelling, the part after it (and after the refusal, when it has one) starts with `node "$GITHUB_WORKSPACE/scripts/<script>"`, or `src/<script>` for an instance script that D1 moves.
 */
function countWorkspaceRuns(line, context) {
  if (context.stageDir === ".") return 0;
  let count = 0;
  for (const lib of libSpellings(context.stageDir)) {
    const parts = line.split(lib);
    for (let index = 1; index < parts.length; index += 1) {
      const tail = parts[index].startsWith(REFUSAL_CLAUSE) ? parts[index].slice(REFUSAL_CLAUSE.length) : parts[index];
      const run = /^node "\$GITHUB_WORKSPACE\/(scripts|src)\/([A-Za-z0-9_./-]+)"/.exec(tail);
      if (run && (run[1] === "scripts" || context.instanceScripts.has(run[2]))) count += 1;
    }
  }
  return count;
}

/** The staged copy and the message of an instance script in a validator comparison, which name the script by its own path (the workspace path is D1's ENGINE_PATH). */
const d1Shapes = (names) => [...names].flatMap((name) => [[`"$copy/${name}"`, `"$copy/scripts/${name}"`], [`"src/${name} is not the copy`, `"scripts/${name} is not the copy`]]);
/** The quoted workspace path of drift-lib is a D8 spelling: it is not also a factory-script path of D2. */
const D8_OWNED = `"${WS}/src/drift/lib"`;

/** The rules that rewrite a string value, in order. Each firing is counted under its class. */
function rewriteString(text, rel, context) {
  let out = text;
  const { enabled, counts } = context;

  // D8 goes before the paths of D1 and D2: the quoted workspace path of drift-lib has the quote after lib, and the stage's expansion puts it before /src.
  if (enabled.has("D8") && out.includes("drift/lib")) {
    for (const [from, to] of d8Shapes(context.stageDir)) {
      if (from === to) continue;
      const parts = out.split(from);
      counts.D8 += parts.length - 1;
      out = parts.join(to);
    }
    // then the clauses that the comparison has gained: what is added is in the stage's spelling already, so it goes after the spellings above are rewritten
    const completed = addMissingClauses(out, context.stageDir);
    counts.D8 += completed.added;
    out = completed.text;
  }

  if (enabled.has("D1")) {
    for (const [from, to] of context.d1Shapes) {
      const parts = out.split(from);
      counts.D1 += parts.length - 1;
      out = parts.join(to);
    }
  }

  out = out.replace(ENGINE_PATH, (whole, tail) => {
    const relative = pathOf(tail);
    if (context.instanceScripts.has(relative)) {
      if (!enabled.has("D1")) return whole;
      counts.D1 += 1;
      return `${WS}/scripts/${tail}`;
    }
    if (!enabled.has("D2") || !context.engineHas(relative)) return whole;
    counts.D2 += 1;
    return `${WS}/${context.factoryDir}/src/${tail}`;
  });

  // D8, the run, goes after the paths of D1: a script that was at src/ is at scripts/ by now, and it is the workspace copy at scripts/ that the comparison no longer runs
  if (enabled.has("D8") && context.stageDir !== "." && out.includes(REFUSAL_CLAUSE)) {
    out = out.replace(workspaceRun(), (whole, script) => {
      counts.D8 += 1;
      return `${REFUSAL_CLAUSE}node "$copy/scripts/${script}"`;
    });
  }

  if (enabled.has("D5") && out.includes("verify-immutable-gates.mjs")) {
    const parts = out.split("--portfolio");
    counts.D5 += parts.length - 1;
    out = parts.join("--downstream");
  }

  if (enabled.has("D6") && out.includes("dedupe-open-prs.mjs") && !/ --project /.test(out)) {
    const key = /(?:^|\/)(?:drift|implement)-(.+?)\.(?:md|lock\.yml)$/.exec(rel)?.[1];
    if (key !== undefined && /\S$/.test(out)) {
      out = `${out} --project ${key}`;
      counts.D6 += 1;
    }
  }

  if (enabled.has("D7") && out.includes("prepare-run.mjs") && (/ --(?:stage-scripts|factory-dir) /.test(out) || context.learnedStageScripts !== null)) {
    const before = out;
    out = / --factory-dir \S+/.test(out) ? out.replace(/ --factory-dir \S+/, ` --factory-dir ${context.stageDir}`) : `${out} --factory-dir ${context.stageDir}`;
    if (!/ --stage-scripts /.test(out) && context.learnedStageScripts !== null) out = `${out} --stage-scripts ${context.learnedStageScripts}`;
    if (out !== before) counts.D7 += 1;
  }

  if (enabled.has("D9") && out.includes("node bin/sdlc-onboard.mjs")) {
    const parts = out.split("node bin/sdlc-onboard.mjs");
    counts.D9 += parts.length - 1;
    out = parts.join(`node ${context.factoryDir}/bin/sdlc-onboard.mjs`);
  }
  return out;
}

/** Walks a value and applies the structural rules (the sparse checkout, the install steps) and the string rules to the parts that they own. */
function normalizeNode(node, rel, context, trail = []) {
  if (typeof node === "string") return rewriteString(node, rel, context);
  if (Array.isArray(node)) return finishSteps(node.map((item, index) => normalizeNode(item, rel, context, [...trail, index])), context, trail);
  if (!isObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "sparse-checkout" && typeof value === "string" && context.enabled.has("D3") && value.trim() === "src\nschemas") {
      const tail = value.endsWith("\n") ? "\n" : "";
      out[key] = `/package.json\n/package-lock.json\n/${context.manifestPath}${tail}`;
      if (!Object.hasOwn(node, "sparse-checkout-cone-mode")) out["sparse-checkout-cone-mode"] = false;
      context.counts.D3 += 1;
    } else if (key === "pre-agent-steps" && Array.isArray(value)) {
      const needsInstall = context.enabled.has("D4a") && agentRunsFactoryScript(node, context);
      const steps = value.map((item, index) => normalizeNode(item, rel, context, [...trail, key, index]));
      if (needsInstall) {
        context.counts.D4a += 1;
        steps.unshift({ run: INSTALL_COMMAND });
      }
      out[key] = finishSteps(steps, context, [...trail, key]);
    } else {
      out[key] = normalizeNode(value, rel, context, [...trail, key]);
    }
  }
  return out;
}

const getAt = (value, trail) => trail.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), value);

const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value);

/** A compiled agent job keeps the steps of pre-agent-steps among its own: this is the array of a lock that the D4a rule looks at. */
const COMPILED_AGENT_STEPS = "jobs/agent/steps";

/** The array with the factory auth taken out again: the token steps go, and each install step with git rewrites is the plain one. */
const collapseAuth = (steps) => steps.filter((step) => step?.id !== "factory_token").map((step) => (isObject(step) && step.name === "Install the factory" && step.run === INSTALL_COMMAND ? { run: INSTALL_COMMAND } : step));

/** The token step and the install step that follows it, in the order that an array holds them. */
function authPairs(steps) {
  const pairs = [];
  steps.forEach((step, index) => {
    if (step?.id === "factory_token" && steps[index + 1]?.name === "Install the factory") pairs.push([step, steps[index + 1]]);
  });
  return pairs;
}

/**
 * True for a token step and an install step that are what a private factory renders: a token for one repository with contents: read and nothing else, and
 * the plain install command with the git rewrites in its own environment. A step that asks for more, or an install that does something else, is not auth.
 */
function isFactoryAuth([token, install]) {
  const permissions = Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-"));
  return (
    String(token.uses ?? "").startsWith("actions/create-github-app-token@") &&
    permissions.length === 1 &&
    token.with["permission-contents"] === "read" &&
    typeof token.with.repositories === "string" &&
    !token.with.repositories.includes(",") &&
    install.run === INSTALL_COMMAND &&
    isObject(install.env) &&
    Number(install.env.GIT_CONFIG_COUNT) > 0
  );
}

/**
 * D4a in a lock: the compiled agent job has one more plain install step than the before side. Where it sits is learned from the after side, and the rest of the
 * array has to be exactly the before array, so that nothing else can hide behind the class.
 */
function insertLearnedInstall(items, afterArray, context) {
  if (!Array.isArray(afterArray)) return items;
  const collapsed = collapseAuth(afterArray);
  if (collapsed.length !== items.length + 1) return items;
  const target = JSON.stringify(collapsed);
  for (let index = 0; index <= items.length; index += 1) {
    const candidate = [...items.slice(0, index), { run: INSTALL_COMMAND }, ...items.slice(index)];
    if (JSON.stringify(candidate) === target) {
      context.counts.D4a += 1;
      return candidate;
    }
  }
  return items;
}

/**
 * D4b: each plain install step of an array becomes the token step and the install step that the after side holds at the same place. The compiler orders the keys
 * of a step differently in the agent job and in a custom job, so the pairs are taken site by site; every one of them has to be factory auth, and to equal the
 * first pair that was taken except for the order of its keys.
 */
function finishSteps(items, context, trail) {
  let steps = items;
  if (context.enabled.has("D4a") && context.docKind === "lock" && trail.join("/") === COMPILED_AGENT_STEPS) steps = insertLearnedInstall(steps, getAt(context.afterValue, trail), context);
  if (!context.enabled.has("D4b")) return steps;
  const afterArray = getAt(context.afterValue, trail);
  const pairs = Array.isArray(afterArray) ? authPairs(afterArray) : [];
  let next = 0;
  return steps.flatMap((item) => {
    if (!isBareInstall(item) || next >= pairs.length) return [item];
    const pair = pairs[next];
    const shape = JSON.stringify(sortKeys(pair));
    if (!isFactoryAuth(pair) || (context.canonicalAuth !== null && context.canonicalAuth !== shape)) return [item];
    context.canonicalAuth = shape;
    next += 1;
    context.counts.D4b += 1;
    return [clone(pair[0]), clone(pair[1])];
  });
}

/** True when the after side has any factory token step at all (a private factory), wherever it sits. */
function hasFactoryAuth(afterDocs) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (Array.isArray(node)) node.forEach(visit);
    else if (isObject(node)) {
      if (node.id === "factory_token") found = true;
      else Object.values(node).forEach(visit);
    }
  };
  for (const doc of afterDocs) visit(doc.value);
  return found;
}

/** The value of --stage-scripts that the after side passes to prepare-run in one workflow, so that the rule appends what the factory renders. */
function learnStageScripts(afterDoc) {
  if (afterDoc === undefined) return null;
  for (const text of strings(afterDoc.value)) {
    if (!text.includes("prepare-run.mjs")) continue;
    const match = / --stage-scripts (\S+)/.exec(text);
    if (match) return match[1];
  }
  return null;
}

// ---- the before-side pattern counts (measured on their own, not by the rules) -----------------------------------------------------------------------

/** How often each class's own pattern occurs on the before side, counted over the raw text of the files or over the parsed steps, never by running the rule. */
function measureBefore(files, docs, afterDocs, context) {
  const expected = Object.fromEntries(CLASSES.map(([id]) => [id, 0]));
  const lines = (text) => text.split("\n");
  const target = ` --factory-dir ${context.stageDir}`;
  for (const [rel, text] of files) {
    const learned = learnStageScripts(afterDocs.get(rel)) !== null;
    for (const match of text.split(D8_OWNED).join("").matchAll(ENGINE_PATH)) {
      const relative = pathOf(match[1]);
      if (context.instanceScripts.has(relative)) expected.D1 += 1;
      else if (context.engineHas(relative)) expected.D2 += 1;
    }
    for (const line of lines(text)) {
      for (const [from] of context.d1Shapes) expected.D1 += line.split(from).length - 1;
      if (line.includes("verify-immutable-gates.mjs")) expected.D5 += line.split("--portfolio").length - 1;
      if (line.includes("dedupe-open-prs.mjs") && !/ --project /.test(line) && /(?:^|\/)(?:drift|implement)-.+\.(?:md|lock\.yml)$/.test(rel)) expected.D6 += 1;
      if (line.includes("prepare-run.mjs") && (/ --(?:stage-scripts|factory-dir) /.test(line) || learned)) {
        const hasTarget = new RegExp(`${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s"]|$)`).test(line);
        if (!hasTarget || (learned && !/ --stage-scripts /.test(line))) expected.D7 += 1;
      }
      if (line.includes("drift/lib")) {
        for (const [from, to] of d8Shapes(context.stageDir)) if (from !== to) expected.D8 += line.split(from).length - 1;
        expected.D8 += countMissingClauses(line, context.stageDir);
        expected.D8 += countWorkspaceRuns(line, context);
      }
      if (line.includes("node bin/sdlc-onboard.mjs")) expected.D9 += line.split("node bin/sdlc-onboard.mjs").length - 1;
    }
  }
  let plainInstalls = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      plainInstalls += node.filter(isBareInstall).length;
      node.forEach(visit);
    } else if (isObject(node)) {
      if (typeof node["sparse-checkout"] === "string" && node["sparse-checkout"].trim() === "src\nschemas") expected.D3 += 1;
      if (Array.isArray(node["pre-agent-steps"]) && agentRunsFactoryScript(node, context)) expected.D4a += 1;
      Object.values(node).forEach(visit);
    }
  };
  for (const doc of docs.values()) {
    visit(doc.value);
    if (doc.kind === "lock" && (doc.value?.jobs?.agent?.steps ?? []).some((step) => [...strings(step)].some((text) => runsEngineScript(text, context)))) expected.D4a += 1;
  }
  expected.D4b = plainInstalls + expected.D4a;
  expected.D10 = [...docs.values()].filter((doc) => doc.kind === "lock" && doc.meta !== null).length;
  return expected;
}

// ---- the comparison ------------------------------------------------------------------------------------------------------------------------------

function maskMetadata(doc, context, counted) {
  if (doc.kind !== "lock" || doc.meta === null) return doc;
  const meta = { ...doc.meta };
  for (const key of ["frontmatter_hash", "body_hash"]) if (key in meta) meta[key] = MASK;
  if (counted && context.enabled.has("D10")) context.counts.D10 += 1;
  return { ...doc, meta };
}

/** Rewrites the before side by the rules that the stage allows. */
function normalizeBefore(beforeDocs, afterDocs, context) {
  const out = new Map();
  for (const [rel, doc] of beforeDocs) {
    context.learnedStageScripts = learnStageScripts(afterDocs.get(rel));
    context.docKind = doc.kind;
    context.afterValue = afterDocs.get(rel)?.value;
    let next = { ...doc };
    if (doc.kind === "workflow" || doc.kind === "lock" || doc.kind === "yaml") next.value = normalizeNode(doc.value, rel, context);
    if (doc.kind === "workflow") next.body = rewriteString(doc.body, rel, context);
    out.set(rel, context.enabled.has("D10") ? maskMetadata(next, context, true) : next);
  }
  return out;
}

/** A small unified diff of two texts: the common head and tail are cut, the middle is diffed by its longest common subsequence. */
export function unifiedDiff(label, before, after, { context = 2, limit = 60 } = {}) {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);
  const ops = [];
  if (left.length * right.length <= 4_000_000) {
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { ops.push([" ", left[i]]); i += 1; j += 1; }
      else if (i < left.length && (j === right.length || table[i + 1][j] >= table[i][j + 1])) { ops.push(["-", left[i]]); i += 1; }
      else { ops.push(["+", right[j]]); j += 1; }
    }
  } else {
    for (const line of left) ops.push(["-", line]);
    for (const line of right) ops.push(["+", line]);
  }
  const lines = [`--- before/${label}`, `+++ after/${label}`, `@@ line ${head + 1} @@`];
  for (const line of a.slice(Math.max(0, head - context), head)) lines.push(` ${line}`);
  const changed = ops.filter(([kind]) => kind !== " ");
  for (const [kind, line] of ops.slice(0, limit * 2)) lines.push(`${kind}${line}`);
  if (ops.length > limit * 2) lines.push(`... ${ops.length - limit * 2} more line(s) of this file's difference`);
  for (const line of a.slice(a.length - tail, a.length - tail + context)) lines.push(` ${line}`);
  return { text: lines.join("\n"), changed: changed.length };
}

/**
 * Compares two renders. `before` and `after` are Maps of a path relative to the repository to the text of the file.
 * @returns {{ ok: boolean, rows: object[], leftovers: { file: string, diff: string }[], problems: string[] }}
 */
export function diffRenders({ before, after, stage, engine = ENGINE_ROOT, packageName = "ai-sdlc-factory", factoryDir, manifestPath = "sdlc.yaml", instanceScripts = [] }) {
  if (!Object.hasOwn(STAGES, stage)) throw new HarnessError(`unknown stage '${stage}' (one of ${Object.keys(STAGES).join(", ")})`);
  const context = makeContext({ engine, packageName, factoryDir: factoryDir ?? `node_modules/${packageName}`, manifestPath, instanceScripts, stage: String(stage) });
  const parse = (files) => new Map([...files].map(([rel, text]) => [rel, parseDocument(rel, text)]));
  const beforeDocs = parse(before);
  const afterDocs = parse(after);
  const expected = measureBefore(before, beforeDocs, afterDocs, context);
  const normalized = normalizeBefore(beforeDocs, afterDocs, context);
  const afterMasked = new Map([...afterDocs].map(([rel, doc]) => [rel, context.enabled.has("D10") ? maskMetadata(doc, context, false) : doc]));

  const problems = [];
  const leftovers = [];
  for (const rel of new Set([...normalized.keys(), ...afterMasked.keys()])) {
    if (!normalized.has(rel)) { problems.push(`${rel} is only in the after render`); continue; }
    if (!afterMasked.has(rel)) { problems.push(`${rel} is only in the before render`); continue; }
    const left = canonical(normalized.get(rel));
    const right = canonical(afterMasked.get(rel));
    if (left !== right) leftovers.push({ file: rel, diff: unifiedDiff(rel, left, right).text });
  }

  const rows = CLASSES.filter(([id]) => context.enabled.has(id)).map(([id, name]) => ({ id, name, expected: expected[id], applied: context.counts[id], ok: expected[id] === context.counts[id] }));
  for (const row of rows) if (!row.ok) problems.push(`${row.id} (${row.name}): the rule rewrote ${row.applied} time(s), but its pattern occurs ${row.expected} time(s) on the before side`);
  if (context.enabled.has("D4b") && expected.D4b > 0 && !hasFactoryAuth(afterDocs.values())) problems.push("D4b: the after render has no factory token step, so it is not a private factory");
  return { ok: problems.length === 0 && leftovers.length === 0, rows, leftovers, problems, stage: String(stage) };
}

/** The lines that the command prints for a result. */
export function formatReport(result, { before, after }) {
  const out = [`render-diff diff --stage ${result.stage}: ${before} file(s) before, ${after} file(s) after`, "class  pattern  applied  status  name"];
  if (result.rows.length === 0) out.push("(stage 0 allows no class)");
  for (const row of result.rows) out.push(`${row.id.padEnd(5)}  ${String(row.expected).padStart(7)}  ${String(row.applied).padStart(7)}  ${(row.ok ? "ok" : "MISMATCH").padEnd(10)}${row.name}`);
  for (const problem of result.problems) out.push(`problem: ${problem}`);
  for (const { diff } of result.leftovers) out.push("", diff);
  out.push(result.ok ? "RESULT: the renders agree modulo the allowed classes" : `RESULT: NOT EQUAL (${result.leftovers.length} file(s) differ beyond the allowed classes, ${result.problems.length} problem(s))`);
  return out;
}

// ---- self test -----------------------------------------------------------------------------------------------------------------------------------

function* stepArrays(node) {
  if (Array.isArray(node)) {
    if (node.length >= 2 && node.every((item) => isObject(item) && ("run" in item || "uses" in item))) yield node;
    for (const item of node) yield* stepArrays(item);
  } else if (isObject(node)) for (const item of Object.values(node)) yield* stepArrays(item);
}

/** The three mutations of the self test, each applied to a copy of one workflow source (or one lock) of the render. */
function mutations(files) {
  const names = [...files.keys()].filter((rel) => rel.endsWith(".md") || rel.endsWith(".lock.yml"));
  const rewrite = (rel, change) => {
    const text = files.get(rel);
    const doc = parseDocument(rel, text);
    const done = change(doc.value);
    if (!done) return null;
    const next = new Map(files);
    if (doc.kind === "lock") {
      // the comment lines that open a lock are its metadata: they are kept, so that a report comes from the mutation and not from a lost header
      const header = [];
      for (const line of text.split("\n")) {
        if (!line.startsWith("#")) break;
        header.push(line);
      }
      next.set(rel, `${header.join("\n")}\n${YAML.stringify(doc.value, { lineWidth: 0 })}`);
    } else {
      next.set(rel, `---\n${YAML.stringify(doc.value, { lineWidth: 0 })}---\n${doc.body}`);
    }
    return next;
  };
  const first = (change) => {
    for (const rel of names) {
      const next = rewrite(rel, change);
      if (next !== null) return { rel, files: next };
    }
    return null;
  };
  const permission = (node) => {
    if (Array.isArray(node)) return node.some(permission);
    if (!isObject(node)) return false;
    if (isObject(node.permissions)) {
      const key = Object.keys(node.permissions)[0];
      if (key !== undefined) { node.permissions[key] = node.permissions[key] === "write" ? "read" : "write"; return true; }
    }
    return Object.values(node).some(permission);
  };
  return [
    ["an extra step", first((value) => { const [steps] = [...stepArrays(value)]; if (!steps) return false; steps.push({ run: "echo render-diff-self-test" }); return true; })],
    ["a changed permissions entry", first(permission)],
    ["a swapped step order", first((value) => { const found = [...stepArrays(value)].find((steps) => JSON.stringify(steps[0]) !== JSON.stringify(steps[1])); if (!found) return false; [found[0], found[1]] = [found[1], found[0]]; return true; })],
  ];
}

/** @returns {{ ok: boolean, lines: string[] }} */
export function selfTest(files, options = {}) {
  const lines = [];
  let ok = true;
  const clean = diffRenders({ before: files, after: files, stage: "0", ...options });
  lines.push(`before against before: ${clean.ok ? "empty, as it must be" : "NOT EMPTY"}`);
  ok &&= clean.ok;
  for (const [label, mutation] of mutations(files)) {
    if (mutation === null) { lines.push(`${label}: the render has nothing to mutate`); ok = false; continue; }
    const reported = !diffRenders({ before: files, after: mutation.files, stage: "0", ...options }).ok;
    lines.push(`${label} (${mutation.rel}): ${reported ? "reported" : "NOT REPORTED"}`);
    ok &&= reported;
  }
  return { ok, lines };
}

// ---- files and commands --------------------------------------------------------------------------------------------------------------------------

function listFiles(root, start = "") {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, start), { withFileTypes: true })) {
    const rel = start === "" ? entry.name : `${start}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(root, rel));
    else found.push(rel);
  }
  return found;
}

/** The files of a render or of a set of locks: everything under .github/workflows of the directory, as a Map of a repository path to its text. */
export function readRender(dir) {
  const base = path.join(dir, ...WORKFLOWS.split("/"));
  if (!fs.existsSync(base)) throw new HarnessError(`${dir} has no ${WORKFLOWS} directory`, 2);
  const files = new Map();
  for (const rel of listFiles(dir, WORKFLOWS).sort()) files.set(rel, fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8"));
  return files;
}

function writeRender(dir, files) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new HarnessError(`${dir} is not empty: a render goes into a directory of its own`, 2);
  for (const [rel, text] of files) {
    const target = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

const need = (values, ...names) => {
  for (const name of names) if (values[name] === undefined) throw new HarnessError(`--${name} is required`);
};

async function loadEngine(engine) {
  const file = path.join(engine, "src", "reconcile.mjs");
  if (!fs.existsSync(file)) throw new HarnessError(`${file} does not exist: --engine names a directory that holds src/reconcile.mjs`);
  return import(pathToFileURL(file).href);
}

async function commandRender(values, stdout) {
  need(values, "instance", "request", "out");
  const { renderFleet } = await loadEngine(values.engine ?? ENGINE_ROOT);
  const request = JSON.parse(fs.readFileSync(values.request, "utf8"));
  const result = renderFleet(request, { cwd: path.resolve(values.instance) });
  if (!result.ok) {
    const errors = (result.result?.validationResults ?? []).flatMap((entry) => (entry.errors ?? []).map((error) => `  ${entry.file}: ${error}`));
    throw new HarnessError(`the render was refused:\n${errors.join("\n")}`, 1);
  }
  writeRender(path.resolve(values.out), result.files);
  stdout(`rendered ${result.files.size} file(s) into ${values.out}`);
  return 0;
}

function commandCompile(values, stdout) {
  need(values, "render", "out");
  const { ghAwEnvironment } = values.__engine;
  const env = ghAwEnvironment({ ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
  const version = spawnSync("gh", ["aw", "version"], { env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const found = /v?(\d+\.\d+\.\d+)/.exec(`${version.stdout}${version.stderr}`)?.[1] ?? null;
  if (values["expect-version"] !== undefined && found !== values["expect-version"].replace(/^v/, "")) {
    throw new HarnessError(`gh aw is ${found === null ? "not installed" : `v${found}`}, and ${values["expect-version"]} was expected: point SDLC_GH_AW_DATA_HOME at an isolated install of it`);
  }
  const render = readRender(path.resolve(values.render));
  const pins = values["actions-lock"] ?? [path.join(values.render, ".github", "aw", "actions-lock.json"), path.join(ENGINE_ROOT, "examples", ".github", "aw", "actions-lock.json")].find((file) => fs.existsSync(file));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-render-diff-"));
  try {
    for (const [rel, text] of render) if (rel.endsWith(".md")) {
      fs.mkdirSync(path.join(scratch, ...path.posix.dirname(rel).split("/")), { recursive: true });
      fs.writeFileSync(path.join(scratch, ...rel.split("/")), text);
    }
    // gh-aw v1.0.1 refuses protected_files in aw.json, so the compiler is given the strict-only repository config, as the reconciler does after its first refusal
    fs.writeFileSync(path.join(scratch, ...`${WORKFLOWS}/aw.json`.split("/")), `${JSON.stringify({ strict: true }, null, 2)}\n`);
    if (pins !== undefined) {
      fs.mkdirSync(path.join(scratch, ".github", "aw"), { recursive: true });
      fs.copyFileSync(pins, path.join(scratch, ".github", "aw", "actions-lock.json"));
    }
    if (spawnSync("git", ["init", "-q"], { cwd: scratch, env, windowsHide: true }).status !== 0) throw new HarnessError("git init failed in the scratch repository", 1);
    const run = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: scratch, env, encoding: "utf8", windowsHide: true, timeout: 600000 });
    if (run.status !== 0) throw new HarnessError(`gh aw compile --strict failed (exit ${run.status}):\n${`${run.stdout}\n${run.stderr}`.trim().split("\n").slice(-30).join("\n")}`, 1);
    const locks = new Map();
    // The reconciler removes `permission-checks: read` from every lock it compiles (src/reconcile.mjs, stripUngrantedPermissions): the App holds no Checks permission,
    // so a token that asks for it cannot be minted. The same step is applied here, so that a lock made by this command is the lock that the reconciler writes.
    for (const rel of listFiles(scratch, WORKFLOWS)) {
      if (rel.endsWith(".lock.yml")) locks.set(rel, fs.readFileSync(path.join(scratch, ...rel.split("/")), "utf8").replace(/^[ \t]*permission-checks: read\r?\n/gm, ""));
    }
    if (locks.size === 0) throw new HarnessError("the compiler produced no lock file", 1);
    writeRender(path.resolve(values.out), locks);
    stdout(`compiled ${locks.size} lock(s) into ${values.out} with gh aw v${found}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return 0;
}

const OPTIONS = {
  engine: { type: "string" }, instance: { type: "string" }, request: { type: "string" }, out: { type: "string" }, render: { type: "string" }, before: { type: "string" },
  after: { type: "string" }, stage: { type: "string" }, package: { type: "string" }, "factory-dir": { type: "string" }, "manifest-path": { type: "string" },
  "instance-scripts": { type: "string" }, "actions-lock": { type: "string" }, "expect-version": { type: "string" },
};
const USAGE = "usage: node tools/render-diff.mjs render|compile|diff|selftest ... (see the header of tools/render-diff.mjs)";

/**
 * Runs the command line. Resolves with the exit code.
 * @param {string[]} argv
 * @param {{ stdout?: (line: string) => void }} [io]
 */
export async function main(argv, { stdout = (line) => process.stdout.write(`${line}\n`) } = {}) {
  try {
    const [command, ...rest] = argv;
    if (!["render", "compile", "diff", "selftest"].includes(command)) throw new HarnessError(USAGE);
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false }));
    } catch (error) {
      throw new HarnessError(`${error.message}\n${USAGE}`);
    }
    if (command === "render") return await commandRender(values, stdout);
    const engine = path.resolve(values.engine ?? ENGINE_ROOT);
    if (command === "compile") return commandCompile({ ...values, __engine: await loadEngine(engine) }, stdout);
    const options = { engine, packageName: values.package, factoryDir: values["factory-dir"], manifestPath: values["manifest-path"], instanceScripts: (values["instance-scripts"] ?? "").split(",").filter(Boolean) };
    for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];
    if (command === "selftest") {
      need(values, "render");
      const result = selfTest(readRender(path.resolve(values.render)), options);
      for (const line of result.lines) stdout(line);
      stdout(result.ok ? "RESULT: the harness finds what it must find" : "RESULT: the harness FAILED its self test");
      return result.ok ? 0 : 1;
    }
    need(values, "before", "after", "stage");
    const before = readRender(path.resolve(values.before));
    const after = readRender(path.resolve(values.after));
    const result = diffRenders({ before, after, stage: values.stage, ...options });
    for (const line of formatReport(result, { before: before.size, after: after.size })) stdout(line);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error;
    process.stderr.write(`render-diff: ${error.message}\n`);
    return error.code;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
