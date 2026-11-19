// AC48-AC50: check (iv) of src/verify-immutable-gates.mjs. Under `node --frozen-intrinsics` the locked rule and sanitiser modules are loaded and every value that
// they export is frozen before any editable module is imported; the rule checker, the pinned constants and the sanitiser then run in that process; and Vitest
// runs the companion test files, whose locked tests must all have passed. The downstream's TypeScript is loaded by Node's own type stripping here (the synthetic
// checkout has no tsx), and Vitest is a stand-in that writes the report that a test gives it, so nothing leaves this machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deepFreeze, readInvariants } from "../../src/adaptation/frozen-harness.mjs";
import { evaluateLockedTests } from "../../src/adaptation/vitest-run.mjs";
import { fixture, readJson } from "./helpers/fixtures.mjs";
import { gateManifest } from "./helpers/gate-fleet.mjs";
import { policyOf, read, replaceOnce, scenario, shown } from "./helpers/gates.mjs";

const WORKFLOW = "cascade-ai-gadget-lessons";
const CONTENT = "web";
const PAGES = `${CONTENT}/pages.ts`;
const RULES = "kernel/limits.ts";
const SHARED = `${CONTENT}/shared.ts`;
const TERMS = "checks/terms.ts";
const SITE_TEST = "checks/site.test.ts";
const EDITABLE_BODY = "expect(1).toBe(1);";

// A module of the content directory that re-exports the locked values: the way an editable module reaches a locked value without a new import of the locked
// module, which check (iii) would catch. It is part of the base, so only check (iv) can see what an editable module does to the values that it re-exports.
const SHARED_SOURCE = [
  "export { FORBIDDEN, MAX_LINES } from '../kernel/limits';",
  "export { scanText } from '../checks/terms';",
  "",
].join("\n");
const withShared = () => ({ [SHARED]: SHARED_SOURCE });
const prependToPages = (code) => (dir) => ({ [PAGES]: `${code}\n${read(dir, PAGES)}` });
const importShared = "import { FORBIDDEN, MAX_LINES, scanText } from './shared';";

const pageWithLines = (count) => `export const pages = [{ lines: ${JSON.stringify(Array.from({ length: count }, (_, index) => `line ${index}`))} }];`;
const reportOf = () => ({
  success: true,
  testResults: [{
    name: `/work/downstream/${SITE_TEST}`,
    status: "passed",
    assertionResults: [
      { ancestorTitles: ["site guard rails"], title: "keeps the kernel limits", status: "passed" },
      { ancestorTitles: ["site extras"], title: "may be edited", status: "passed" },
    ],
  }],
});
const violation = (result, file, pattern) => {
  assert.equal(result.code, 1, shown(result));
  assert.equal(result.json.status, "violation", shown(result));
  assert.ok(result.json.violatingFiles.includes(file), `${file} in ${JSON.stringify(result.json.violatingFiles)}\n${result.stderr}`);
  if (pattern) assert.match(result.stderr, pattern, shown(result));
};

/** Replaces the Vitest stand-in by one that also records how it was started; returns a reader of the recorded calls. */
function recordVitestCalls(dir) {
  const script = path.join(dir, "node_modules", "vitest", "vitest.mjs");
  const log = path.join(dir, "node_modules", "vitest", "calls.jsonl");
  const recorder = [
    'import recorder from "node:fs";',
    `recorder.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nodeOptions: process.env.NODE_OPTIONS ?? "", frozen: Object.isFrozen(Object.prototype) }) + "\\n");`,
    "",
  ].join("\n");
  fs.writeFileSync(script, recorder + fs.readFileSync(script, "utf8"));
  return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
}

