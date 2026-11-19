// AC43-AC47: check (iii) of src/verify-immutable-gates.mjs. The prelude, the describe( headers and the named blocks of the companion test files are byte for byte
// what they were at the base (single- and double-quoted titles alike), and the companion test files and the editable modules add none of the banned constructs.
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTestFile, blockTexts, compareStructure, countConstructs } from "../../src/adaptation/ts-structure.mjs";
import { git } from "./helpers/fixtures.mjs";
import { gateManifest } from "./helpers/gate-fleet.mjs";
import { read, replaceOnce, scenario, shown } from "./helpers/gates.mjs";

const WORKFLOW = "cascade-ai-gadget-lessons";
const SITE_TEST = "checks/site.test.ts";
const EXTRA_TEST = "checks/extra.test.ts";
const PAGES = "web/pages.ts";

const edit = (relative, from, to) => (dir) => ({ [relative]: replaceOnce(read(dir, relative), from, to) });
const violation = (result, file, pattern) => {
  assert.equal(result.code, 1, shown(result));
  assert.equal(result.json.status, "violation");
  assert.ok(result.json.violatingFiles.includes(file), `${file} in ${JSON.stringify(result.json.violatingFiles)}`);
  if (pattern) assert.match(result.stderr, pattern);
};

const FIRST_BODY = "expect(MAX_LINES).toBe(12);";
const EDITABLE_BODY = "expect(1).toBe(1);";

test("AC43/AC44: every locked body is immutable, including an apostrophe in a double-quoted title; other tests remain editable", () => {
  const manifest = gateManifest();
  manifest.dependencyEdges[0].immutableGates.lockedTestBlocks[0].blocks.push({ kind: "it", title: "can't relax the limits" });
  const prepare = (dir) => ({
    [SITE_TEST]: `${read(dir, SITE_TEST)}\nit("can't relax the limits", () => {\n  expect(MAX_LINES > 0).toBe(true);\n});\n`,
  });
  const bodies = [
    [FIRST_BODY, "expect(MAX_LINES).toBeGreaterThan(0);"],
    ["expect(MAX_LINES > 0).toBe(true);", "expect(MAX_LINES > 0).toBeTruthy();"],
  ];
  for (const [from, to] of bodies) violation(scenario({ manifest, prepare, mutate: edit(SITE_TEST, from, to) }).run(), SITE_TEST, /differs from the base/);
  const editable = scenario({ mutate: edit(SITE_TEST, EDITABLE_BODY, "expect(1).toEqual(1);") }).run();
  assert.equal(editable.code, 0, `the other tests of the file stay editable: ${shown(editable)}`);
});

test("AC43: a named block that is missing in the head, and one that is missing in the base, both exit 1", () => {
  const dropped = scenario({
    mutate: (dir) => {
      const text = read(dir, SITE_TEST);
      const start = text.indexOf("  it('keeps the kernel limits'");
      const end = text.indexOf("  });\n", start) + "  });\n".length;
      return { [SITE_TEST]: text.slice(0, start) + text.slice(end) };
    },
  }).run();
  violation(dropped, SITE_TEST, /keeps the kernel limits.*missing in the head/);
  const renamedInBase = scenario({ prepare: edit(SITE_TEST, "'keeps the kernel limits'", "'keeps different limits'") }).run();
  violation(renamedInBase, SITE_TEST, /keeps the kernel limits.*missing in the base/);
  const renamedInHead = scenario({ mutate: edit(SITE_TEST, "'keeps the kernel limits'", "'keeps the kernel limits!'") }).run();
  violation(renamedInHead, SITE_TEST, /missing in the head/);
});

