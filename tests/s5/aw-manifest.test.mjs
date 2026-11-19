// aw.yml is the gh-aw package manifest of this repository: it lets `gh aw add` install the onboarding workflow seed into an orchestrator. It is checked
// against the schema that gh-aw publishes (tests/s5/fixtures/aw_manifest_schema.json) and, for the resource destinations, against the rules in the gh-aw
// document (tests/s5/fixtures/aw-yml-package-manifest.md), which are read from the snapshot and not copied into this test.
//
// The package ships its workflow as a mapping include: the source is the inert copy under payload/ (so that this repository neither compiles nor runs it),
// the destination is where an orchestrator gets it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { ghEnvironment } from "../../bin/lib/gh-runner.mjs";
import { MIN_GH_AW_VERSION } from "../../bin/lib/ghaw-version.mjs";
import { FIXTURES, REPO_ROOT } from "./helpers/harness.mjs";

const schema = JSON.parse(fs.readFileSync(path.join(FIXTURES, "aw_manifest_schema.json"), "utf8"));
const doc = fs.readFileSync(path.join(FIXTURES, "aw-yml-package-manifest.md"), "utf8");
const manifestText = fs.readFileSync(path.join(REPO_ROOT, "aw.yml"), "utf8");
const manifest = YAML.parse(manifestText);
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const mappings = (manifest.includes ?? []).filter((entry) => typeof entry === "object" && entry !== null);
const strings = (manifest.includes ?? []).filter((entry) => typeof entry === "string");

/** Resource destination rules, read from the "Resources" section of the gh-aw document. */
function destinationRules(markdown) {
  const section = markdown.slice(markdown.indexOf("## Resources"));
  const supported = section.slice(section.indexOf("Supported destinations are:"), section.indexOf("Resource destinations must be unique"));
  const bullets = supported.split("\n").filter((line) => line.startsWith("- "));
  return bullets.map((bullet) => {
    const paths = [...bullet.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const directory = paths.find((candidate) => candidate.endsWith("/"));
    const extensions = paths.filter((candidate) => /^\.[a-z]+$/.test(candidate));
    if (/^- Direct children of/.test(bullet)) {
      return (destination) => destination.startsWith(directory) && !destination.slice(directory.length).includes("/") && destination.length > directory.length && extensions.some((extension) => destination.endsWith(extension));
    }
    if (/^- Files under/.test(bullet)) return (destination) => destination.startsWith(directory) && destination.length > directory.length;
    if (/helper scripts under/.test(bullet)) return (destination) => destination.startsWith(directory) && !destination.slice(directory.length).includes("/") && extensions.some((extension) => destination.endsWith(extension));
    return (destination) => destination === paths[0];
  });
}

const rules = destinationRules(doc);
const permitted = (destination) => rules.some((rule) => rule(destination));

/** Files that the reconciler writes into an orchestrator: a package must not ship them, except the onboarding workflow seed that it then overwrites. */
const RECONCILER_OWNED = (destination) =>
  ["sdlc.yaml", "schemas/sdlc.schema.json", ".github/workflows/aw.json"].includes(destination) ||
  destination.endsWith(".lock.yml") ||
  (/^\.github\/workflows\/[^/]+\.md$/.test(destination) && destination !== ".github/workflows/sdlc-onboard.md");

test("aw.yml exists at the repository root and validates against gh-aw's package-manifest schema", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "aw.yml")));
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.trim().length > 0);
});

test("it carries a description (at most 255 characters, as gh aw add warns beyond that)", () => {
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.trim().length > 0);
  assert.ok(manifest.description.length <= 255, `${manifest.description.length} characters`);
});

test("it uses only keys that the schema defines, lists its workflows under `includes` and not under the deprecated `files`", () => {
  for (const key of Object.keys(manifest)) assert.ok(key in schema.properties, `${key} is a schema property`);
  assert.ok(Array.isArray(manifest.includes), "the workflows are listed under `includes`");
  assert.match(schema.properties.files.description, /^Deprecated/, "the schema deprecates `files` in favour of `includes`");
  assert.equal("files" in manifest, false);
});