test("AC48/AC50: a clean change of an editable module is ok, and check (iv) really ran: Vitest started once, in the checkout, over the companion file, with the JSON reporter and without the frozen flag", () => {
  const checked = scenario({ mutate: (dir) => ({ [PAGES]: replaceOnce(read(dir, PAGES), "export const pages = [p1];", "export const pages = [p1, p1];") }) });
  const calls = recordVitestCalls(checked.dir);
  const result = checked.run({ env: { NODE_OPTIONS: "--frozen-intrinsics --max-old-space-size=1024" } });
  assert.equal(result.code, 0, shown(result));
  assert.deepEqual(result.json, { status: "ok", violatingFiles: [] });
  const recorded = calls();
  assert.equal(recorded.length, 1, "Vitest ran exactly once");
  const [call] = recorded;
  assert.equal(call.argv[0], "run");
  assert.ok(call.argv.includes("--reporter=json"), JSON.stringify(call.argv));
  assert.ok(call.argv.some((argument) => argument.startsWith("--outputFile=")), JSON.stringify(call.argv));
  assert.equal(call.argv.at(-1), SITE_TEST);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(checked.dir), "Vitest runs in the checkout");
  assert.equal(call.frozen, false, "Vitest patches the built-ins, so its process must not be frozen");
  assert.doesNotMatch(call.nodeOptions, /frozen-intrinsics/);
  assert.match(call.nodeOptions, /--max-old-space-size=1024/, "the other options of the environment are kept");
});

test("AC48: every value that a locked module exports is frozen before an editable module is imported: an editable module that only checks it is let through, and one that expects an unfrozen value is not", () => {
  const probe = [
    importShared,
    "const frozen = [FORBIDDEN, FORBIDDEN.words, MAX_LINES, scanText].every((value) => Object.isFrozen(value));",
    "if (!frozen) throw new Error('a locked value was not frozen when this module was imported');",
  ].join("\n");
  const frozen = scenario({ prepare: withShared, mutate: prependToPages(probe) }).run();
  assert.equal(frozen.code, 0, shown(frozen));
  const control = scenario({ prepare: withShared, mutate: prependToPages(`${importShared}\nif (Object.isFrozen(FORBIDDEN)) throw new Error('FORBIDDEN was already frozen');`) }).run();
  violation(control, PAGES, /FORBIDDEN was already frozen/);
});

test("AC48: an editable module that changes a locked value at import time, through a path that check (iii) cannot see, gets a TypeError and is a violation (exit 1) that names that module", () => {
  const mutations = [
    ["a nested array element", "FORBIDDEN.words[0] = 'changed';"],
    ["a nested array", "FORBIDDEN.words.push('extra');"],
    ["an exported object", "FORBIDDEN.words = [];"],
    ["a function of the sanitiser", "(scanText as unknown as { patched: boolean }).patched = true;"],
    ["a built-in", "(Array.prototype as unknown as { includes: () => boolean }).includes = () => true;"],
  ];
  for (const [name, code] of mutations) {
    const result = scenario({ prepare: withShared, mutate: prependToPages(`${importShared}\nvoid [FORBIDDEN, MAX_LINES, scanText];\n${code}`) }).run();
    violation(result, PAGES, /pages\.ts.*\(TypeError\): Cannot (?:assign to read only|add) property/);
    assert.deepEqual(result.json.violatingFiles, [PAGES], `${name}: only the module that tried it`);
  }
  const clean = scenario({ prepare: withShared, mutate: prependToPages(`${importShared}\nvoid [FORBIDDEN, MAX_LINES, scanText];`) }).run();
  assert.equal(clean.code, 0, `the same module without the mutation is fine: ${shown(clean)}`);
});

test("AC48: a locked module that cannot be imported at all is a violation that names it (exit 1)", () => {
  const result = scenario({ prepare: (dir) => ({ [TERMS]: `throw new Error("the sanitiser is broken");\n${read(dir, TERMS)}` }) }).run();
  violation(result, TERMS, /the locked module checks\/terms\.ts cannot be imported: the sanitiser is broken/);
});

