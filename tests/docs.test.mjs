// The documentation of the package is checked against the package: the public API against the real exports, the architecture tables against the code that
// they describe, the rendered steps of the private install against what the renderer produces, the links between the pages, and the voice of the pages
// (nothing of the project's own process, nothing that is a promise, nothing that names an owner).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { SYNC_STATE_FIELDS } from "../src/routing/sync-state.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { loadDenylist } from "../tools/leak-guard/digest.mjs";
import { createMasker, formatRun, scanTree } from "../tools/leak-guard/scan.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const DOC_PAGES = ["docs/architecture.md", "docs/manifest.md", "docs/private-engine.md", "docs/api.md"];
const PAGES = ["README.md", "CHANGELOG.md", "SECURITY.md", ...DOC_PAGES];

/** The fenced blocks of a markdown text, also inside list items: [{ language, body }], with the indentation of the opening fence removed from the body. */
function fences(markdown) {
  return [...markdown.matchAll(/^([ \t]*)```([A-Za-z]*)\n([\s\S]*?)^[ \t]*```$/gm)].map((match) => ({
    language: match[2],
    body: match[3].split("\n").map((line) => (line.startsWith(match[1]) ? line.slice(match[1].length) : line)).join("\n"),
  }));
}

/** The rows of a markdown table whose cells are in `columns` cells, as arrays of trimmed cells; a row's first cell is a code span. */
function tableRows(markdown, columns) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.slice(1, line.lastIndexOf("|")).split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length === columns);
}

/** The text between the heading that starts with `title` and the next heading of the same or a higher level. */
function section(markdown, title, level = 2) {
  const start = markdown.search(new RegExp(`^${"#".repeat(level)} ${title.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m"));
  assert.ok(start !== -1, `the heading '${title}' exists`);
  const rest = markdown.slice(start).split("\n").slice(1).join("\n");
  const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return end === -1 ? rest : rest.slice(0, end);
}

// ---------------------------------------------------------------------------------------------------------------------
// docs/api.md
// ---------------------------------------------------------------------------------------------------------------------

const api = read("docs", "api.md");
const FROZEN_RECONCILE = ["buildAcks", "checkRendered", "reconcile", "renderFleet"];

function documentedNames(title) {
  return tableRows(section(api, title), 3).map(([name, kind]) => ({ name: name.slice(1, -1), kind }));
}

const isClass = (value) => typeof value === "function" && /^class\b/.test(Function.prototype.toString.call(value));

for (const specifier of ["script-kit", "drift-lib"]) {
  test(`docs/api.md lists exactly the exports of ai-sdlc-factory/${specifier}, each with the kind that it has`, async () => {
    const module = await import(`ai-sdlc-factory/${specifier}`);
    const listed = documentedNames(`ai-sdlc-factory/${specifier}`);
    assert.deepEqual(listed.map((entry) => entry.name).sort(), Object.keys(module).sort());
    assert.equal(new Set(listed.map((entry) => entry.name)).size, listed.length, "no name twice");
    for (const { name, kind } of listed) {
      const value = module[name];
      const actual = isClass(value) ? "class" : typeof value === "function" ? "function" : "constant";
      assert.equal(kind, actual, `${name} is a ${actual}`);
    }
  });
}

test("docs/api.md lists the four frozen names of ai-sdlc-factory/reconcile, and the module exports each of them as a function", async () => {
  const listed = documentedNames("ai-sdlc-factory/reconcile").map((entry) => entry.name);
  assert.deepEqual(listed.sort(), FROZEN_RECONCILE);
  const module = await import("ai-sdlc-factory/reconcile");
  for (const name of FROZEN_RECONCILE) assert.equal(typeof module[name], "function", name);
});

test("docs/api.md names every entry of the exports map, the three commands and every schema file", () => {
  for (const key of Object.keys(pkg.exports)) assert.ok(api.includes(`ai-sdlc-factory/${key.slice(2)}`), `${key} is documented`);
  for (const command of Object.keys(pkg.bin)) assert.ok(api.includes(command), command);
  const shipped = fs.readdirSync(path.join(ROOT, "schemas")).filter((name) => name.endsWith(".schema.json"));
  assert.ok(shipped.length >= 5);
  for (const name of shipped) assert.ok(api.includes(`\`${name}\``) || api.includes(name), `${name} is named`);
  const listedSchemas = [...api.matchAll(/`([a-z-]+\.schema\.json)`/g)].map((match) => match[1]);
  for (const name of listedSchemas) assert.ok(shipped.includes(name), `${name} exists`);
});