test("AC43: an edited prelude line, a new import before the first describe(, an edited describe( header and an added describe all exit 1", () => {
  violation(scenario({ mutate: edit(SITE_TEST, "import { MAX_LINES }", "import { MAX_LINES as limit }") }).run(), SITE_TEST, /before the first describe\(/);
  violation(scenario({ mutate: edit(SITE_TEST, "import { MAX_LINES }", 'import os from "node:os";\nimport { MAX_LINES }') }).run(), SITE_TEST, /before the first describe\(/);
  violation(scenario({ mutate: edit(SITE_TEST, "describe('site extras', () => {", "describe('additional site checks', () => {") }).run(), SITE_TEST, /describe\( header lines differ/);
  violation(scenario({ mutate: (dir) => ({ [SITE_TEST]: `${read(dir, SITE_TEST)}\ndescribe("an extra group", () => {\n  it("is new", () => {\n    expect(1).toBe(1);\n  });\n});\n` }) }).run(), SITE_TEST, /describe\( header lines differ/);
});

test("AC43: a work tree that git has converted to CRLF (core.autocrlf) holds the content of the LF blob and is no violation; a change on top of it is found, and a CRLF blob that is committed is not the base", () => {
  const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
  // the checkout filter of a Windows machine: the blob stays LF, the work tree copy has CRLF, and git itself reports no change
  const checkedOut = scenario({ commit: false, mutate: (dir) => ({ [SITE_TEST]: crlf(read(dir, SITE_TEST)) }) });
  git(checkedOut.dir, ["config", "core.autocrlf", "true"]);
  assert.equal(git(checkedOut.dir, ["diff", "--name-only", "HEAD"]).stdout.trim(), "", "git sees no change in the converted checkout");
  const clean = checkedOut.run();
  assert.equal(clean.code, 0, shown(clean));
  assert.deepEqual(clean.json, { status: "ok", violatingFiles: [] });
  // an edit of a locked body in such a checkout is still a difference from the base
  const edited = scenario({
    commit: false,
    mutate: (dir) => ({ [SITE_TEST]: crlf(replaceOnce(read(dir, SITE_TEST), FIRST_BODY, "expect(MAX_LINES).toBeGreaterThan(0);")) }),
  });
  git(edited.dir, ["config", "core.autocrlf", "true"]);
  violation(edited.run(), SITE_TEST, /keeps the kernel limits.*differs from the base \(in the work tree\)/);
  // what is committed is compared as it is: a blob that holds CRLF is not the LF blob of the base
  violation(scenario({ mutate: (dir) => ({ [SITE_TEST]: crlf(read(dir, SITE_TEST)) }) }).run(), SITE_TEST, /before the first describe\(/);
});

test("AC43/AC46: single-quoted locked titles are read in both companion files and every locked body is protected while other bodies stay editable", () => {
  const manifest = gateManifest();
  manifest.dependencyEdges[0].immutableGates.lockedTestBlocks.push({
    file: EXTRA_TEST,
    blocks: [{ kind: "it", title: "keeps the kernel limits" }],
  });
  const prepare = (dir) => ({ [EXTRA_TEST]: read(dir, SITE_TEST) });
  assert.equal(scenario({ workflow: WORKFLOW, manifest, prepare }).run().code, 0, "both companion files are found");
  for (const file of [SITE_TEST, EXTRA_TEST]) {
    violation(scenario({ manifest, prepare, mutate: edit(file, FIRST_BODY, "expect(MAX_LINES).toBeTruthy();") }).run(), file);
  }
  const free = scenario({ manifest, prepare, mutate: edit(EXTRA_TEST, EDITABLE_BODY, "expect(1).toEqual(1);") }).run();
  assert.equal(free.code, 0, shown(free));
});

test("AC45: every locked describe body and a named locked import are immutable; the unlocked describe stays editable", () => {
  const manifest = gateManifest();
  const locked = manifest.dependencyEdges[0].immutableGates.lockedTestBlocks[0];
  locked.lockedImports = ["MAX_LINES"];
  locked.blocks.push({ kind: "describe", title: "site text checks" });
  const prepare = (dir) => ({
    [SITE_TEST]: `${read(dir, SITE_TEST)}\ndescribe("site text checks", () => {\n  it("uses safe text", () => {\n    expect("calm").toBe("calm");\n  });\n});\n`,
  });
  violation(scenario({ manifest, prepare, mutate: edit(SITE_TEST, FIRST_BODY, "expect(MAX_LINES).toBeTruthy();") }).run(), SITE_TEST, /site guard rails/);
  violation(scenario({ manifest, prepare, mutate: edit(SITE_TEST, 'expect("calm").toBe("calm");', 'expect("calm").toBeTruthy();') }).run(), SITE_TEST, /site text checks/);
  const noImport = scenario({ manifest, prepare, mutate: edit(SITE_TEST, "import { MAX_LINES }", "import { MAX_LINES as limit }") }).run();
  violation(noImport, SITE_TEST, /import of MAX_LINES|before the first describe\(/);
  const free = scenario({ manifest, prepare, mutate: edit(SITE_TEST, EDITABLE_BODY, "expect(1).toEqual(1);") }).run();
  assert.equal(free.code, 0, shown(free));
});

test("AC43: the structure compare reports every difference once and none for an identical file (unit view of what the command decides)", () => {
  const base = `import { describe, it } from "vitest";\nconst a = 1;\ndescribe("g", () => {\n  it("x", () => {\n    run();\n  });\n});\n`;
  const blocks = [{ kind: "it", title: "x" }];
  assert.deepEqual(compareStructure({ baseText: base, headText: base, blocks }), []);
  assert.equal(compareStructure({ baseText: base, headText: base.replace("run();", "run(1);"), blocks }).length, 1);
  assert.equal(compareStructure({ baseText: base, headText: base.replace("const a = 1;", "const a = 2;"), blocks }).length, 1);
  assert.equal(compareStructure({ baseText: base, headText: base.replace('describe("g"', 'describe("h"'), blocks }).length, 1);
  assert.deepEqual(compareStructure({ baseText: base, headText: base.replace("const a = 1;", "const a = 1; // moved"), blocks }).length, 1, "a comment before the first describe is part of the prelude");
  const analysis = analyzeTestFile(`describe("g", () => {\n  it('it\\'s "quoted"', () => {});\n  it(\`template title\`, () => {});\n  // it("in a comment", () => {});\n  const s = 'it("in a string", () => {})';\n});\n`);
  assert.equal(blockTexts(analysis, "it", `it's "quoted"`).length, 1, "escapes in a single-quoted title are decoded");
  assert.equal(blockTexts(analysis, "it", "template title").length, 1);
  assert.equal(blockTexts(analysis, "it", "in a comment").length + blockTexts(analysis, "it", "in a string").length, 0, "comments and strings hold no block");
});

const CONSTRUCTS = [
  ["it.skip", SITE_TEST, edit(SITE_TEST, "it('may be edited'", "it.skip('may be edited'"), /adds \.skip/],
  ["it.only", SITE_TEST, edit(SITE_TEST, "it('may be edited'", "it.only('may be edited'"), /adds \.only/],
  ["it.todo", SITE_TEST, (dir) => ({ [SITE_TEST]: `${read(dir, SITE_TEST)}\nit.todo("later");\n` }), /adds \.todo/],
  ["vi.mock", SITE_TEST, (dir) => ({ [SITE_TEST]: `${read(dir, SITE_TEST)}\nvi.mock("../kernel/limits");\n` }), /adds vi\.mock/],
  ["Object.assign", PAGES, (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const copy = Object.assign({}, pages);\n` }), /adds Object\.assign/],
  ["Object.defineProperty", PAGES, (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nObject.defineProperty(pages, "tag", { value: "x" });\n` }), /adds Object\.defineProperty/],
  ["Reflect.*", PAGES, (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const keys = Reflect.ownKeys(pages);\n` }), /adds Reflect/],
  ["property mutation", SITE_TEST, edit(SITE_TEST, EDITABLE_BODY, `FORBIDDEN.words[0] = "changed";\n    ${EDITABLE_BODY}`), /adds property mutation/, edit(SITE_TEST, "import { MAX_LINES }", "import { MAX_LINES, FORBIDDEN }")],
  ["a new import of the rules module", PAGES, (dir) => ({ [PAGES]: `import { FORBIDDEN } from '../kernel/limits';\n${read(dir, PAGES)}` }), /adds new import of a locked module/],
  ["shadowing of an imported identifier", SITE_TEST, edit(SITE_TEST, EDITABLE_BODY, "const MAX_LINES = 1;\n    expect(MAX_LINES).toBe(1);"), /adds shadowing/],
];
for (const [name, file, mutate, pattern, prepare] of CONSTRUCTS) {
  test(`AC47: adding one occurrence of ${name} exits 1 and names the file`, () => {
    violation(scenario({ prepare, mutate }).run(), file, pattern);
  });
}

test("AC47: the identifiers of the sanitiser are protected the same way: a new import of it into an editable module, a mutation of it and a binding of its name all exit 1", () => {
  violation(scenario({ mutate: (dir) => ({ [PAGES]: `import { scanText } from '../checks/terms';\n${read(dir, PAGES)}` }) }).run(), PAGES, /new import/);
  const prepare = edit(SITE_TEST, "import { MAX_LINES }", "import { scanText } from './terms';\nimport { MAX_LINES }");
  violation(scenario({ prepare, mutate: edit(SITE_TEST, EDITABLE_BODY, `scanText.cache = [];\n    ${EDITABLE_BODY}`) }).run(), SITE_TEST, /property mutation/);
  violation(scenario({ prepare, mutate: edit(SITE_TEST, EDITABLE_BODY, `const scanText = () => [];\n    ${EDITABLE_BODY}`) }).run(), SITE_TEST, /shadowing/);
  violation(scenario({ prepare, mutate: edit(SITE_TEST, EDITABLE_BODY, "expect([1].map((scanText) => scanText)).toEqual([1]);") }).run(), SITE_TEST, /shadowing/);
});

test("AC47: moving the existing it.skipIf line is not a violation (it.skipIf is not .skip), and neither are comments, strings and a construct that the base already had", () => {
  const moved = scenario({
    prepare: edit(SITE_TEST, "describe('site extras', () => {", "describe('site extras', () => {\n  it.skipIf(!process.env.SOURCE_INPUT)('optional input', () => {\n    expect(true).toBe(true);\n  });"),
    mutate: (dir) => {
      const text = read(dir, SITE_TEST);
      const start = text.indexOf("  it.skipIf(!process.env.SOURCE_INPUT)");
      const end = text.indexOf("  });\n", start) + "  });\n".length;
      const call = text.slice(start, end);
      const without = text.slice(0, start) + text.slice(end);
      const closing = without.lastIndexOf("});\n");
      const next = without.slice(0, closing) + call + without.slice(closing);
      assert.notEqual(next, text, "the conditional test really moved");
      return { [SITE_TEST]: next };
    },
  }).run();
  assert.equal(moved.code, 0, shown(moved));
  const harmless = scenario({ mutate: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\n// Object.assign and it.skip and Reflect.get in a comment\nexport const note = "vi.mock Object.defineProperty .only";\n` }) }).run();
  assert.equal(harmless.code, 0, shown(harmless));
  const preexisting = scenario({
    prepare: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const copy = Object.assign({}, pages);\n` }),
    mutate: edit(PAGES, "export const pages = [p1];", "export const pages = [p1, p1];"),
  }).run();
  assert.equal(preexisting.code, 0, `a count that does not grow is not an added occurrence: ${shown(preexisting)}`);
  const more = scenario({
    prepare: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const copy = Object.assign({}, pages);\n` }),
    mutate: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const second = Object.assign({}, pages);\n` }),
  }).run();
  violation(more, PAGES, /adds Object\.assign \(1 at .*, 2 in HEAD\)/);
});

test("AC47: the counts are taken from tokens: an uncommitted edit that adds a construct in the work tree is caught as well", () => {
  const result = scenario({ mutate: (dir) => ({ [PAGES]: `${read(dir, PAGES)}\nexport const copy = Object.assign({}, pages);\n` }), commit: false }).run();
  violation(result, PAGES, /adds Object\.assign/);
  const counts = countConstructs("it.skip(1); a['only'](); vi.doMock('x'); Reflect.get(a, 'b'); Object['assign'](a);", { filePath: "x.ts", lockedModules: [] });
  assert.deepEqual([counts[".skip"], counts[".only"], counts["vi.mock"], counts.Reflect, counts["Object.assign"]], [1, 1, 1, 1, 1]);
});