test("AC48: an editable module that cannot be imported (a syntax error, a missing module, a throw at the top level) is a violation that names it", () => {
  const broken = [
    ["a syntax error", "export const = ;"],
    ["a module that does not exist", "import './nowhere-at-all';"],
    ["a throw at the top level", "throw new Error('no content for you');"],
  ];
  for (const [name, code] of broken) {
    const result = scenario({ mutate: prependToPages(code) }).run();
    assert.equal(result.code, 1, `${name}: ${shown(result)}`);
    assert.ok(result.json.violatingFiles.includes(PAGES), `${name}: ${result.stdout}`);
  }
});

test("AC49: the declared checker runs in process; an error or warning names the changed module, and the exact boundary passes", () => {
  for (const level of ["error", "warn"]) {
    const result = scenario({
      prepare: (dir) => ({ [RULES]: replaceOnce(read(dir, RULES), "[{ rule: 'too-long'", `[{ level: '${level}', rule: 'too-long'`) }),
      mutate: (dir) => ({ [PAGES]: replaceOnce(read(dir, PAGES), "export const pages = [p1];", pageWithLines(13)) }),
    }).run();
    assert.equal(result.code, 1, `${level}: ${shown(result)}`);
    violation(result, PAGES, new RegExp(`${level} too-long page 0`));
    assert.match(result.stderr, /check \(iv\)/);
  }
  const within = scenario({ mutate: (dir) => ({ [PAGES]: replaceOnce(read(dir, PAGES), "export const pages = [p1];", pageWithLines(12)) }) }).run();
  assert.equal(within.code, 0, `a page within every limit passes: ${shown(within)}`);
});

test("AC49: a finding in a base that was already unclean is still a violation, and it names the course module when no editable module changed", () => {
  const result = scenario({ prepare: (dir) => ({ [PAGES]: replaceOnce(read(dir, PAGES), "export const pages = [p1];", pageWithLines(13)) }) }).run();
  violation(result, PAGES, /too-long/);
});

test("AC49: pinned scalar and object constants must match exactly, including their fields, even when the change did not touch them", () => {
  const manifest = gateManifest();
  manifest.dependencyEdges[0].immutableGates.inProcessInvariants.constants.push({ module: RULES, export: "FORBIDDEN", value: { words: ["hush"] } });
  const rates = [
    ["the scalar limit", (text) => replaceOnce(text, "export const MAX_LINES = 12;", "export const MAX_LINES = 13;"), /MAX_LINES is 13, not the pinned 12/],
    ["an object's nested value", (text) => replaceOnce(text, "{ words: ['hush'] }", "{ words: ['quiet'] }"), /FORBIDDEN is .*quiet.*not the pinned/],
    ["an added object field", (text) => replaceOnce(text, "{ words: ['hush'] }", "{ words: ['hush'], extra: 1 }"), /FORBIDDEN is/],
  ];
  for (const [name, change, pattern] of rates) {
    const result = scenario({ manifest, prepare: (dir) => ({ [RULES]: change(read(dir, RULES)) }) }).run();
    assert.equal(result.code, 1, `${name}: ${shown(result)}`);
    violation(result, RULES, pattern);
  }
});