test("the script of docs/api.md is valid, and imports only names that script-kit exports", async (t) => {
  const block = fences(api).find((entry) => entry.language === "js");
  assert.ok(block !== undefined);
  const imported = /import \{([^}]*)\} from "ai-sdlc-factory\/script-kit";/.exec(block.body)?.[1].split(",").map((name) => name.trim()).filter(Boolean);
  assert.ok(imported !== undefined && imported.length > 0);
  const kit = await import("ai-sdlc-factory/script-kit");
  for (const name of imported) assert.ok(name in kit, `${name} is exported`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-docs-js-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "example.mjs");
  fs.writeFileSync(file, block.body);
  const outcome = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
});

test("the request of docs/api.md has the nine keys, and a manifest is rendered with it", (t) => {
  const block = fences(api).find((entry) => entry.language === "json");
  assert.ok(block !== undefined);
  const request = JSON.parse(block.body);
  assert.deepEqual(Object.keys(request), ["manifestPath", "appSlug", "appClientIdVar", "appPrivateKeySecret", "pollStateVarPrefix", "engineAuthMode", "ghAwVersionPin", "securityBaseline", "dryRun"]);
  const work = createWorkspace(t);
  const result = renderFleet(request, { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  const refused = renderFleet({ ...request, extra: true }, { cwd: work.dir });
  assert.equal(refused.ok, false, "a tenth key is refused, as the page says");
});

test("the deprecations of docs/api.md are in the code with the release that removes them", () => {
  assert.match(api, /`--portfolio`[^|]*\| 0\.1\.0 \| 0\.3\.0 \|/);
  assert.match(api, /portfolioMainSha[^|]*\| 0\.1\.0 \| 1\.0\.0 \|/);
  const gates = read("src", "verify-immutable-gates.mjs");
  assert.ok(gates.includes("--portfolio") && gates.includes("0.3.0"));
  const state = read("src", "routing", "sync-state.mjs");
  assert.ok(state.includes("portfolioMainSha") && state.includes("1.0.0"));
});

// ---------------------------------------------------------------------------------------------------------------------
// docs/architecture.md
// ---------------------------------------------------------------------------------------------------------------------

const architecture = read("docs", "architecture.md");

function renderedExample(t) {
  const manifest = read("docs", "manifest.md");
  const text = /## A complete example[\s\S]*?```yaml\n([\s\S]*?)\n```/.exec(manifest)[1].replaceAll("<owner>", "example-org");
  const work = createWorkspace(t, { text, files: { "package.json": JSON.stringify({ name: "orchestrator", dependencies: { "ai-sdlc-factory": "github:example-org/ai-sdlc-factory#v0.1.0" } }) } });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return result.files;
}

test("the table of generated workflows names every kind of file that the renderer produces, and nothing that it does not", (t) => {
  const patterns = tableRows(section(architecture, "The generated workflows"), 3).map(([name]) => name.slice(1, -1));
  assert.ok(patterns.length >= 7, `${patterns.length} patterns`);
  const expressions = patterns.map((pattern) => new RegExp(`^\\.github/workflows/${pattern.replace(/\./g, "\\.").replace(/<[A-Za-z]+>/g, "[a-z0-9-]+")}$`));
  const files = [...renderedExample(t).keys()];
  for (const [index, expression] of expressions.entries()) assert.ok(files.some((file) => expression.test(file)), `${patterns[index]} is rendered`);
  for (const file of files) assert.ok(expressions.some((expression) => expression.test(file)), `${file} is documented`);
});

test("the sync state table names the fourteen fields of the state, once each", () => {
  const rows = tableRows(section(architecture, "Sync state"), 2);
  const fields = rows.flatMap(([cell]) => [...cell.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1]));
  assert.deepEqual([...fields].sort(), [...SYNC_STATE_FIELDS].sort());
});

test("the permission table of the App is the permission ceiling of the bootstrap", () => {
  const ceiling = JSON.parse(read("bin", "lib", "app-permissions.json"));
  const names = { Contents: "contents", "Pull requests": "pull_requests", Issues: "issues", Actions: "actions", Variables: "variables", Metadata: "metadata" };
  const rows = section(architecture, "The GitHub App")
    .split("\n")
    .filter((line) => /^\| (Contents|Pull requests|Issues|Actions|Variables|Metadata) \|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));
  assert.deepEqual(Object.fromEntries(rows.map(([name, level]) => [names[name], level])), ceiling);
});