test("min-version states the gh-aw prerequisite of the package, and it is the version that the commands enforce", () => {
  assert.match(manifest["min-version"], new RegExp(schema.properties["min-version"].pattern));
  assert.equal(manifest["min-version"], `v${MIN_GH_AW_VERSION}`);
});

test("the license is the package's license, and the package README that gh aw add requires sits next to aw.yml", () => {
  assert.equal(manifest.license, packageJson.license);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "README.md")));
  assert.equal("docs" in manifest, false, "the manifest does not support a docs field");
});

test("the onboarding workflow is a mapping include: an inert source under payload/, installed as .github/workflows/sdlc-onboard.md", () => {
  assert.equal(strings.length, 0, "no string entry: a string that starts with .github/ would be read from the consuming repository");
  assert.deepEqual(mappings, [{ source: "payload/workflows/sdlc-onboard.md", destination: ".github/workflows/sdlc-onboard.md", kind: "agentic-workflow" }]);
});

test("every mapping follows the rules of the gh-aw document: package-relative source that exists, direct-child destination, kind that matches the extension", () => {
  assert.ok(mappings.length > 0);
  for (const { source, destination, kind } of mappings) {
    for (const value of [source, destination]) {
      assert.ok(!path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.split("/").includes(".."), `${value} is relative, with forward slashes and no .. segment`);
      assert.ok(!value.endsWith(".lock.yml"), `${value} is not a lock file`);
    }
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...source.split("/"))), `${source} exists in the package`);
    assert.ok(!source.startsWith(".github/"), `${source} is inert here: under .github/workflows/ this repository would run it`);
    assert.match(destination, /^\.github\/workflows\/[^/]+\.(?:md|yml)$/, `${destination} is a direct child of .github/workflows/`);
    assert.equal(path.extname(destination), path.extname(source), "the extension does not change between source and destination");
    assert.equal(kind, path.extname(source) === ".md" ? "agentic-workflow" : "action-workflow", "the kind matches the extension");
  }
  const destinations = mappings.map((entry) => entry.destination.toLowerCase());
  assert.equal(new Set(destinations).size, destinations.length, "two entries never install to one destination");
});

test("this repository does not install the workflow it ships: the destination does not exist at its own root", () => {
  for (const { destination } of mappings) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ...destination.split("/"))), false, `${destination} would be compiled and run here`);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ...destination.replace(/\.md$/, ".lock.yml").split("/"))), false);
  }
});

test("the schema rejects what the document says is unsupported (a docs field, a missing name, a mapping without a destination)", () => {
  assert.equal(validate({ description: "x" }), false);
  assert.equal(validate({ name: "x", docs: "README.md" }), false);
  assert.equal(validate({ name: "x", includes: [{ source: "payload/workflows/sdlc-onboard.md" }] }), false);
  assert.equal(validate({ name: "x", includes: [{ source: "a.md", destination: ".github/workflows/a.md", kind: "other" }] }), false);
  assert.equal(validate({ name: "x", includes: [{ source: "a.md", destination: ".github/workflows/a.md", kind: "agentic-workflow" }] }), true);
});

test("the destination rules are read from the snapshot of the gh-aw document", () => {
  assert.equal(rules.length, 4, "four destination bullets are listed in the Resources section");
  assert.equal(permitted(".github/aw/helper.json"), true);
  assert.equal(permitted(".github/CODEOWNERS"), true);
  assert.equal(permitted(".github/workflows/shared/util.mjs"), true);
  assert.equal(permitted(".github/workflows/shared/util.cjs"), true);
  assert.equal(permitted(".github/ISSUE_TEMPLATE/bug.yml"), true);
  assert.equal(permitted(".github/ISSUE_TEMPLATE/bug.yaml"), true, "the .yaml extension is permitted too");
  assert.equal(permitted(".github/ISSUE_TEMPLATE/nested/bug.yml"), false);
  assert.equal(permitted(".github/workflows/shared/util.js"), false);
  assert.equal(permitted("sdlc.yaml"), false);
});

