// Unit tests of the generic adaptation libraries: allowed-files matching, scanning, test structure, and manifest policy.
// analysis of test files, and the manifest policy reader. The command-level behaviour is in the tests of each helper; these pin the building blocks, with the S1 suite's own glob matcher as an
// independent oracle.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { allowedBy, allowedPattern, covers, resolveRelative, stripExtension } from "../../src/adaptation/paths.mjs";
import { ManifestError, aiEdges, gatePolicyFor, helperSection, locateManifest, relativePath, resolvePointer, workflowIdOf } from "../../src/adaptation/manifest.mjs";
import { decodeString, inComment, matchingBracket, scan } from "../../src/adaptation/ts-scan.mjs";
import { analyzeTestFile, blockTexts, compareStructure, countConstructs, parseImports, suiteCalls } from "../../src/adaptation/ts-structure.mjs";
import { globMatches } from "../s1/helpers/fixtures.mjs";
import { tempDir, writeFiles } from "./helpers/fixtures.mjs";
import { gateManifest } from "./helpers/gate-fleet.mjs";
import { manifest as presetManifest } from "./helpers/workflows.mjs";

// ---- paths ---------------------------------------------------------------------------------------------------------------------------------------------------

test("allowedPattern: * stops at a slash, ** crosses it, every other character is literal, and the match is anchored; it agrees with the S1 oracle on the patterns of the preset", () => {
  const patterns = [
    ...new Set(presetManifest().dependencyEdges.filter((edge) => edge.mode === "ai-adaptation").flatMap((edge) => edge.allowedFiles)),
    "a/*.ts", "a/**", "a/b*.ts", "*.md", "docs/*/index.md", "x/**/y.ts",
  ];
  const paths = [
    "README.md", "public/pages/index.html", "public/pages/a/b/c.js", "public/pagesx/index.html", "content/pages/p3.ts", "content/pages/p10.ts",
    "content/pages/p.ts", "content/pages/sub/p3.ts", "content/pages/p3.tsx", "content/rules.ts",
    "apps/site/client/src/views/view05.tsx", "apps/site/client/src/views/view05.ts", "apps/site/client/src/views/sub/view05.tsx", "a/x.ts", "a/b/x.ts", "a/b1.ts", "a/bx.ts", "a/b.tsx",
    "docs/guide/index.md", "docs/index.md", "x/y.ts", "x/z/y.ts", "x/z/w/y.ts", "src/server.ts", "tests/pipelines.test.ts",
  ];
  for (const pattern of patterns) {
    for (const file of paths) {
      if (/\*\*\//.test(pattern)) continue; // the oracle makes the directory of a `**/` optional; gh-aw's text form (and this module) requires the slash
      assert.equal(allowedPattern(pattern).test(file), globMatches(pattern, file), `${pattern} against ${file}`);
    }
  }
  assert.equal(allowedPattern("a/b.ts").test("a/bxts"), false, "a dot is a dot");
  assert.equal(allowedPattern("a/(b).ts").test("a/(b).ts"), true, "parentheses are literal");
  assert.equal(allowedPattern("a/b?.ts").test("a/bx.ts"), false, "a question mark is literal in gh-aw's text form");
  assert.equal(allowedPattern("A/b.ts").test("a/b.ts"), false, "case-sensitive");
  assert.equal(allowedBy(["x/*.ts", "y/**"], "y/z/w.ts"), true);
  assert.equal(allowedBy([], "y"), false);
});

test("covers: a file entry covers itself, a directory entry everything beneath it and not a sibling with the same prefix, and a wildcard entry the paths it matches and what is beneath them", () => {
  assert.equal(covers("tests/auth.test.ts", "tests/auth.test.ts"), true);
  assert.equal(covers("tests/auth.test.ts", "tests/auth.test.tsx"), false);
  assert.equal(covers("src", "src/server.ts"), true);
  assert.equal(covers("src", "src/a/b.ts"), true);
  assert.equal(covers("src", "srcx/server.ts"), false);
  assert.equal(covers("src", "src"), true);
  assert.equal(covers("src/", "src/a.ts"), true, "a trailing slash is the same directory");
  assert.equal(covers("./src", "src/a.ts"), true);
  assert.equal(covers("src\\a", "src/a/b.ts"), true, "a backslash entry");
  assert.equal(covers("scripts/*.mjs", "scripts/build.mjs"), true);
  assert.equal(covers("scripts/*.mjs", "scripts/sub/build.mjs"), false);
  assert.equal(covers("scripts/b*", "scripts/build/x.mjs"), true, "beneath a matched directory");
});

test("resolveRelative and stripExtension: a relative specifier resolves against the importer without its extension, and anything else is null", () => {
  assert.equal(resolveRelative("a/b/c.ts", "./d"), "a/b/d");
  assert.equal(resolveRelative("a/b/c.ts", "../d"), "a/d");
  assert.equal(resolveRelative("a/b/c.ts", "../../d.js"), "d");
  assert.equal(resolveRelative("a/b/c.ts", "../../../d"), null, "above the root");
  assert.equal(resolveRelative("a/b/c.ts", "vitest"), null);
  assert.equal(resolveRelative("a/b/c.ts", "@scope/pkg"), null);
  assert.equal(resolveRelative("a/b/c.ts", "."), "a/b");
  assert.equal(resolveRelative("a/b/c.ts", "./sub/index"), "a/b/sub");
  assert.equal(stripExtension("a/b/index.ts"), "a/b");
  assert.equal(stripExtension("a/b/m1.tsx"), "a/b/m1");
  assert.equal(stripExtension("a/b/m1.test.ts"), "a/b/m1.test");
  assert.equal(stripExtension("a/b/data.json"), "a/b/data.json");
});

// ---- the scanner ---------------------------------------------------------------------------------------------------------------------------------------------

test("scan: comments, strings, templates with substitutions and regular expressions are told apart, and a // inside a string or a regex is not a comment", () => {
  const source = "const url = 'https://x.example/a'; // line\n/* block */ const t = `a${1 + 2}b`; const r = /ab+\\/c/g; const d = 4 / 2;\n";
  const { tokens, comments } = scan(source);
  assert.deepEqual(comments.map((comment) => comment.type), ["line", "block"]);
  const string = tokens.find((token) => token.type === "string");
  assert.equal(string.text, "https://x.example/a");
  assert.ok(tokens.some((token) => token.type === "regex" && token.value === "/ab+\\/c/g"), "a regex literal, with its escaped slash and its flags");
  assert.ok(tokens.some((token) => token.type === "template"), "a template literal");
  const inner = tokens.filter((token) => token.templateDepth > 0).map((token) => token.value);
  assert.deepEqual(inner, ["1", "+", "2"], "the code inside a substitution is scanned as code");
  assert.equal(tokens.filter((token) => token.type === "punct" && token.value === "/").length, 1, "one division");
  assert.equal(inComment(comments, source.indexOf("line")), true);
  assert.equal(inComment(comments, source.indexOf("const url")), false);
  assert.equal(inComment(comments, source.indexOf("https")), false, "the // of a URL is inside a string");
});

test("scan: a damaged source never throws or loops: an unterminated string, template, block comment and a stray character", () => {
  for (const source of ["const a = 'oops\nconst b = 1;", "const a = `never closed", "/* never closed", "const a = #;", "}}}{{{", "\u0000\u0001", "const s = 'a\\", "x = /unterminated"]) {
    const result = scan(source);
    assert.ok(Array.isArray(result.tokens), JSON.stringify(source));
  }
  const { tokens } = scan("const a = 'oops\nconst b = 1;");
  assert.ok(tokens.some((token) => token.value === "b"), "scanning goes on after the broken line");
});

test("decodeString decodes the escapes of a string body, and matchingBracket finds the partner of a bracket through nesting and strings", () => {
  assert.equal(decodeString("a\\nb\\t\\x41\\u0042\\u{1F600}\\'\\\\"), "a\nb\tAB\u{1F600}'\\");
  assert.equal(decodeString("trail\\"), "trail");
  const { tokens } = scan("f(a, [b, (c)], 'x)') + g(");
  assert.equal(tokens[matchingBracket(tokens, 1)].value, ")");
  assert.equal(tokens[matchingBracket(tokens, 1)].start, 19, "the bracket inside the string is not a bracket");
  const unbalanced = scan("g(1, 2");
  assert.equal(matchingBracket(unbalanced.tokens, 1), -1);
});

// ---- test files and constructs -------------------------------------------------------------------------------------------------------------------------------

const SAMPLE = `import { describe, expect, it } from "vitest";
import { findBannedTerms } from "./support/banned-terms";

const root = process.cwd();

describe("the course", () => {
  it("accepts every page of the course without errors or warnings", () => {
    expect(1).toBe(1);
  });

  it("can't be shortened: it's a double-quoted title", () => {
    expect(2).toBe(2);
  });

  it('single quoted', () => {
    expect(3).toBe(3);
  });

  it(\`a template title\`, () => {});

  it.skipIf(!process.env.X)("conditional", () => {});
  // it("in a comment", () => {});
  const text = 'it("in a string", () => {})';
});
`;

test("suiteCalls and blockTexts find single-quoted, double-quoted (even with an apostrophe) and template titles, mark a chained call as chained, and ignore comments and strings", () => {
  const calls = suiteCalls(scan(SAMPLE));
  assert.deepEqual(
    calls.map((call) => [call.name, call.form, call.title]),
    [
      ["describe", "plain", "the course"],
      ["it", "plain", "accepts every page of the course without errors or warnings"],
      ["it", "plain", "can't be shortened: it's a double-quoted title"],
      ["it", "plain", "single quoted"],
      ["it", "plain", "a template title"],
      ["it", "chained", null],
    ],
  );
  const analysis = analyzeTestFile(SAMPLE);
  assert.deepEqual(blockTexts(analysis, "it", "can't be shortened: it's a double-quoted title"), [`it("can't be shortened: it's a double-quoted title", () => {\n    expect(2).toBe(2);\n  });`]);
  assert.deepEqual(blockTexts(analysis, "it", "single quoted").length, 1);
  assert.deepEqual(blockTexts(analysis, "it", "in a comment"), []);
  assert.deepEqual(blockTexts(analysis, "it", "in a string"), []);
  assert.equal(analysis.prelude.endsWith("const root = process.cwd();\n\n"), true, "the prelude ends before the line of the first describe(");
  assert.deepEqual(analysis.describeHeaders, ['describe("the course", () => {']);
});

test("compareStructure: an identical file has no problem; each kind of change has its own message, once", () => {
  const blocks = [{ kind: "it", title: "accepts every page of the course without errors or warnings" }, { kind: "describe", title: "the course" }];
  const check = (head, extra = {}) => compareStructure({ baseText: SAMPLE, headText: head, blocks, ...extra });
  assert.deepEqual(check(SAMPLE), []);
  assert.deepEqual(check(SAMPLE.replace("expect(1).toBe(1);", "expect(1).toBe(2);")), [
    'it("accepts every page of the course without errors or warnings") differs from the base',
    'describe("the course") differs from the base',
  ], "a changed body is a problem for the block and for the describe( group that holds it");
  assert.deepEqual(check(SAMPLE.replace("const root = process.cwd();", "const root = '.';")), ["the imports and the lines before the first describe( differ from the base"]);
  assert.deepEqual(
    check(SAMPLE.replace('describe("the course", () => {', 'describe("the courses", () => {')).filter((problem) => problem.includes("header")),
    ["the describe( header lines differ from the base"],
  );
  assert.deepEqual(check(SAMPLE, { lockedImports: ["findBannedTerms"] }), []);
  const swapped = SAMPLE.replace('import { findBannedTerms } from "./support/banned-terms";', 'import { findBannedTerms } from "./support/other";');
  assert.deepEqual(check(swapped, { lockedImports: ["findBannedTerms"] }), [
    "the imports and the lines before the first describe( differ from the base",
    "the import of findBannedTerms differs from the base",
  ]);
  assert.deepEqual(check(SAMPLE.replace('import { findBannedTerms } from "./support/banned-terms";\n', ""), { lockedImports: ["findBannedTerms"] }).slice(-1), ["the import of findBannedTerms is missing in the head"]);
  assert.deepEqual(compareStructure({ baseText: SAMPLE, headText: SAMPLE, blocks: [{ kind: "it", title: "nope" }] }), ['it("nope") is missing in the base', 'it("nope") is missing in the head']);
});

test("parseImports reads static, side-effect, namespace, default and re-exported imports, dynamic imports and requires of a string", () => {
  const imports = parseImports(scan(`import a, { b as c, type D } from "x";\nimport * as ns from './y';\nimport "./z";\nexport { e } from "./w";\nexport * from "./v";\nconst m = await import("./u");\nconst r = require("./t");\nimport.meta.url;\nconst n = obj.import("./not");\n`));
  assert.deepEqual(imports.map((entry) => [entry.kind, entry.specifier]), [["import", "x"], ["import", "./y"], ["import", "./z"], ["export", "./w"], ["export", "./v"], ["dynamic", "./u"], ["require", "./t"]].map(([kind, specifier]) => [kind === "export" ? imports.find((entry) => entry.specifier === specifier).kind : kind, specifier]));
  const first = imports.find((entry) => entry.specifier === "x");
  assert.deepEqual(first.bindings.map((binding) => [binding.local, binding.imported]).slice(0, 2), [["a", "default"], ["c", "b"]]);
});

test("countConstructs counts a banned construct in code and in nothing else: a comment, a string, a template and a method that merely has the name are not it", () => {
  const options = { filePath: "x/content/m1.ts", lockedModules: ["x/content/rules.ts"] };
  const clean = `// it.skip("x"); vi.mock("y"); Object.assign(a, b)\nconst s = "it.skip and Object.defineProperty and Reflect.get";\nconst t = \`vi.mock \${1}\`;\nit.skipIf(true)("c", () => {});\nconst o = { assign() {} };\no.assign();\nconsole.log(Reflect);`;
  const counts = countConstructs(clean, options);
  assert.equal(counts[".skip"], 0);
  assert.equal(counts["vi.mock"], 0);
  assert.equal(counts["Object.assign"], 0);
  assert.equal(counts["Object.defineProperty"], 0);
  assert.equal(counts[".only"] + counts[".todo"], 0);
  const dirty = "it.skip('a'); describe.only('b'); it.todo('c'); vi.mock('d'); Object.assign(a, b); Object.defineProperty(a, 'x', {}); Reflect.set(a, 'x', 1);";
  const found = countConstructs(dirty, options);
  assert.deepEqual([found[".skip"], found[".only"], found[".todo"], found["vi.mock"], found["Object.assign"], found["Object.defineProperty"], found.Reflect], [1, 1, 1, 1, 1, 1, 1]);
});

test("countConstructs: a mutation, a new import and a shadowing of what a locked module exports are found by the token that roots them, never by a similar name", () => {
  const options = { filePath: "x/content/m1.ts", lockedModules: ["x/content/rules.ts"] };
  const code = (body) => `import { LIMITS, wordCount } from "./rules";\nimport { other } from "./elsewhere";\n${body}\n`;
  const count = (body, name) => countConstructs(code(body), options)[name];
  for (const body of ["LIMITS.max = 1;", "LIMITS.max += 1;", "LIMITS.max++;", "--LIMITS.max;", "delete LIMITS.max;", "LIMITS['max'] = 1;", "LIMITS.nested.deep = 1;"]) assert.ok(count(body, "property mutation") >= 1, body);
  for (const body of ["other.max = 1;", "const copy = { ...LIMITS }; copy.max = 1;", "wordCount(LIMITS.max);", "const x = LIMITS.max === 1;", "LIMITS.items.push(1);"]) assert.equal(count(body, "property mutation"), 0, body);
  assert.ok(countConstructs(`import { LIMITS } from "./rules";\nimport * as more from "./rules";\n`, options)["new import of a locked module"] >= 2, "each import of the locked module");
  assert.equal(countConstructs(`import { other } from "./elsewhere";\n`, options)["new import of a locked module"], 0);
  for (const body of ["const LIMITS = {};", "function wordCount() {}", "[1].map((LIMITS) => LIMITS);", "let { wordCount } = obj;"]) assert.ok(count(body, "shadowing of an imported identifier") >= 1, body);
  assert.equal(count("const other2 = 1;", "shadowing of an imported identifier"), 0);
});

// ---- the manifest policy -------------------------------------------------------------------------------------------------------------------------------------

test("gatePolicyFor reads the policy of the edge that owns the workflow id, lists the sibling test files, and refuses data that it cannot use", () => {
  const document = structuredClone({ dependencyEdges: presetManifest().dependencyEdges });
  const edges = document.dependencyEdges.filter((edge) => edge.mode === "ai-adaptation");
  const first = edges[0];
  assert.equal(gatePolicyFor(document, "cascade-ai-nothing"), null);
  assert.equal(gatePolicyFor(document, workflowIdOf(document.dependencyEdges.find((edge) => edge.mode === "mechanical"))), null, "a mechanical edge has no AI gate policy");
  const policy = gatePolicyFor(document, workflowIdOf(first));
  assert.deepEqual(policy.zeroDiffPaths, first.immutableGates.zeroDiffPaths);
  assert.deepEqual(policy.generatedPaths, first.immutableGates.generatedPaths);
  assert.deepEqual(policy.lockedTestBlocks, first.immutableGates.lockedTestBlocks);
  const own = new Set(first.immutableGates.lockedTestBlocks.map((entry) => entry.file));
  const siblings = [...new Set(edges.filter((edge) => edge !== first && edge.downstreamRepo === first.downstreamRepo).flatMap((edge) => edge.immutableGates.lockedTestBlocks.map((entry) => entry.file)))].filter((file) => !own.has(file)).sort();
  assert.deepEqual(policy.siblingTestFiles, siblings);
  assert.deepEqual(aiEdges(document).map(workflowIdOf), edges.map((edge) => `cascade-ai-${edge.edgeId}`));
  const neutral = gateManifest();
  const neutralId = workflowIdOf(neutral.dependencyEdges[0]);
  const neutralPolicy = gatePolicyFor(neutral, neutralId);
  assert.deepEqual(neutralPolicy.zeroDiffPaths, ["kernel", "ops/deploy.sh"]);
  assert.deepEqual(neutralPolicy.generatedPaths, [], "generated paths default to none, not a hard-coded directory");
  assert.deepEqual(neutralPolicy.lockedTestBlocks.map((entry) => entry.file), ["checks/site.test.ts"]);
  assert.deepEqual(neutralPolicy.siblingTestFiles, []);
  const broken = (change) => {
    const copy = structuredClone(neutral);
    change(copy.dependencyEdges[0]);
    return () => gatePolicyFor(copy, neutralId);
  };
  assert.throws(broken((edge) => delete edge.immutableGates), ManifestError);
  assert.throws(broken((edge) => (edge.immutableGates.zeroDiffPaths = ["ok", 3])), /zeroDiffPaths must be a list of non-empty strings/);
  assert.throws(broken((edge) => (edge.immutableGates.generatedPaths = ["web/**", 3])), /generatedPaths must be a list of non-empty strings/);
  assert.throws(broken((edge) => (edge.immutableGates.lockedTestBlocks = {})), /lockedTestBlocks must be a list/);
  assert.throws(broken((edge) => (edge.immutableGates.lockedTestBlocks = [{ file: "a.ts" }])), /needs a file and a list of blocks/);
  assert.throws(broken((edge) => (edge.immutableGates.lockedTestBlocks = [{ file: "a.ts", blocks: [{ kind: "test", title: "x" }] }])), /kind \(it or describe\)/);
  assert.throws(broken((edge) => (edge.immutableGates.lockedTestBlocks = [{ file: "a.ts", blocks: [{ kind: "it", title: "" }] }])), /title/);
  assert.throws(broken((edge) => (edge.immutableGates.inProcessInvariants = [])), /inProcessInvariants must be a mapping/);
});

test("helperSection returns the data that the AI edges declare under adaptation.helpers, null when none does, and refuses edges that disagree; relativePath and resolvePointer are strict", () => {
  assert.deepEqual(helperSection(gateManifest(), "sourceCheck"), { manifest: "apps/sources.json" });
  assert.deepEqual(helperSection(presetManifest(), "sourceCheck"), { manifest: "apps/site/sources.json" });
  const edges = () => [
    { edgeId: "a", mode: "ai-adaptation", adaptation: { preflightReports: ["a.txt"], helpers: { sources: { manifest: "app/sources.json" } } } },
    { edgeId: "b", mode: "ai-adaptation", adaptation: { preflightReports: ["b.txt"] } },
  ];
  const document = { dependencyEdges: edges() };
  assert.deepEqual(helperSection(document, "sources"), { manifest: "app/sources.json" });
  assert.equal(helperSection(document, "nothingLikeThis"), null);
  document.dependencyEdges[1].adaptation.helpers = { sources: { manifest: "app/sources.json" } };
  assert.deepEqual(helperSection(document, "sources"), { manifest: "app/sources.json" }, "edges that agree are one answer");
  document.dependencyEdges[1].adaptation.helpers = { sources: { manifest: "other/sources.json" } };
  assert.throws(() => helperSection(document, "sources"), /declare different adaptation\.helpers\.sources data/, "edges that disagree: the helper is not told which one applies");
  assert.equal(helperSection(document, "preflightReports"), null, "the engine's own section, which differs per edge, is no helper");
  assert.equal(relativePath("a/b.json", "x"), "a/b.json");
  assert.equal(relativePath("a\\b.json", "x"), "a/b.json");
  for (const bad of ["", "/abs", "\\abs", "C:\\x", "../up", "a/../b", "a/\u0001b", 3, null]) assert.throws(() => relativePath(bad, "x"), /must be a path inside the repository/, JSON.stringify(bad));
  const doc = { a: { "b/c": [{ d: 1 }, { d: 2 }], "~": 5 } };
  assert.equal(resolvePointer(doc, "/a/b~1c/1/d"), 2);
  assert.equal(resolvePointer(doc, "/a/~0"), 5);
  assert.equal(resolvePointer(doc, ""), doc);
  assert.equal(resolvePointer(doc, "a"), undefined);
  assert.equal(resolvePointer(doc, "/a/b~1c/2"), undefined);
  assert.equal(resolvePointer(doc, "/a/b~1c/01/d"), undefined, "no leading zero in an index");
});

test("locateManifest takes the current directory first, then GITHUB_WORKSPACE, and never a manifest inside the checkout that is being inspected", () => {
  const root = tempDir("sdlc-s4-manifest-");
  const cwd = path.join(root, "cwd");
  const workspace = path.join(root, "workspace");
  const checkout = path.join(workspace, "downstream");
  for (const dir of [cwd, workspace, checkout]) fs.mkdirSync(dir, { recursive: true });
  assert.equal(locateManifest({ cwd, env: {} }), null);
  writeFiles(workspace, { "sdlc.yaml": "a: 1\n" });
  assert.equal(locateManifest({ cwd, env: { GITHUB_WORKSPACE: workspace } }), path.join(workspace, "sdlc.yaml"));
  writeFiles(cwd, { "sdlc.yaml": "b: 2\n" });
  assert.equal(locateManifest({ cwd, env: { GITHUB_WORKSPACE: workspace } }), path.join(cwd, "sdlc.yaml"), "the current directory wins");
  writeFiles(checkout, { "sdlc.yaml": "c: 3\n" });
  assert.equal(locateManifest({ cwd: checkout, env: { GITHUB_WORKSPACE: workspace }, avoid: [checkout] }), path.join(workspace, "sdlc.yaml"), "a manifest that the downstream checkout holds is never the policy");
  assert.equal(locateManifest({ cwd: checkout, env: {}, avoid: [checkout] }), null);
});
