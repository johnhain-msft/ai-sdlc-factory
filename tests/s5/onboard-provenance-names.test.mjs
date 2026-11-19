// E11: what the onboarding inspection takes for a provenance file is data of the manifest, `onboarding.provenanceNames`, not a list of the engine.
//
// The engine knows two names (source.json and provenance.json). A repository whose provenance lives in another file is onboarded by naming that file in the manifest
// of the central repository; the inspection of the target and that of the downstream of one run read the same list, and a list that cannot be one is refused before
// anything is read or written.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import YAML from "yaml";
import { SdlcError } from "../../bin/lib/errors.mjs";
import { DEFAULT_PROVENANCE_NAMES } from "../../bin/lib/inspect-repo.mjs";
import { PROVENANCE_NAME, provenanceNamesOf } from "../../bin/lib/manifest-data.mjs";
import { REPO_ROOT, copyFixtureToGitRepo, createScenario, fixtureRepos, readFixture } from "./helpers/harness.mjs";

const EMPTY = readFixture("manifest.empty.yaml");
const REPOS = fixtureRepos({ "example-owner/node-app": "node-app", "example-owner/lab-like": "lab-like", "example-owner/edge-ok": "edge-ok" });
const block = (names) => `\nonboarding:\n  provenanceNames:${names.length === 0 ? " []" : `\n${names.map((name) => `    - ${name}`).join("\n")}`}\n`;

/** An onboarding run of bin/sdlc-onboard.mjs in process against a manifest that is the given text. */
async function onboard(manifestText, argv, callback) {
  const scenario = await createScenario({ fake: { repos: REPOS }, workspace: { manifest: manifestText } });
  try {
    const run = await scenario.onboard(argv, { env: scenario.env(scenario.appCredentials()) });
    return await callback({ scenario, run, manifest: () => YAML.parse(scenario.workspace.read("sdlc.yaml")) });
  } finally {
    await scenario.cleanup();
  }
}
const instructionsOf = (scenario, key) => scenario.workspace.read(`instructions/${key}.md`);
const strategyOf = (data, key) => data.projects.find((project) => project.projectKey === key).driftAudit.upkeepStrategy;

// ---- reading the names from the manifest ----------------------------------------------------------------------------------------------------

test("a manifest with no onboarding block, or with no provenanceNames in it, has the names of the engine", () => {
  assert.deepEqual(provenanceNamesOf({ projects: [] }), ["source.json", "provenance.json"]);
  assert.deepEqual(provenanceNamesOf({ projects: [], onboarding: {} }), DEFAULT_PROVENANCE_NAMES);
});

test("the names of the manifest are returned as they are, in order; an empty list is a list, not a missing one", () => {
  assert.deepEqual(provenanceNamesOf({ onboarding: { provenanceNames: ["registry.yaml", "source.json"] } }), ["registry.yaml", "source.json"]);
  assert.deepEqual(provenanceNamesOf({ onboarding: { provenanceNames: [] } }), []);
});

test("what cannot be a list of file names is refused, naming where it is and never echoing it", () => {
  const refused = (manifest, expected, label = "sdlc.yaml") => {
    assert.throws(
      () => provenanceNamesOf(manifest, label),
      (error) => error instanceof SdlcError && error.code === "manifest" && expected.test(error.message) && error.message.startsWith(`${label}: `) && !error.message.includes("LEAKED"),
      JSON.stringify(manifest),
    );
  };
  for (const onboarding of [null, [], "LEAKED", 3, true]) refused({ onboarding }, /'onboarding' must be a mapping/);
  for (const provenanceNames of [null, "LEAKED", {}, 3, true]) refused({ onboarding: { provenanceNames } }, /'onboarding\.provenanceNames' must be an array/);
  for (const bad of ["", "a/LEAKED.json", "LEAKED\\a.json", ".", "..", "has LEAKED space.json", "LEAKED\n.json", "x".repeat(101), 3, null, ["LEAKED"], { LEAKED: 1 }]) {
    refused({ onboarding: { provenanceNames: ["source.json", bad] } }, /'onboarding\.provenanceNames\[1\]' must be a file name/);
  }
  refused({ onboarding: [] }, /'onboarding' must be a mapping/, "path/to/sdlc.yaml");
});

// ---- the schema -----------------------------------------------------------------------------------------------------------------------------

const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "sdlc.schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const withBlock = (onboarding) => ({ projects: [], onboarding });

test("the schema accepts onboarding.provenanceNames, empty or not, and nothing else under onboarding", () => {
  assert.equal(validate({ projects: [] }), true, "the block is optional");
  for (const good of [{}, { provenanceNames: [] }, { provenanceNames: ["source.json"] }, { provenanceNames: ["registry.yaml", "sources-lock.json", ".provenance", "a_b-c.d@e+f", "x".repeat(100)] }]) {
    assert.equal(validate(withBlock(good)), true, `${JSON.stringify(good)}: ${JSON.stringify(validate.errors)}`);
  }
  const bad = [
    null, [], "x", 3,
    { provenanceNames: "source.json" }, { provenanceNames: null }, { provenanceNames: {} },
    { provenanceNames: [""] }, { provenanceNames: ["a/b.json"] }, { provenanceNames: ["a\\b.json"] }, { provenanceNames: ["."] }, { provenanceNames: [".."] },
    { provenanceNames: [3] }, { provenanceNames: [null] }, { provenanceNames: ["has space"] }, { provenanceNames: ["x".repeat(101)] },
    { provenanceNames: ["source.json", "source.json"] },
    { other: 1 }, { provenanceNames: ["source.json"], other: 1 },
  ];
  for (const onboarding of bad) assert.equal(validate(withBlock(onboarding)), false, JSON.stringify(onboarding));
});