test("every resource that aw.yml declares has a permitted destination, and none is a file that the reconciler owns", () => {
  for (const resource of manifest.resources ?? []) {
    assert.ok(permitted(resource.destination), `${resource.destination} is a permitted destination`);
    assert.equal(RECONCILER_OWNED(resource.destination), false, `${resource.destination} is not owned by the reconciler`);
  }
});

test("the only reconciler-owned file that the package installs is the onboarding workflow seed, which the reconciler overwrites", () => {
  for (const { destination } of mappings) assert.equal(RECONCILER_OWNED(destination), false, `${destination} is a seed, not a rendering`);
  for (const owned of ["sdlc.yaml", "schemas/sdlc.schema.json", ".github/workflows/aw.json", ".github/workflows/drift-x.md", ".github/workflows/cascade-router.lock.yml"]) {
    assert.equal(RECONCILER_OWNED(owned), true, owned);
  }
  assert.equal(RECONCILER_OWNED(".github/workflows/sdlc-onboard.md"), false);
});

// The real compiler validates a repository-root aw.yml before it compiles (the gh-aw document: "gh aw compile validates repository-root manifests before
// compilation"). It needs workflows to compile, so the scratch repository holds the package as an orchestrator has it after `gh aw add`: the manifest, the README,
// the payload and the installed workflow. Opt-in, because it needs the gh-aw CLI: SDLC_REAL_GH_AW=1 (and SDLC_GH_AW_DATA_HOME for an isolated install of 1.0.1 or newer).
const realCompiler = { skip: process.env.SDLC_REAL_GH_AW === "1" ? false : "set SDLC_REAL_GH_AW=1 to run the real gh-aw compiler (it needs the gh-aw CLI, version 1.0.1 or newer)" };

function compileWith(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-awyml-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const put = (relative, content) => {
      fs.mkdirSync(path.dirname(path.join(root, ...relative.split("/"))), { recursive: true });
      fs.writeFileSync(path.join(root, ...relative.split("/")), content);
    };
    const payload = fs.readFileSync(path.join(REPO_ROOT, "payload", "workflows", "sdlc-onboard.md"), "utf8");
    put("aw.yml", text);
    put("README.md", fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8"));
    put("payload/workflows/sdlc-onboard.md", payload);
    put(".github/workflows/sdlc-onboard.md", payload);
    put(".github/workflows/aw.json", `${JSON.stringify({ strict: true }, null, 2)}\n`);
    put(".github/aw/actions-lock.json", fs.readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "actions-lock.json"), "utf8"));
    const outcome = spawnSync("gh", ["aw", "compile", "--strict", "--purge", "--json"], { cwd: root, env: ghEnvironment(process.env), encoding: "utf8", windowsHide: true });
    return { code: outcome.status, output: `${outcome.stdout}\n${outcome.stderr}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the real compiler accepts the committed aw.yml and compiles the workflow that it installs", realCompiler, () => {
  const outcome = compileWith(manifestText);
  assert.equal(outcome.code, 0, outcome.output);
  assert.equal(/manifest_error/.test(outcome.output), false, outcome.output);
  assert.match(outcome.output, /"valid": true/);
});

test("the real compiler does validate aw.yml: a missing name, a kind that does not match the source and a missing source are each rejected, so the pass above is not vacuous", realCompiler, () => {
  const bad = {
    "no name": "manifest-version: \"1\"\ndescription: no name here\ndocs: not-supported\n",
    "a kind that does not match the source": manifestText.replace("kind: agentic-workflow", "kind: action-workflow"),
    "a source that does not exist": manifestText.replace("source: payload/workflows/sdlc-onboard.md", "source: payload/workflows/missing.md"),
  };
  for (const [label, text] of Object.entries(bad)) {
    const outcome = compileWith(text);
    assert.notEqual(outcome.code, 0, `${label}: ${outcome.output}`);
    assert.match(outcome.output, /manifest_error/, label);
  }
});