test("the router's triggers, and the payload of the event that wakes it, are what the architecture page says", (t) => {
  const router = YAML.parse(renderedExample(t).get(".github/workflows/cascade-router.yml"));
  assert.deepEqual(router.on.repository_dispatch.types, ["upstream_pr_merged"]);
  assert.ok(router.on.schedule.length >= 1);
  assert.ok("reset_blocked" in router.on.workflow_dispatch.inputs);
  for (const word of ["upstream_pr_merged", "reset_blocked", "repository_dispatch", "`schedule`".slice(1, -1)]) assert.ok(architecture.includes(word), word);
  const routing = JSON.parse(read("schemas", "sdlc-routing.schema.json"));
  const payload = Object.keys(routing.$defs.UpstreamMergeClientPayload.properties).sort();
  const named = /payload has six properties \(([^)]*)\)/.exec(architecture)?.[1].match(/`([a-z_]+)`/g)?.map((word) => word.slice(1, -1));
  assert.deepEqual(named?.sort(), payload);
});

// The router looks for the script that a preflight command starts before it runs any command. The check is in src/routing/preflight.mjs; a tree that does not
// have it yet has no such paragraph to prove.
const preflight = await import("../src/routing/preflight.mjs");

test("the paragraph of docs/manifest.md on the script that a preflight command starts says which commands the router checks, which files and which paths", { skip: typeof preflight.declaredScript === "function" ? false : "this tree does not look for the script of a preflight command" }, () => {
  const text = section(read("docs", "manifest.md"), "Preflight checks", 4);
  const where = { workspace: path.resolve("/work"), upstreamDir: path.resolve("/up"), cwd: path.resolve("/down") };
  const named = (command) => preflight.declaredScript(command, where)?.file ?? null;
  const documented = /a ((?:`\.[a-z]+`(?:, | or )?)+) file that is named plainly/.exec(text)?.[1].match(/\.[a-z]+/g);
  assert.deepEqual(documented, [".mjs", ".cjs", ".js", ".mts", ".cts", ".ts"]);
  for (const extension of documented) assert.notEqual(named(`node scripts/x${extension}`), null, extension);
  for (const other of ["node scripts/x.json", "node scripts/x.sh", "node scripts/x"]) assert.equal(named(other), null, other);
  assert.equal(named("node scripts/x.mjs"), path.resolve(where.cwd, "scripts", "x.mjs"), "relative to where the command runs");
  assert.equal(named("node $GITHUB_WORKSPACE/scripts/x.mjs"), path.resolve(where.workspace, "scripts", "x.mjs"));
  assert.equal(named("node ${UPSTREAM_DIR}/scripts/x.mjs"), path.resolve(where.upstreamDir, "scripts", "x.mjs"));
  for (const unchecked of ["node $OTHER/x.mjs", "node $(pwd)/x.mjs", "node scripts/*.mjs", "node ~/x.mjs", "node /abs/x.mjs", "bash scripts/x.mjs", "npm run x", "node -e 'x.mjs'"]) assert.equal(named(unchecked), null, unchecked);
  for (const phrase of ["another variable, a substitution, a glob or `~`", "an absolute path", "does not start with `node`", "exit code 1 is drift"]) assert.ok(text.includes(phrase), phrase);
});

// ---------------------------------------------------------------------------------------------------------------------
// docs/private-engine.md
// ---------------------------------------------------------------------------------------------------------------------

const privateEngine = read("docs", "private-engine.md");

function routerSteps(t, factory) {
  const work = createWorkspace(t, { mutate: (manifest) => (manifest.factory = factory), files: { "package.json": JSON.stringify({ name: "orchestrator", dependencies: { "ai-sdlc-factory": "github:example-org/ai-sdlc-factory#v0.1.0" } }) } });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return YAML.parse(result.files.get(".github/workflows/cascade-router.yml")).jobs.route.steps;
}

