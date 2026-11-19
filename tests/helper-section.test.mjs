// adaptation.helpers and helperSection (design section E5): the data of an orchestrator's own helper scripts is opaque to the engine, which keeps one rule about it:
// the edges that declare a helper declare it the same way, because a helper command is not told which edge it serves.
import assert from "node:assert/strict";
import test from "node:test";
import { helperSection, ManifestError } from "../src/adaptation/manifest.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const aiEdge = (edgeId, helpers, extra = {}) => ({ edgeId, mode: "ai-adaptation", ...(helpers === undefined ? {} : { adaptation: { helpers, ...extra } }) });
const mechanical = (edgeId, helpers) => ({ edgeId, mode: "mechanical", adaptation: { helpers } });

test("helperSection returns the entry that the AI edges declare for a helper, and null when none declares it", () => {
  const document = { dependencyEdges: [aiEdge("a", { sources: { manifest: "app/sources.json" }, pins: { files: ["x.ts"] } }), aiEdge("b", undefined)] };
  assert.deepEqual(helperSection(document, "sources"), { manifest: "app/sources.json" });
  assert.deepEqual(helperSection(document, "pins"), { files: ["x.ts"] });
  assert.equal(helperSection(document, "nothing-like-this"), null);
  assert.equal(helperSection({ dependencyEdges: [] }, "sources"), null);
  assert.equal(helperSection({}, "sources"), null);
});

test("edges that declare a helper the same way are one answer, and edges that declare it differently are refused", () => {
  const same = { dependencyEdges: [aiEdge("a", { sources: { manifest: "app/sources.json" } }), aiEdge("b", { sources: { manifest: "app/sources.json" } })] };
  assert.deepEqual(helperSection(same, "sources"), { manifest: "app/sources.json" });
  const different = { dependencyEdges: [aiEdge("a", { sources: { manifest: "app/sources.json" } }), aiEdge("b", { sources: { manifest: "other/sources.json" } })] };
  assert.throws(() => helperSection(different, "sources"), (error) => error instanceof ManifestError && /the edges 'a' and 'b' declare different adaptation\.helpers\.sources data, so the command cannot tell which one applies/.test(error.message));
});

test("only the helpers of an AI edge count, and only under adaptation.helpers: the engine's own sections are never a helper", () => {
  const document = {
    dependencyEdges: [
      mechanical("m", { sources: { manifest: "nobody-reads-this.json" } }),
      aiEdge("a", { sources: { manifest: "app/sources.json" } }, { preflightReports: ["report.txt"] }),
      { edgeId: "c", mode: "ai-adaptation", adaptation: { sources: { manifest: "not-under-helpers.json" } } },
    ],
  };
  assert.deepEqual(helperSection(document, "sources"), { manifest: "app/sources.json" });
  assert.equal(helperSection(document, "preflightReports"), null, "a section of the engine is not a helper");
});

// ---- the schema ------------------------------------------------------------------------------------------------------------------------------

function render(t, helpers, extra = {}) {
  const work = createWorkspace(t, { mutate: (manifest) => (manifest.dependencyEdges[1].adaptation = { helpers, ...extra }) });
  return renderFleet(referenceRequest(), { cwd: work.dir });
}

test("adaptation.helpers takes anything under any name, and renders nothing", (t) => {
  const plain = renderFleet(referenceRequest(), { cwd: createWorkspace(t).dir });
  const result = render(t, { sources: { manifest: "app/sources.json", nested: [{ a: 1 }, "b", null, true] }, "another-helper": ["x"], count: 3 });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  for (const [file, text] of plain.files) assert.equal(result.files.get(file), text, `${file}: a helper's data changes no rendered file`);
});

test("the engine's own keys of adaptation stay closed: adopter keys belong under helpers, not directly under adaptation", (t) => {
  for (const key of ["removedHelper", "legacyHelper", "typo"]) {
    const work = createWorkspace(t, { mutate: (manifest) => (manifest.dependencyEdges[1].adaptation = { [key]: { manifest: "x.json" } }) });
    const result = renderFleet(referenceRequest(), { cwd: work.dir });
    assert.equal(result.ok, false, key);
    const errors = result.result.validationResults.flatMap((entry) => entry.errors);
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("adaptation") && error.includes(key)), `${key}: ${errors.join(" | ")}`);
  }
  const notAnObject = render(t, ["a"]);
  assert.equal(notAnObject.ok, false, "helpers is a mapping");
});