test("the schema and the onboarding command agree on what a file name is, because they are one pattern", () => {
  const pattern = schema.properties.onboarding.properties.provenanceNames.items.pattern;
  assert.equal(pattern, PROVENANCE_NAME.source);
  for (const probe of ["source.json", "a", ".hidden", "..", ".", "a/b", "a\\b", "", " ", "a b", "é.json", "x".repeat(100), "x".repeat(101), "-x", "@x", "+x", "_x", "a\n", "a\u0000", "A.JSON", "a.b.c"]) {
    assert.equal(PROVENANCE_NAME.test(probe), validate(withBlock({ provenanceNames: [probe] })), JSON.stringify(probe));
  }
});

// ---- both inspections of a run read the list -------------------------------------------------------------------------------------------------

test("a remote target: the provenance file is the file that the manifest names, and with no names the engine's names do not find it", async () => {
  await onboard(EMPTY, ["--repo", "example-owner/lab-like"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.match(instructionsOf(scenario, "lab-like"), /### Provenance files\n\nNone detected\./);
    assert.equal(strategyOf(manifest(), "lab-like"), "code-quality-and-improvement-scan", "nothing detected: the scan strategy");
  });
  await onboard(EMPTY + block(["registry.yaml"]), ["--repo", "example-owner/lab-like"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.match(instructionsOf(scenario, "lab-like"), /### Provenance files\n\n- `docs\/_meta\/registry\.yaml`/);
    assert.equal(strategyOf(manifest(), "lab-like"), "content-and-docs-sync", "a provenance file: the content strategy");
  });
});

test("a local target is read with the same names", async () => {
  const target = copyFixtureToGitRepo("lab-like", "https://github.com/example-owner/lab-like.git");
  try {
    await onboard(EMPTY, ["--repo", target.dir], ({ run, scenario }) => {
      assert.equal(run.code, 0, run.stderr);
      assert.match(instructionsOf(scenario, "lab-like"), /### Provenance files\n\nNone detected\./);
    });
    await onboard(EMPTY + block(["registry.yaml"]), ["--repo", target.dir], ({ run, scenario }) => {
      assert.equal(run.code, 0, run.stderr);
      assert.match(instructionsOf(scenario, "lab-like"), /### Provenance files\n\n- `docs\/_meta\/registry\.yaml`/);
    });
  } finally {
    target.cleanup();
  }
});

test("the downstream is read with the same names: its provenance file is found by them, and a list that does not hold its name finds none", async () => {
  const argv = ["--repo", "example-owner/node-app", "--downstream", "example-owner/edge-ok"];
  for (const names of [null, ["source.json"], ["registry.yaml", "source.json"]]) {
    await onboard(names === null ? EMPTY : EMPTY + block(names), argv, ({ run, manifest }) => {
      assert.equal(run.code, 0, `${JSON.stringify(names)}: ${run.stderr}`);
      assert.equal(manifest().dependencyEdges[0].provenanceFile, "public/imported/source.json");
    });
  }
  for (const names of [["provenance.json"], ["registry.yaml"], []]) {
    await onboard(EMPTY + block(names), argv, ({ run, scenario }) => {
      assert.notEqual(run.code, 0, JSON.stringify(names));
      assert.match(run.stderr, /provenanceFile, provenanceJsonPointer and allowedFiles \(no provenance file found in example-owner\/edge-ok; exactly one is needed\)/);
      assert.equal(scenario.workspace.read("sdlc.yaml"), EMPTY + block(names), "the manifest is as it was");
      assert.equal(scenario.reconcile.calls.length, 0);
    });
  }
});

test("a block that cannot be a list of names stops the run before anything is read, written or requested", async () => {
  for (const names of [["a/b.json"], [".."], [""]]) {
    await onboard(`${EMPTY}\nonboarding:\n  provenanceNames:\n    - ${JSON.stringify(names[0])}\n`, ["--repo", "example-owner/lab-like"], ({ run, scenario }) => {
      assert.notEqual(run.code, 0, JSON.stringify(names));
      assert.match(run.stderr, /onboarding\.provenanceNames\[0\]' must be a file name/);
      assert.deepEqual(scenario.fake.log, [], "no request reached GitHub");
      assert.equal(scenario.workspace.exists("instructions/lab-like.md"), false);
      assert.equal(scenario.reconcile.calls.length, 0);
    });
  }
});

test("the block stays in the manifest that the run writes, where it was", async () => {
  const text = EMPTY + block(["registry.yaml"]);
  await onboard(text, ["--repo", "example-owner/lab-like"], ({ run, scenario, manifest }) => {
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(manifest().onboarding, { provenanceNames: ["registry.yaml"] });
    assert.ok(scenario.workspace.read("sdlc.yaml").endsWith(block(["registry.yaml"])), scenario.workspace.read("sdlc.yaml"));
  });
});