test("the steps that docs/private-engine.md shows are the steps that the renderer produces for a private factory", (t) => {
  const block = fences(privateEngine).find((entry) => entry.language === "yaml" && entry.body.includes("Mint the factory read token"));
  assert.ok(block !== undefined);
  const documented = YAML.parse(block.body.replaceAll("<owner>", "example-org"));
  const steps = routerSteps(t, { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: true });
  const token = steps.find((step) => step.id === "factory_token");
  const install = steps.find((step) => step.name === "Install the factory");
  assert.deepEqual(documented, [token, install]);
  assert.equal(install.env.GIT_CONFIG_COUNT, "3");
});

test("for a public factory the install step is the plain npm ci that docs/private-engine.md says it is, and there is no token step", (t) => {
  const steps = routerSteps(t, { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: false });
  assert.ok(steps.some((step) => step.run === "npm ci --ignore-scripts" && Object.keys(step).length === 1));
  assert.ok(!steps.some((step) => step.id === "factory_token"));
  assert.match(privateEngine, /the step is exactly `npm ci --ignore-scripts`/);
});

test("the setup snippets of docs/private-engine.md are the dependency and the factory block that the README tells you to write", () => {
  const dependency = fences(privateEngine).find((entry) => entry.language === "json").body;
  const parsed = JSON.parse(`{ ${dependency} }`);
  assert.equal(parsed.dependencies["ai-sdlc-factory"], `github:<owner>/ai-sdlc-factory#v${pkg.version}`);
  const block = fences(privateEngine).find((entry) => entry.language === "yaml" && entry.body.startsWith("factory:"));
  assert.deepEqual(YAML.parse(block.body), { factory: { package: "ai-sdlc-factory", source: "github:<owner>/ai-sdlc-factory", private: true } });
});

test("the failure modes name the check that the bootstrap makes for a private factory", () => {
  assert.match(section(privateEngine, "Failure modes"), /`sdlc-bootstrap` checks for this up front/);
  const installations = read("bin", "lib", "installations.mjs");
  assert.ok(installations.includes("factory.source") || installations.includes("factorySlug"));
});

// ---------------------------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------------------------

/** The anchors that GitHub generates for the headings of a page (fenced code is skipped, and a repeated heading gets a numeric suffix). */
function anchors(markdown) {
  const found = new Set();
  const seen = new Map();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^#{1,6} +(.+?) *#*$/.exec(line);
    if (!heading) continue;
    const text = heading[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase();
    const base = text.replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count === 0 ? base : `${base}-${count}`);
  }
  return found;
}

/** The relative links of a page, outside fenced code and code spans. */
function links(markdown) {
  const text = markdown.replace(/^[ \t]*```[\s\S]*?^[ \t]*```$/gm, "").replace(/`[^`\n]*`/g, "");
  return [...text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)].map((match) => match[1]).filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

test("every relative link of every page resolves to a file, and every anchor to a heading", () => {
  let count = 0;
  for (const page of PAGES) {
    const markdown = read(...page.split("/"));
    for (const target of links(markdown)) {
      const [file, anchor] = target.split("#");
      const resolved = file === "" ? path.join(ROOT, ...page.split("/")) : path.resolve(path.dirname(path.join(ROOT, ...page.split("/"))), file);
      assert.ok(fs.existsSync(resolved), `${page}: ${target} points at a file that does not exist`);
      if (anchor !== undefined && resolved.endsWith(".md")) assert.ok(anchors(fs.readFileSync(resolved, "utf8")).has(anchor), `${page}: ${target} has no heading for its anchor`);
      count += 1;
    }
  }
  assert.ok(count >= 25, `${count} links checked`);
});

test("the README links to every page of docs/, and every page of docs/ is one of the four", () => {
  const readme = read("README.md");
  const onDisk = fs.readdirSync(path.join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`).sort();
  assert.deepEqual(onDisk, [...DOC_PAGES].sort());
  for (const page of DOC_PAGES) assert.ok(readme.includes(`(${page})`), `${page} is linked from the README`);
});

