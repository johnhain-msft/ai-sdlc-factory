// docs/manifest.md documents the manifest schema key by key. These tests keep the two in step: every property of schemas/sdlc.schema.json has a row, no row
// describes a key that the schema does not define, the mechanical columns (type, required, default) agree with the schema, every key that holds a value has an
// example, the complete example in the document is accepted by the renderer, and the table of checks beyond the schema lists every rule that the reconciler
// can raise about a manifest.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { renderFleet } from "../src/reconcile.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", "sdlc.schema.json"), "utf8"));
const markdown = fs.readFileSync(path.join(ROOT, "docs", "manifest.md"), "utf8");
const reconcileSource = fs.readFileSync(path.join(ROOT, "src", "reconcile.mjs"), "utf8");

// ---------------------------------------------------------------------------------------------------------------------
// The schema: every property path, in the form that the document uses (`projects[].driftAudit.enabled`)
// ---------------------------------------------------------------------------------------------------------------------

function resolve(node) {
  if (node !== null && typeof node === "object" && typeof node.$ref === "string") {
    const name = node.$ref.replace("#/definitions/", "");
    return { name, node: { ...schema.definitions[name], ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref")) } };
  }
  return { name: null, node };
}

/** The words that the Type cell of a row has to contain. */
function typeWords(node) {
  if (node.enum) return node.enum.map(String);
  if (node.const !== undefined) return [JSON.stringify(node.const)];
  if (node.oneOf) return node.oneOf.flatMap((entry) => typeWords(resolve(entry).node));
  if (node.type === "array") return ["array", ...typeWords(resolve(node.items ?? {}).node)];
  return [node.type ?? "any"];
}

/**
 * Breadth first, so that a definition that is used twice (`dedupe`) is expanded where it is shallowest, and documented once; the other place has a row for
 * the key itself, which says that it takes the same keys.
 */
function schemaRows() {
  const rows = [];
  const expanded = new Set();
  const required = new Set(schema.required ?? []);
  const queue = Object.entries(schema.properties).map(([key, node]) => ({ path: key, node, required: required.has(key) }));
  while (queue.length > 0) {
    const entry = queue.shift();
    const { name, node } = resolve(entry.node);
    rows.push({ path: entry.path, words: typeWords(node), required: entry.required, default: node.default, enumValues: node.enum, isContainer: false });
    let objectNode = node;
    let prefix = entry.path;
    let definition = name;
    if (node.type === "array" && node.items !== undefined) {
      const item = resolve(node.items);
      objectNode = item.node;
      prefix = `${entry.path}[]`;
      definition = item.name;
    }
    if (objectNode.properties === undefined) continue;
    rows.at(-1).isContainer = true;
    if (definition !== null && expanded.has(definition)) continue;
    if (definition !== null) expanded.add(definition);
    const requiredKeys = new Set(objectNode.required ?? []);
    for (const [key, child] of Object.entries(objectNode.properties)) queue.push({ path: `${prefix}.${key}`, node: child, required: requiredKeys.has(key) });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// The document: the rows of the five-column reference tables
// ---------------------------------------------------------------------------------------------------------------------

function documentRows() {
  const rows = new Map();
  const duplicates = [];
  for (const line of markdown.split("\n")) {
    const cells = line.startsWith("| `") ? line.slice(1, line.lastIndexOf("|")).split("|").map((cell) => cell.trim()) : [];
    if (cells.length !== 5) continue;
    const key = /^`([^`]+)`$/.exec(cells[0])?.[1];
    if (key === undefined) continue;
    if (rows.has(key)) duplicates.push(key);
    rows.set(key, { type: cells[1], required: cells[2], default: cells[3], description: cells[4] });
  }
  return { rows, duplicates };
}

const expected = schemaRows();
const documented = documentRows();

test("the schema has the properties that this test expects to find, so that it cannot pass on an empty list", () => {
  assert.ok(expected.length >= 100, `${expected.length} properties`);
  assert.equal(expected.length, new Set(expected.map((row) => row.path)).size, "no path twice");
  for (const path_ of ["projects", "projects[].driftAudit.stagedScripts", "dependencyEdges[].preflightChecks[].classifier", "factory.private", "state.dialect", "dedupe.upkeeps[].branchPrefixes", "onboarding.provenanceNames"]) {
    assert.ok(expected.some((row) => row.path === path_), path_);
  }
});

test("every property of schemas/sdlc.schema.json has a row in docs/manifest.md", () => {
  const missing = expected.filter((row) => !documented.rows.has(row.path)).map((row) => row.path);
  assert.deepEqual(missing, [], "add a row for each of these keys");
});

test("no row of docs/manifest.md describes a key that the schema does not define, and no key has two rows", () => {
  const known = new Set(expected.map((row) => row.path));
  assert.deepEqual([...documented.rows.keys()].filter((key) => !known.has(key)), [], "remove or correct these rows");
  assert.deepEqual(documented.duplicates, []);
});

test("the Required column agrees with the schema", () => {
  const wrong = expected.filter((row) => documented.rows.get(row.path)?.required !== (row.required ? "yes" : "no")).map((row) => `${row.path}: ${documented.rows.get(row.path)?.required} (schema: ${row.required ? "yes" : "no"})`);
  assert.deepEqual(wrong, []);
});

test("the Default column holds the schema's default, and a dash where the schema has none", () => {
  const wrong = [];
  for (const row of expected) {
    const cell = documented.rows.get(row.path)?.default;
    if (cell === undefined) continue;
    const text = row.default === undefined ? undefined : typeof row.default === "string" ? row.default : JSON.stringify(row.default);
    if (text === undefined ? cell !== "—" : !cell.includes(text)) wrong.push(`${row.path}: ${cell} (schema: ${text ?? "none"})`);
  }
  assert.deepEqual(wrong, []);
});

test("the Type column names the type of the schema, every member of an enum and nothing else, and the value of a constant", () => {
  const wrong = [];
  for (const row of expected) {
    const cell = documented.rows.get(row.path)?.type;
    if (cell === undefined) continue;
    const missing = row.words.filter((word) => !cell.includes(word));
    if (missing.length > 0) wrong.push(`${row.path}: '${cell}' lacks ${missing.join(", ")}`);
    const members = row.enumValues?.map((value) => `\`${value}\``).join(", ");
    if (members !== undefined && cell !== `enum: ${members}`) wrong.push(`${row.path}: '${cell}' is not 'enum: ${members}'`);
  }
  assert.deepEqual(wrong, []);
});