test("AC49: the declared sanitiser checks changed editable modules and companion tests, not untouched files or a fragment of a protected phrase", () => {
  const prepare = (dir) => ({ [TERMS]: read(dir, TERMS).replaceAll("'hush'", "'quiet phrase'") });
  const note = (text) => `${text}\nexport const note = "quiet phrase";\n`;
  const inModule = scenario({ prepare, mutate: (dir) => ({ [PAGES]: note(read(dir, PAGES)) }) }).run();
  violation(inModule, PAGES, /scanText found 1 protected phrase/);
  const inTest = scenario({
    prepare,
    mutate: (dir) => ({ [SITE_TEST]: replaceOnce(read(dir, SITE_TEST), EDITABLE_BODY, `// quiet phrase\n    ${EDITABLE_BODY}`) }),
  }).run();
  violation(inTest, SITE_TEST, /scanText found 1 protected phrase/);
  const unchanged = scenario({ prepare: (dir) => ({ ...prepare(dir), [PAGES]: note(read(dir, PAGES)) }) }).run();
  assert.equal(unchanged.code, 0, `a phrase in a file that the change did not touch is not this change's business: ${shown(unchanged)}`);
  const phraseOnly = scenario({ prepare, mutate: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const note = "quiet";\n` }) }).run();
  assert.equal(phraseOnly.code, 0, `one word of a two-word phrase is not the phrase: ${shown(phraseOnly)}`);
});

test("AC49: a change that is only in the work tree is run through the same checks as a commit", () => {
  const result = scenario({ commit: false, mutate: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const note = "hush";\n` }) }).run();
  violation(result, PAGES, /scanText/);
});

test("AC50: Vitest runs over the companion test file of the workflow and every locked test must be in its JSON report and have passed", () => {
  const outcomes = [
    ["every locked test passed", (report) => report, 0],
    ["a locked it() skipped", (report) => { report.testResults[0].assertionResults[0].status = "skipped"; return report; }, 1],
    ["a locked it() absent from the report", (report) => { report.testResults[0].assertionResults.shift(); return report; }, 1],
  ];
  for (const [name, change, code] of outcomes) {
    const result = scenario({ report: change(reportOf()) }).run();
    assert.equal(result.code, code, `${name}: ${shown(result)}`);
    assert.equal(result.json.status, code === 0 ? "ok" : "violation");
    if (code === 1) {
      assert.deepEqual(result.json.violatingFiles, [SITE_TEST]);
      assert.match(result.stderr, /check \(iv\): checks\/site\.test\.ts: it\(".+"\)/);
    }
  }
});

test("AC50: a locked it() that failed, is pending or is a todo is a violation; so is one whose status is not the string passed", () => {
  const base = reportOf();
  for (const status of ["failed", "pending", "todo", "skipped", "disabled", undefined]) {
    const report = structuredClone(base);
    report.testResults[0].assertionResults[0].status = status;
    const result = scenario({ report }).run();
    assert.equal(result.code, 1, `${String(status)}: ${shown(result)}`);
    assert.deepEqual(result.json.violatingFiles, [SITE_TEST]);
  }
});

test("AC50: for a locked describe() every test under it must be in the report and have passed; a test of an unlocked describe may fail without a violation", () => {
  const passed = scenario({ report: reportOf() }).run();
  assert.equal(passed.code, 0, shown(passed));
  const failedReport = reportOf();
  failedReport.testResults[0].assertionResults[0].status = "failed";
  const childFailed = scenario({ report: failedReport }).run();
  violation(childFailed, SITE_TEST, /describe\("site guard rails"\) > keeps the kernel limits.*"failed"/);
  const unlockedFailure = reportOf();
  unlockedFailure.testResults[0].assertionResults[1].status = "failed";
  assert.equal(unlockedFailure.testResults[0].assertionResults[1].ancestorTitles[0], "site extras");
  const unlocked = scenario({ report: unlockedFailure }).run();
  assert.equal(unlocked.code, 0, `the extras describe is not locked: ${shown(unlocked)}`);
  const absent = reportOf();
  absent.testResults[0].assertionResults = absent.testResults[0].assertionResults.filter((entry) => entry.ancestorTitles[0] !== "site guard rails");
  violation(scenario({ report: absent }).run(), SITE_TEST, /describe\("site guard rails"\) did not appear/);
});