test("the anchor algorithm of this test agrees with GitHub on the headings that the pages link to", () => {
  const found = anchors("# A title\n## The `state` dialect\n## Dup\n## Dup\n```\n# not a heading\n```\n## ai-sdlc-factory/script-kit\n## The factory repository's own safeguards\n");
  assert.deepEqual([...found], ["a-title", "the-state-dialect", "dup", "dup-1", "ai-sdlc-factoryscript-kit", "the-factory-repositorys-own-safeguards"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Voice: nothing of the project's own process, no promise, no owner
// ---------------------------------------------------------------------------------------------------------------------

const INTERNAL = [
  [/\bSPEC-0\d\b/, "a specification id"],
  [/\bAC\d{1,3}\b/, "an acceptance-criterion id"],
  [/\bOQ\d{2}\b/, "an open-question id"],
  [/\bp[1-9]\b/, "a phase name"],
  [/\bjudge\b/i, "a reviewer role"],
  [/\bQA round\b/i, "a review round"],
  [/\bdesign doc/i, "an internal document"],
  [/\bgate G[0-9]\b/i, "an approval gate"],
  [/\b(?:TODO|TBD|FIXME)\b/, "an unfinished marker"],
];

const PROMISES = [
  [/\bguarantee/i, "a guarantee"],
  [/\bwarrant/i, "a warranty (the license has the only one that applies)"],
  [/\bSLA\b/, "a service level"],
  [/service[- ]level/i, "a service level"],
  [/\bwe (?:will|promise|commit|ensure)\b/i, "a promise"],
  [/\bwithin \d+ (?:hours?|days?|weeks?)\b/i, "a response time"],
];

for (const page of PAGES) {
  test(`${page} has no id or name from the project's own process, and makes no promise`, () => {
    const text = read(...page.split("/"));
    for (const [pattern, what] of [...INTERNAL, ...PROMISES]) assert.ok(!pattern.test(text), `${page} contains ${what}: ${pattern}`);
  });
}

test("no page contains an owner identifier, a home path, an address or a token: the leak guard's rules, run without its allow list, find nothing", () => {
  const denylist = loadDenylist(path.join(ROOT, "tools", "leak-guard", "denylist.json"), { allowEmpty: process.env.SDLC_LEAK_ALLOW_EMPTY === "1" });
  const result = scanTree({ root: ROOT, denylist, allow: [], list: () => PAGES });
  const failing = result.findings.filter((finding) => finding.status === "fail");
  assert.equal(result.scanned, PAGES.length, "every page was read as text");
  assert.deepEqual(failing, [], `\n${formatRun(result, createMasker(denylist)).join("\n")}`);
});

test("the README speaks to the adopter in placeholders: <owner> for the account that hosts the factory", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("github:<owner>/ai-sdlc-factory"));
  for (const url of readme.matchAll(/(?:https:\/\/|@)github\.com[/:]([A-Za-z0-9<>_-]+)\//g)) assert.ok(["<owner>", "apps"].includes(url[1]), url[0]);
});

// ---------------------------------------------------------------------------------------------------------------------
// SECURITY.md
// ---------------------------------------------------------------------------------------------------------------------

test("SECURITY.md says how to report privately and which version is supported, and what it says about secrets is what the code does", async () => {
  const text = read("SECURITY.md");
  assert.match(text, /Open a private security advisory on this repository/);
  assert.match(text, /Do not open a public issue or pull request/);
  assert.match(text, /The supported version is the most recent release of the 0\.x line, together with `main`/);
  assert.match(pkg.version, /^0\./, "the page speaks of the 0.x line: update it with the first 1.x release");
  // an OAuth token is refused, and a secret is sealed with libsodium before it is uploaded
  const secrets = await import("../bin/lib/actions-secrets.mjs");
  assert.ok(text.includes(`\`${secrets.OAUTH_PREFIX}\``));
  assert.ok(text.includes("libsodium sealed boxes"));
  assert.match(read("bin", "lib", "actions-secrets.mjs"), /crypto_box_seal/);
  // the ceiling of the App is the one that the bootstrap enforces
  const ceiling = JSON.parse(read("bin", "lib", "app-permissions.json"));
  assert.deepEqual(Object.entries(ceiling).filter(([, level]) => level === "write").map(([name]) => name).sort(), ["actions", "contents", "issues", "pull_requests", "variables"]);
  assert.equal(ceiling.metadata, "read");
  assert.match(text, /contents, pull requests, issues, actions and variables write; metadata read/);
  // the checkouts keep no credentials, the install runs no script, and the package has none of its own
  assert.match(read("src", "reconcile.mjs"), /"persist-credentials": false/);
  assert.ok(text.includes("`persist-credentials: false`") && text.includes("`npm ci --ignore-scripts`"));
  assert.deepEqual(Object.keys(pkg.scripts ?? {}).filter((name) => /install|prepare|prepack/.test(name)), []);
});