test("every row has a description, and every key that holds a value has an example", () => {
  const wrong = [];
  for (const row of expected) {
    const description = documented.rows.get(row.path)?.description;
    if (description === undefined) continue;
    if (description.length < 20) wrong.push(`${row.path}: no description`);
    if (!row.isContainer && !/Example: /.test(description)) wrong.push(`${row.path}: no example`);
  }
  assert.deepEqual(wrong, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The complete example is a manifest that the renderer accepts
// ---------------------------------------------------------------------------------------------------------------------

function completeExample() {
  const block = /## A complete example[\s\S]*?```yaml\n([\s\S]*?)\n```/.exec(markdown)?.[1];
  assert.ok(block !== undefined, "the document has a complete example");
  return block.replaceAll("<owner>", "example-org");
}

test("the complete example is a manifest that the renderer accepts, and it renders the workflows that the document names", (t) => {
  const text = completeExample();
  const work = createWorkspace(t, { text, files: { "package.json": JSON.stringify({ name: "orchestrator", dependencies: { "ai-sdlc-factory": "github:example-org/ai-sdlc-factory#v0.1.0" } }) } });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.deepEqual(
    [...result.files.keys()].sort(),
    [
      ".github/workflows/aw.json",
      ".github/workflows/cascade-ai-lab-to-hub.md",
      ".github/workflows/cascade-mechanical-docs-to-hub.md",
      ".github/workflows/cascade-router.yml",
      ".github/workflows/drift-docs-site.md",
      ".github/workflows/implement-docs-site.md",
      ".github/workflows/sdlc-onboard.md",
    ],
  );
});

test("the complete example uses every top-level key of the schema except the one that is only meaningful with the api-key engine", () => {
  const used = new Set(Object.keys(YAML.parse(completeExample())));
  const unused = Object.keys(schema.properties).filter((key) => !used.has(key));
  assert.deepEqual(unused, ["engineApiKeySecret"]);
});

test("the complete example fails when a required key is missing: the check above is not vacuous", (t) => {
  const broken = completeExample().replace("    defaultBranch: main\n", "");
  const work = createWorkspace(t, { text: broken });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.result), /defaultBranch/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The checks beyond the schema
// ---------------------------------------------------------------------------------------------------------------------

/** The rule ids that the reconciler raises about a manifest: validateSemantics and the factory block, up to the rendering primitives. `seen(id, ...)` raises `rule(id, ...)`. */
function manifestRuleIds() {
  const start = reconcileSource.indexOf("function factoryProblems(");
  const end = reconcileSource.indexOf("// Rendering primitives");
  assert.ok(start !== -1 && end > start, "the region of the manifest checks was found");
  return [...new Set([...reconcileSource.slice(start, end).matchAll(/(?:rule|seen)\("([a-z0-9-]+)"/g)].map((match) => match[1]))].sort();
}

function documentedRuleIds() {
  const section = markdown.slice(markdown.indexOf("## Checks beyond the schema"));
  const ids = [];
  for (const line of section.split("\n")) {
    const cells = line.startsWith("| `") ? line.slice(1, line.lastIndexOf("|")).split("|").map((cell) => cell.trim()) : [];
    if (cells.length === 2) ids.push(...[...cells[0].matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]));
  }
  return ids.sort();
}

test("the table of checks beyond the schema lists every rule that the reconciler raises about a manifest, and only rules that exist", () => {
  assert.deepEqual(documentedRuleIds(), manifestRuleIds());
  const everyRule = new Set([...reconcileSource.matchAll(/(?:rule|seen)\("([a-z0-9-]+)"/g)].map((match) => match[1]));
  for (const id of documentedRuleIds()) assert.ok(everyRule.has(id), id);
});

test("a refusal starts with the rule id that the document names for it", (t) => {
  const refused = (mutate) => {
    const work = createWorkspace(t, { mutate });
    const result = renderFleet(referenceRequest(), { cwd: work.dir });
    assert.equal(result.ok, false);
    return result.result.validationResults.flatMap((entry) => entry.errors);
  };
  const documentedIds = new Set(documentedRuleIds());
  const cases = {
    "factory-source-required": (manifest) => (manifest.factory = { package: "ai-sdlc-factory", private: true }),
    "edge-state-variable": (manifest) => (manifest.dependencyEdges[0].stateVariable = "SDLC_SYNC_STATE_OTHER"),
    "duplicate-edge-id": (manifest) => (manifest.dependencyEdges[1].edgeId = manifest.dependencyEdges[0].edgeId),
    "edge-reviewers-empty": (manifest) => (manifest.dependencyEdges[0].reviewers = []),
    "command-blank": (manifest) => (manifest.dependencyEdges[0].buildCommands = ["  "]),
    "manifest-expression-opener": (manifest) => (manifest.dependencyEdges[0].adaptationInstructions = "${{ secrets.X }}"),
  };
  for (const [id, mutate] of Object.entries(cases)) {
    assert.ok(documentedIds.has(id), `${id} is documented`);
    assert.ok(refused(mutate).some((message) => message.startsWith(`${id}: `)), id);
  }
});