test("AC50: the workflow that owns two companion files is judged on both of them", () => {
  const extra = "checks/extra.test.ts";
  const manifest = gateManifest();
  manifest.dependencyEdges[0].immutableGates.lockedTestBlocks.push({
    file: extra,
    blocks: [{ kind: "it", title: "keeps the kernel limits" }],
  });
  const prepare = (dir) => ({ [extra]: read(dir, SITE_TEST) });
  const report = reportOf();
  report.testResults.push({ ...structuredClone(report.testResults[0]), name: `/work/downstream/${extra}` });
  const passed = scenario({ manifest, prepare, report }).run();
  assert.equal(passed.code, 0, shown(passed));
  report.testResults[1].assertionResults[0].status = "failed";
  const failed = scenario({ manifest, prepare, report }).run();
  violation(failed, extra, /keeps the kernel limits/);
  assert.deepEqual(failed.json.violatingFiles, [extra]);
});

test("AC50: a Vitest that writes no JSON report is a violation of every companion file (exit 1); a checkout without Vitest cannot be judged (exit 2, no JSON)", () => {
  const silent = scenario({});
  fs.writeFileSync(path.join(silent.dir, "node_modules", "vitest", "vitest.mjs"), "process.exitCode = 1;\n");
  violation(silent.run(), SITE_TEST, /Vitest produced no JSON report/);
  const garbage = scenario({});
  fs.writeFileSync(path.join(garbage.dir, "node_modules", "vitest", "vitest.mjs"), "process.stdout.write('not json at all');\nprocess.exitCode = 1;\n");
  violation(garbage.run(), SITE_TEST, /Vitest produced no JSON report/);
  const absent = scenario({ vitest: false });
  const result = absent.run();
  assert.equal(result.code, 2, shown(result));
  assert.equal(result.json, null, "nothing was decided, so no JSON");
  assert.match(result.stderr, /vitest is not installed/);
});

test("AC50: the locked tests are read from the report by the file's own name, from a Windows or a POSIX path, and a report of another file does not stand in for it", () => {
  const locked = policyOf(WORKFLOW).lockedTestBlocks;
  const report = reportOf();
  assert.deepEqual(evaluateLockedTests(report, locked), []);
  const windows = structuredClone(report);
  windows.testResults[0].name = "D:\\work\\downstream\\checks\\site.test.ts";
  assert.deepEqual(evaluateLockedTests(windows, locked), [], "a path with backslashes");
  const other = structuredClone(report);
  other.testResults[0].name = "/work/downstream/checks/not-the-file.test.ts";
  assert.equal(evaluateLockedTests(other, locked).length, locked[0].blocks.length, "every locked block is then absent");
  assert.equal(evaluateLockedTests(null, locked).length, locked[0].blocks.length);
  assert.equal(evaluateLockedTests({ testResults: "nope" }, locked).length, locked[0].blocks.length);
});

test("AC50: recorded Vitest output accepts a passed locked test even when the overall run failed", () => {
  const report = readJson(fixture("vitest-json", "real-output.json"));
  const locked = [{ file: "contract.test.ts", blocks: [{ kind: "it", title: "passes an executed invariant" }] }];
  assert.equal(report.success, false, "an unrelated failure does not decide the locked test");
  assert.deepEqual(evaluateLockedTests(report, locked), []);
});

test("AC50: recorded Vitest output rejects a skipped locked test with its file, title and status", () => {
  const report = readJson(fixture("vitest-json", "real-output.json"));
  const file = "contract.test.ts";
  const locked = [{ file, blocks: [{ kind: "it", title: "skips an invariant deliberately" }] }];
  assert.deepEqual(evaluateLockedTests(report, locked), [
    { file, message: 'it("skips an invariant deliberately") did not pass: its status is "skipped"' },
  ]);
});

test("AC50: recorded Vitest output rejects each non-passing child of a locked describe, including a failed child", () => {
  const report = readJson(fixture("vitest-json", "real-output.json"));
  const file = "contract.test.ts";
  const locked = [{ file, blocks: [{ kind: "describe", title: "contract probe safety group" }] }];
  assert.deepEqual(evaluateLockedTests(report, locked), [
    { file, message: 'describe("contract probe safety group") > skips an invariant deliberately did not pass: its status is "skipped"' },
    { file, message: 'describe("contract probe safety group") > fails an invariant deliberately did not pass: its status is "failed"' },
  ]);
});

test("AC50: recorded-shape fixtures accept passed blocks and identify the one failed or missing locked block", () => {
  const file = "tests/pipelines.test.ts";
  const locked = [{ file, blocks: [{ kind: "describe", title: "pipelines animated SVG" }, { kind: "describe", title: "pipelines sanitization" }] }];
  assert.deepEqual(evaluateLockedTests(readJson(fixture("vitest-json", "describe-passed.json")), locked), []);
  assert.deepEqual(evaluateLockedTests(readJson(fixture("vitest-json", "describe-child-failed.json")), locked), [
    { file, message: 'describe("pipelines animated SVG") > is self-contained: no script, no event handlers, no external references did not pass: its status is "failed"' },
  ]);
  const missingFile = "tests/course.test.ts";
  const missing = [{
    file: missingFile,
    blocks: [
      { kind: "it", title: "accepts every page of the course without errors or warnings" },
      { kind: "it", title: "keeps every summary short" },
    ],
  }];
  assert.deepEqual(evaluateLockedTests(readJson(fixture("vitest-json", "missing.json")), missing), [
    { file: missingFile, message: 'it("keeps every summary short") did not appear in the Vitest report' },
  ]);
});

test("AC48: deepFreeze freezes an object, an array, a function and what they hold, and the prototype of a class, but never the prototype of a built-in", () => {
  class Rule {
    check() {
      return true;
    }
  }
  const nested = { list: [1, { inner: "x" }], fn: Object.assign(() => 1, { property: { deep: true } }), when: new Rule(), map: new Map([["a", { b: 1 }]]) };
  deepFreeze(nested);
  for (const value of [nested, nested.list, nested.list[1], nested.fn, nested.fn.property, nested.when, Rule.prototype]) assert.ok(Object.isFrozen(value), String(value));
  assert.equal(Object.isFrozen(Map.prototype), false, "Map.prototype belongs to the runtime");
  assert.equal(Object.isFrozen(Object.prototype), false);
  assert.equal(Object.isFrozen(Array.prototype), false);
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  deepFreeze(cyclic);
  assert.ok(Object.isFrozen(cyclic));
  const accessor = { get value() { return { inside: 1 }; } };
  deepFreeze(accessor);
  assert.ok(Object.isFrozen(accessor));
  deepFreeze(null);
  deepFreeze(3);
  deepFreeze("text");
});

test("AC48: the inProcessInvariants of an edge are read strictly: a mapping, a list of module paths, references that name a module and an export, and constants that carry their value", () => {
  const preset = policyOf(WORKFLOW).inProcessInvariants;
  const read = readInvariants(preset);
  assert.deepEqual(read.frozenModules, preset.frozenModules);
  assert.deepEqual(read.course, { module: PAGES, export: "pages" });
  assert.deepEqual(read.check, { module: RULES, export: "verifyPages" });
  assert.deepEqual(read.constants.map((entry) => [entry.export, entry.value]), [["MAX_LINES", 12]]);
  assert.deepEqual(read.customerTerms, { module: TERMS, export: "scanText" });
  const optional = readInvariants({ frozenModules: [RULES, TERMS], customerTerms: preset.customerTerms });
  assert.equal(optional.course, null);
  assert.equal(optional.check, null);
  assert.deepEqual(optional.constants, []);
  for (const bad of [null, [], "x", { frozenModules: "x" }, { frozenModules: [1] }, { constants: {} }, { constants: [{ module: "a", export: "b" }] }, { course: { module: "a" } }, { check: { export: "b" } }]) {
    assert.throws(() => readInvariants(bad), /immutableGates\.inProcessInvariants/, JSON.stringify(bad));
  }
});
