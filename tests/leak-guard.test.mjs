// Leak guard tests (design K.4, item 4): one test per generic rule (a synthetic positive and near misses), the digest variants,
// the scanner over synthetic trees and git histories, the allow list, the generator, and the property that no output line of a
// failing run contains the text it matched.
//
// Test vectors are assembled at run time with j(...) or are invented ("zz-..."), so this file is itself clean under the guard.
//
// The whole-tree scan of the real repository is enforced: a failing finding or a stale allow entry in a tracked file fails the suite.
// SDLC_LEAK_TREE=0 switches it off for a local experiment; nothing else does.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { digestHits, digestOfTerm, loadDenylist, parseDenylist, tokens } from "../tools/leak-guard/digest.mjs";
import { decodedVariants } from "../tools/leak-guard/decode.mjs";
import { buildDenylist, harvestManifest, harvestRequest, main as makeDigests, parseTerms, refusalFor } from "../tools/leak-guard/make-digests.mjs";
import { findRuleHits, HARD_RULE_IDS, RULES } from "../tools/leak-guard/rules.mjs";
import { createMasker, extractStrings, formatRun, loadAllow, main as scanMain, parseAllow, parseTagObject, scanHistory, scanTree } from "../tools/leak-guard/scan.mjs";

const ENFORCE_TREE_BY_DEFAULT = true;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = path.join(ROOT, "tools", "leak-guard", "scan.mjs");
const REAL_DENYLIST = path.join(ROOT, "tools", "leak-guard", "denylist.json");
const REAL_ALLOW = path.join(ROOT, "tools", "leak-guard", "allow.json");

const TERM = "zz-leak-term"; // invented
const BS = "\\";
const j = (...parts) => parts.join("");
const RUN_NUMBER = String(2 ** 40);
const show = (text) => JSON.stringify(text);

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

/** A test denylist built by the real generator from invented terms: { document, runtime, id(term) }. */
function makeDenylist(terms, options) {
  const entries = terms.map(([term, category = "other"], index) => ({ term, category, label: `test:${index + 1}` }));
  const { document } = buildDenylist(entries, options);
  return { document, runtime: parseDenylist(document), id: (term) => document.digests[digestOfTerm(term)].id };
}

function tempDir(t, label = "tree") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leak-guard-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function git(dir, args, identity = {}) {
  const name = identity.name ?? "Test Author";
  const email = identity.email ?? "author@example.com";
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "leak-guard-no-such-config"),
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

function commitAll(dir, message, identity) {
  git(dir, ["add", "-A"], identity);
  git(dir, ["commit", "-q", "-m", message], identity);
  return git(dir, ["rev-parse", "HEAD"], identity).trim();
}

function initRepo(t, label = "repo") {
  const dir = tempDir(t, label);
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

function cli(args, { env = {}, cwd = ROOT } = {}) {
  const run = spawnSync(process.execPath, [SCAN, ...args], { cwd, encoding: "utf8", env: { ...process.env, SDLC_LEAK_ALLOW_EMPTY: "", ...env } });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, output: `${run.stdout}${run.stderr}` };
}

const NO_ALLOW = [];
const key = (finding) => `${finding.path}:${finding.line}:${finding.rule}${finding.side ? `:${finding.side}` : ""}`;
const failing = (result) => result.findings.filter((finding) => finding.status === "fail");
const fires = (rule, text, options = {}) => findRuleHits(text, { path: "src/x.mjs", ...options }).some((hit) => hit.rule === rule);

function inMemoryIo() {
  const sink = { out: "", err: "" };
  return { sink, io: { stdout: { write: (text) => (sink.out += text) }, stderr: { write: (text) => (sink.err += text) } } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Digest: normalization, windows, format
// ---------------------------------------------------------------------------------------------------------------------

test("digest: an invented term matches its spellings and the qualified form, and not its near misses", () => {
  const { runtime, id } = makeDenylist([[TERM], ["zz-owner/zz-repo-name", "repo"]]);
  const ids = (text) => digestHits(text, runtime).map((hit) => hit.id);
  for (const spelling of [TERM, "zz_leak_term", "ZZLeakTerm", "zz.leak.term", "https://github.com/zz-leak-term/repo", "ZZ LEAK TERM", "ｚｚ－ｌｅａｋ－ｔｅｒｍ"]) {
    assert.deepEqual(ids(spelling), [id(TERM)], `spelling ${show(spelling)}`);
  }
  assert.deepEqual(ids("see zz-owner/zz-repo-name here"), [id("zz-owner/zz-repo-name")], "the qualified name is one window of five tokens");
  for (const nearMiss of ["zz-leak", "zz-owner alone", "zz-repo-name alone", "zz leak terminal", "leak term"]) {
    assert.deepEqual(ids(nearMiss), [], `near miss ${show(nearMiss)}`);
  }
});

test("digest: a digest is sha256(prefix + joined tokens), so a table of plain SHA-256 values of words is useless", () => {
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  assert.deepEqual(tokens("ZZ-Leak_Term"), ["zz", "leak", "term"]);
  assert.equal(digestOfTerm(TERM), sha("sdlc-leak-v1:zzleakterm"));
  assert.notEqual(digestOfTerm(TERM), sha("zzleakterm"));
});

test("digest: a window never exceeds maxWindow", () => {
  const nineTokens = "zz-a-b-c-d-e-f-g-h"; // nine tokens, joined "zzabcdefgh"
  const { document } = makeDenylist([[nineTokens]]);
  assert.equal(document.maxWindow, 9, "the generator raises maxWindow to fit the longest term");
  assert.equal(digestHits(nineTokens, parseDenylist(document)).length, 1);
  assert.equal(digestHits(nineTokens, parseDenylist({ ...document, maxWindow: 8 })).length, 0, "an eight-token window cannot reach a nine-token term");
});

test("digest: with a split position only a hit that crosses it is returned", () => {
  const { runtime, id } = makeDenylist([[TERM]]);
  const joined = "zz-leakterm"; // a line break joined without a separator
  assert.deepEqual(digestHits(joined, runtime, { split: 7 }), [{ id: id(TERM), category: "other", start: 0, end: 11 }]);
  assert.deepEqual(digestHits(joined, runtime, { split: 11 }), [], "a hit that ends at the split does not cross it");
  assert.deepEqual(digestHits(joined, runtime, { split: 0 }), [], "nor one that starts at it");
  assert.deepEqual(digestHits(`${TERM} ${TERM}`, runtime, { split: 6 }).map((hit) => hit.start), [0], "only the first of two terms crosses a split inside it");
  assert.deepEqual(digestHits(`${TERM} ${TERM}`, runtime).map((hit) => hit.start), [0, 13], "without a split every hit is returned");
  // the glued forms cross a split too, except a glued term that keeps its separators (see the scanner: that search is not made across a break)
  assert.deepEqual(digestHits("xzzleakterm", runtime, { split: 7 }).map((hit) => [hit.start, hit.end]), [[1, 11]]);
  assert.deepEqual(digestHits("xzz-leakterm", runtime, { split: 8 }), []);
  assert.deepEqual(digestHits("xzz-leakterm", runtime).map((hit) => [hit.start, hit.end]), [[1, 12]], "though the same line, whole, holds it");
  assert.deepEqual(digestHits("zzLeakTermSync", runtime, { split: 5 }).map((hit) => [hit.start, hit.end]), [[0, 10]]);
  assert.deepEqual(digestHits("zzLeakTermSync", runtime, { split: 12 }), [], "a split inside the glue only is not a crossing");
});

test("digest: a digest hit is a position, an id and a category, and nothing else", () => {
  const { runtime, id } = makeDenylist([[TERM, "handle"]]);
  const line = `see ${TERM} here`;
  const [hit] = digestHits(line, runtime);
  assert.deepEqual(Object.keys(hit).sort(), ["category", "end", "id", "start"]);
  assert.deepEqual(hit, { id: id(TERM), category: "handle", start: 4, end: 16 });
});

// ---------------------------------------------------------------------------------------------------------------------
// Digest: the spellings that code really has (camelCase, digits, a term glued to other letters)
// ---------------------------------------------------------------------------------------------------------------------

const SOLO = "zzsoloterm"; // one token
const MULTI = "zz-multi-word-term"; // four tokens
const FIVE = "zz-five-token-long-term"; // five tokens: more than GLUE_BOTH_MAX_TOKENS
const OWNER = "zz-owner-name"; // three tokens, the shape of an owner and a repository
const HEX = "decaf-bad-beef"; // a term made of hexadecimal digits only

test("digest: a term built into an identifier is found: camelCase, PascalCase, an acronym next to it, a suffix, a digit", () => {
  const { runtime, id } = makeDenylist([[TERM], [SOLO], [OWNER], ["zz-owner-http"]]);
  const hits = (text) => digestHits(text, runtime).map((hit) => hit.id);
  const spellings = {
    [TERM]: ["zzLeakTerm", "ZzLeakTerm", "getZzLeakTerm", "zzLeakTermSyncState", "ZZLeakTermValue", "zz_leak_termSync", "ZZ_LEAK_TERM_SYNC", "zzLeakTerm2", "zz-leak-term2", "v2zz-leak-term", "zz-leak-term3x"],
    [SOLO]: ["ZzSoloTerm", "zzSoloTermState", "getZzSoloTerm", "2zzsoloterm", "zzsoloterm2", "zzsoloterm2fa"],
    [OWNER]: ["zz-owner-nameSyncState", "ZzOwnerNameSync", "zz-owner-name2024report", "zz-owner-nameV2"],
    "zz-owner-http": ["zz-owner-HTTPServer", "zzOwnerHTTPServer"],
  };
  for (const [term, texts] of Object.entries(spellings)) {
    for (const text of texts) assert.deepEqual(hits(text), [id(term)], `${show(text)} holds ${term.length} characters of a term`);
  }
  // the span is the term's own letters, in the original text
  assert.deepEqual(digestHits("see zz-owner-nameSyncState!", runtime), [{ id: id(OWNER), category: "other", start: 4, end: 17 }]);
  assert.deepEqual(digestHits("fooZzLeakTermBar", runtime), [{ id: id(TERM), category: "other", start: 3, end: 13 }]);
  // a token of more than 64 characters is not searched for a lower-case glue, but its case and digit boundaries still are
  assert.deepEqual(hits(`${"q".repeat(70)}ZzSoloTerm`), [id(SOLO)]);
  assert.deepEqual(hits(`${"q".repeat(70)}${SOLO}`), [], "no boundary: the letters of a long token are not searched");
});

test("digest: a term glued to other letters is found inside a token and at the ends of its words, within the documented limits", () => {
  const { runtime, id } = makeDenylist([[TERM], [SOLO], [MULTI], [FIVE]]);
  const hits = (text) => digestHits(text, runtime).map((hit) => hit.id);
  // inside one token: any glue, up to 64 characters in all
  for (const text of ["xzzsoloterm", "zzsolotermx", "foozzsolotermbar", `${"q".repeat(54)}${SOLO}`, `${SOLO}${"q".repeat(54)}`, `${"a".repeat(27)}${SOLO}${"b".repeat(27)}`]) {
    assert.deepEqual(hits(text), [id(SOLO)], `${text.length} characters`);
  }
  assert.deepEqual(hits(`${"q".repeat(55)}${SOLO}`), [], "a token of 65 characters is not searched");
  assert.deepEqual(digestHits("xzzsoloterm", runtime), [{ id: id(SOLO), category: "other", start: 1, end: 11 }]);
  // a term of several words with its separators kept: up to three characters cut from the first word and from the last
  for (const text of ["xzz-leak-term", "zz-leak-terms", "zz-leak-termite", "abczz-leak-term", "foozz-leak-termbar", "x_zz.leak/termy", "zz-leakterm-s"]) {
    const found = hits(text);
    assert.ok(found.includes(id(TERM)), `${show(text)} holds the term`);
  }
  assert.deepEqual(hits("zz-multi-word-term"), [id(MULTI)]);
  assert.deepEqual(hits("foozz-multi-word-termbar"), [id(MULTI)], "both ends, four words");
  assert.deepEqual(hits("xzz-five-token-long-term"), [id(FIVE)], "one end, five words");
  assert.deepEqual(hits("zz-five-token-long-terms"), [id(FIVE)]);
  assert.deepEqual(hits("foozz-five-token-long-termbar"), [], "five words: only one end is searched");
  assert.deepEqual(hits("abcdzz-leak-term"), [], "four characters glued to the first word");
  assert.deepEqual(hits("zz-leak-termwxyz"), [], "four characters glued to the last word");
  assert.deepEqual(hits("abcdzzleaktermwxyz"), [id(TERM)], "but the same letters without separators are one token");
  assert.deepEqual(hits("xzz leak term"), [], "white space between the words: only an exact spelling counts");
  assert.deepEqual(hits("zz-leak-ter"), []);
  assert.deepEqual(digestHits("see xzz-leak-term2", runtime), [{ id: id(TERM), category: "other", start: 5, end: 17 }]);
});

test("digest: a term is not searched for inside a long hexadecimal token (a commit or content hash), only at its own boundaries", () => {
  const { runtime, id } = makeDenylist([[HEX]]);
  const hits = (text) => digestHits(text, runtime).map((hit) => hit.id);
  const hash = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(hits(`${hash.slice(0, 16)}decafbadbeef${hash.slice(0, 12)}`), [], "a 40-character hexadecimal token");
  assert.deepEqual(hits(`${hash.slice(0, 5)}decafbadbeef${hash.slice(0, 5)}`), [id(HEX)], "a shorter token still is");
  assert.deepEqual(hits(`${hash} ${HEX}`), [id(HEX)], "and the term next to a hash is found as it is written");
});

test("digest: a glued or camelCased term stays a hit with the same id when other terms are in the denylist, and nothing else in the line is", () => {
  const { runtime, id } = makeDenylist([[TERM], [SOLO]]);
  const line = "const zzLeakTermBadge = fooZzsolotermBar + notAnythingAtAll + zzleak + sync;";
  assert.deepEqual(digestHits(line, runtime).map((hit) => hit.id), [id(TERM), id(SOLO)]);
  assert.deepEqual(digestHits("const ordinaryName = anotherOrdinaryName2 + helloWorldFooBar + xyz;", runtime), []);
});

test("digest: a line that was searched before gives the same answer, as a copy, for its own denylist and for a whole line only", () => {
  const first = makeDenylist([[TERM]]);
  const second = makeDenylist([[SOLO]]);
  const line = `${TERM} and ${SOLO}`;
  const once = digestHits(line, first.runtime);
  assert.deepEqual(once, [{ id: first.id(TERM), category: "other", start: 0, end: 12 }]);
  once[0].id = "tampered";
  once.push({ id: "extra" });
  const again = digestHits(line, first.runtime);
  assert.deepEqual(again, [{ id: first.id(TERM), category: "other", start: 0, end: 12 }], "a caller cannot change what is remembered");
  again[0].end = 99;
  assert.deepEqual(digestHits(line, first.runtime), [{ id: first.id(TERM), category: "other", start: 0, end: 12 }], "nor what the remembered answer hands out");
  assert.deepEqual(digestHits(line, second.runtime).map((hit) => hit.id), [second.id(SOLO)], "another denylist has its own answers");
  assert.deepEqual(digestHits(line, first.runtime, { split: 4 }).map((hit) => hit.start), [0], "a search with a split position is not answered from the whole line");
  assert.deepEqual(digestHits(line, first.runtime, { split: 30 }), []);
  assert.deepEqual(digestHits(line, first.runtime).map((hit) => hit.id), [first.id(TERM)], "and the whole-line answer is still the remembered one");
});

// ---------------------------------------------------------------------------------------------------------------------
// The denylist file
// ---------------------------------------------------------------------------------------------------------------------

test("denylist: an empty denylist fails unless it is explicitly allowed", (t) => {
  const empty = { version: 1, prefix: "sdlc-leak-v1:", maxWindow: 8, digests: {} };
  assert.throws(() => parseDenylist(empty), /empty/);
  assert.doesNotThrow(() => parseDenylist(empty, { allowEmpty: true }));
  const dir = tempDir(t);
  writeFiles(dir, { "empty.json": JSON.stringify(empty) });
  assert.throws(() => loadDenylist(path.join(dir, "empty.json"), { allowEmpty: false }), /empty/);
  assert.doesNotThrow(() => loadDenylist(path.join(dir, "empty.json"), { allowEmpty: true }));
});

test("denylist: only the documented shape is accepted (hex keys, ids, categories, no extra fields)", () => {
  const { document } = makeDenylist([[TERM]]);
  const [digest] = Object.keys(document.digests);
  const bad = {
    "an extra top-level key": { ...document, note: "x" },
    "a wrong version": { ...document, version: 2 },
    "a missing prefix": { ...document, prefix: "" },
    "an out-of-range maxWindow": { ...document, maxWindow: 99 },
    "a non-hex digest key": { ...document, digests: { notahexdigest: { id: "d01", category: "other" } } },
    "an extra field on an entry": { ...document, digests: { [digest]: { id: "d01", category: "other", term: "x" } } },
    "an unknown category": { ...document, digests: { [digest]: { id: "d01", category: "secret" } } },
    "a malformed id": { ...document, digests: { [digest]: { id: "one", category: "other" } } },
    "a repeated id": { ...document, digests: { [digest]: { id: "d01", category: "other" }, [digest.replace(/^./, "f")]: { id: "d01", category: "org" } } },
  };
  for (const [label, candidate] of Object.entries(bad)) assert.throws(() => parseDenylist(candidate), /denylist:/, label);
});

test("denylist: the committed denylist.json is digests only, valid, and not empty", () => {
  const document = JSON.parse(fs.readFileSync(REAL_DENYLIST, "utf8"));
  assert.deepEqual(Object.keys(document).sort(), ["digests", "maxWindow", "prefix", "version"]);
  for (const [digest, entry] of Object.entries(document.digests)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(entry).sort(), ["category", "id"]);
  }
  // An empty list protects nothing: this fails unless the development job sets SDLC_LEAK_ALLOW_EMPTY=1.
  const runtime = parseDenylist(document, { allowEmpty: process.env.SDLC_LEAK_ALLOW_EMPTY === "1" });
  assert.ok(process.env.SDLC_LEAK_ALLOW_EMPTY === "1" || runtime.byDigest.size > 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Generic rules: a positive and near misses for each
// ---------------------------------------------------------------------------------------------------------------------

const COVERED_RULES = new Set();

function ruleTest(rule, { positive = [], negative = [], options = {} }) {
  COVERED_RULES.add(rule);
  test(`rule ${rule}: fires on a synthetic positive and stays silent on near misses`, () => {
    assert.ok(positive.length > 0 && negative.length > 0);
    for (const text of positive) assert.ok(fires(rule, text, options), `should fire on ${show(text)}`);
    for (const text of negative) assert.ok(!fires(rule, text, options), `should be silent on ${show(text)}`);
  });
}

const WIN_EXEMPT = ["runneradmin", "Public", "Default", "USERNAME", "%USERNAME%", "<user>", "user"];
const POSIX_EXEMPT = ["runner", "runneradmin", "vsts", "ubuntu", "user", "you", "node", "example", "<user>"];

ruleTest("home-path-win", {
  positive: [
    j("C:", BS, "Users", BS, "alice", BS, "Documents"),
    j("C:", BS, BS, "Users", BS, BS, "alice"),
    j("C:", BS.repeat(4), "Users", BS.repeat(4), "alice"),
    j("D:/Users/", "alice/x"),
    j("c:", BS, "users", BS, "Alice"),
  ],
  negative: [
    ...WIN_EXEMPT.map((name) => j("C:", BS, "Users", BS, name, BS, "x")),
    ...WIN_EXEMPT.map((name) => j("C:/Users/", name, "/x")),
    j("C:", BS, "Users", BS),
    j("C:", BS, "Users"),
    j("Users", BS, "alice"),
    j("C:", BS, "Users", BS, "$env:USERNAME"),
    j("C:", BS, "Windows", BS, "System32"),
  ],
});

ruleTest("home-path-posix", {
  positive: [
    j("/home/", "alice/.ssh/id"),
    j("/Users/", "alice/Library"),
    j("HOME=/home/", "alice"),
    j('"/Users/', 'alice"'),
    j("/mnt/c/Users/", "alice/x"),
    j("file:///home/", "alice/x"),
  ],
  negative: [
    ...POSIX_EXEMPT.map((name) => j("/home/", name, "/work")),
    ...POSIX_EXEMPT.map((name) => j("/Users/", name, "/x")),
    j("https://example.test/home/", "docs/page"),
    j("src/home/", "alice/x"),
    j("C:/Users/", "Public/x"),
    j("https://api.example.test/users/", "octocat/repos"),
    j("/home/", "$USER/x"),
  ],
});

ruleTest("microsoft-email", {
  positive: [j("alice", "@", "microsoft", ".com"), j("Alice.Smith+tag", "@", "Microsoft", ".COM")],
  negative: [j("alice", "@", "microsoft", ".community"), j("alice", "@", "not", "microsoft", ".com"), j("microsoft", ".com"), j("@", "microsoft", ".com")],
});

ruleTest("email-any", {
  positive: [j("alice", "@", "zz-corp.net"), j("a.b+c", "@", "mail.zz-corp.io"), j("a/b/alice", "@", "zz-corp.io")],
  negative: [
    j("https://user:pw", "@host.example.org/x"),
    j("git+ssh://git", "@", "github", ".com/o/r.git"),
    "package@1.2.3",
    "gh-aw@v0.86.2",
    j("a/b/c-d_e.f@g", ".yaml"),
    j("logo@2x", ".PNG"),
    j("pkg@x", ".json"),
    j("fixture@example", ".invalid"),
    j("a@example", ".com"),
    j("a@example", ".org"),
    j("a@mail.", "example", ".com"),
    j("123+bob@users", ".noreply.github.com"),
    j("git@github", ".com:o/r.git"),
    j("x@local", "host"),
    j("alice", "@", "microsoft", ".com"),
  ],
});

ruleTest("internal-host", {
  positive: [
    j("https://foo.visual", "studio.com/x"),
    j("https://pkgs.dev.", "azure.com/x"),
    j("dev.", "azure.com"),
    j("micro", "soft.io"),
    j("contoso.share", "point.com"),
    j("x.corp.micro", "soft.com"),
    j("host.ms", "ft.net"),
    j("registry ms", "-feed here"),
  ],
  negative: [j("notvisual", "studio.com"), j("visual", "studio.community"), j("for", "ms", "-feed"), j("ms", "-feeds"), j("azure", ".com"), j("micro", "soft.com")],
});

ruleTest("session-state-path", {
  positive: [
    j("session", "-state/", "a1b2c3d4-e5f6-4a7b-8c9d"),
    j("C:", BS, "x", BS, "session", "-state", BS, "a1b2c3d4-e5f6"),
    j("/opt/app/.copi", "lot/state.json"),
    j("C:", BS, "x", BS, ".copi", "lot", BS, "y"),
    j(".copi", "lot", BS, "x"),
  ],
  negative: [
    j("session", "-state"),
    j("session", "-state/", "latest"),
    j("session", "-states/", "a1b2c3d4-e5f6"),
    j(".copi", "lot-notes"),
    j("github.copi", "lot.com"),
    j("mkdir -p $HOME/.copi", "lot/settings.json"),
    j("${HOME}/.copi", "lot/x"),
    j("~/.copi", "lot/x"),
    j("%USERPROFILE%", BS, ".copi", "lot", BS, "x"),
    j("$env:USERPROFILE", BS, ".copi", "lot"),
    j("$USERPROFILE/.copi", "lot/x"),
  ],
});

ruleTest("run-id-in-comment", {
  positive: [
    j("// run ", RUN_NUMBER),
    j("# workflow run id ", RUN_NUMBER),
    j(" * Run ", RUN_NUMBER, " failed"),
    j("<!-- runs ", RUN_NUMBER, " -->"),
    j("const x = 1; // run ", RUN_NUMBER),
    j("https://github.com/o/r/actions/runs/", "123456"),
  ],
  negative: [
    j("const run = ", RUN_NUMBER, ";"),
    j("// run ", "12345"),
    j("// the year ", RUN_NUMBER),
    j("// run ", "x".repeat(45), " ", RUN_NUMBER),
    j("https://github.com/o/r/actions/runs/", "12345"),
  ],
});

ruleTest("issue-or-pr-number", {
  positive: [j("see issue #", "12"), j("Pull Request #", "345"), j("PR #", "6789"), j("pr#", "5")],
  negative: [j("PR ", "12"), j("PR #", "1234567"), j("#", "12"), j("the issue tracker #", "x"), j("spr #", "12")],
});

ruleTest("plan-md-reference", {
  positive: [j("see plan", ".md for details"), j("PLAN", ".MD"), j("docs/plan", ".md")],
  negative: [j("release-plan", ".md"), j("plan", ".markdown"), j("my_plan", ".md"), j("plan", "-md")],
});

ruleTest("guid", {
  positive: [j("id 123e4567-", "e89b-42d3-a456-426614174000"), j("123E4567-", "E89B-12D3-B456-426614174000")],
  negative: [
    "00000000-0000-0000-0000-000000000000",
    j("123e4567-", "e89b-62d3-a456-426614174000"),
    j("123e4567-", "e89b-42d3-c456-426614174000"),
    j("123e4567-", "e89b-42d3-a456-42661417400"),
  ],
});

const TOKEN_BODY = "QzXwVuTs1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p";
ruleTest("secret-shape", {
  positive: [
    j("-----BEGIN ", "RSA PRIVATE KEY-----"),
    j("-----BEGIN ", "PRIVATE KEY-----"),
    j("gh", "p_", TOKEN_BODY),
    j("gh", "o_", TOKEN_BODY),
    j("github", "_pat_", TOKEN_BODY, "6Q7r8S9t0U1v2W3x4Y5z"),
    j("AK", "IA", "Q3W4E5R6T7Y8U9I0"),
    j("xox", "b-", "123456789012-QzXwVuTs"),
    j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.", "QzXwVuTs1A2b3C4d"),
  ],
  negative: [
    j("gh", "p_", "FAKE", TOKEN_BODY),
    j("gh", "p_", TOKEN_BODY, "example"),
    j("gh", "p_", TOKEN_BODY, "0000"),
    j("gh", "p_", "a".repeat(36)),
    j("gh", "p_", "short"),
    j("AK", "IA", "Q3W4E5R6T7Y8U9I"),
    j("xox", "b-"),
    j("-----BEGIN ", "PUBLIC KEY-----"),
    j("github", "_pat_", "x".repeat(60)),
  ],
});

COVERED_RULES.add("lock-registry");
test("rule lock-registry: fires on a package-lock.json that leaves the public registry, and only there", () => {
  const lock = "package-lock.json";
  const nested = "examples/app/package-lock.json";
  const positive = [
    ['"resolved": "https://registry.example.test/x/-/x-1.0.0.tgz"', lock],
    ['"resolved": "https://registry.npmjs.org.zz-proxy.test/x/-/x-1.0.0.tgz"', lock],
    ['"x": "file:../x"', lock],
    ['"link": true', lock],
    ['"resolved": "https://registry.example.test/x.tgz"', nested],
  ];
  const negative = [
    ['"resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"', lock],
    ['"resolved": "https://registry.example.test/x/-/x-1.0.0.tgz"', "package.json"],
    ['"link": true', "tools/other.json"],
    ['"link": false', lock],
  ];
  for (const [text, file] of positive) assert.ok(fires("lock-registry", text, { path: file }), `should fire on ${show(text)} in ${file}`);
  for (const [text, file] of negative) assert.ok(!fires("lock-registry", text, { path: file }), `should be silent on ${show(text)} in ${file}`);
  assert.ok(!fires("lock-registry", "package-lock.json", { isPath: true, path: "package-lock.json" }), "the rule reads content, not paths");
});

COVERED_RULES.add("soft:spec-ac-reference");
test("rule soft:spec-ac-reference: is reported and never a hard failure", () => {
  const hits = findRuleHits(j("see SPEC-", "01, A", "C12 and O", "Q51"), { path: "src/x.mjs" });
  assert.deepEqual(hits.map((hit) => [hit.rule, hit.kind]), [["soft:spec-ac-reference", "soft"], ["soft:spec-ac-reference", "soft"], ["soft:spec-ac-reference", "soft"]]);
  for (const text of ["AC1234", "OQ5", "SPEC-1", "ACID", "abc12"]) assert.ok(!fires("soft:spec-ac-reference", text), `should be silent on ${text}`);
  assert.ok(!HARD_RULE_IDS.includes("soft:spec-ac-reference"));
});

test("rules: every generic rule has a case above, and a hit is a span of exactly the matched part", () => {
  assert.deepEqual([...COVERED_RULES].sort(), RULES.map((rule) => rule.id).sort());
  const slice = (text, rule) => {
    const hit = findRuleHits(text, { path: "src/x.mjs" }).find((candidate) => candidate.rule === rule);
    return text.slice(hit.start, hit.end);
  };
  const winPath = j("C:", BS, "Users", BS, "alice");
  assert.equal(slice(j("at ", winPath, " done"), "home-path-win"), winPath);
  assert.equal(slice(j("run // run ", RUN_NUMBER, " end"), "run-id-in-comment"), RUN_NUMBER);
  const address = j("alice", "@", "zz-corp.net");
  assert.equal(slice(j("mail ", address, " now"), "email-any"), address);
  const token = j("gh", "p_", TOKEN_BODY);
  assert.equal(slice(j("t=", token, ";"), "secret-shape"), token);
});

// ---------------------------------------------------------------------------------------------------------------------
// The scanner over a tree
// ---------------------------------------------------------------------------------------------------------------------

test("tree: every finding is a position and a rule, and a clean tree has none", (t) => {
  const { runtime, id } = makeDenylist([[TERM, "handle"]]);
  const clean = tempDir(t, "clean");
  writeFiles(clean, { "src/a.mjs": "export const a = 1;\n", "README.md": "# readme\n" });
  assert.deepEqual(scanTree({ root: clean, denylist: runtime, allow: NO_ALLOW }).findings, []);

  const dir = tempDir(t);
  const resolved = '"resolved": "https://registry.example.test/x.tgz"';
  writeFiles(dir, {
    "src/a.mjs": `const x = 1;\n// ${j("C:", BS, "Users", BS, "alice")}\n`,
    "docs/b.md": `see ${TERM} here\n`,
    "package-lock.json": `{\n  ${resolved}\n}\n`,
  });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(
    result.findings.map(({ path: file, line, start, end, rule, id: digestId, category }) => ({ file, line, start, end, rule, digestId, category })),
    [
      { file: "docs/b.md", line: 1, start: 5, end: 16, rule: "digest", digestId: id(TERM), category: "handle" },
      { file: "package-lock.json", line: 2, start: 3, end: 2 + resolved.length, rule: "lock-registry", digestId: undefined, category: undefined },
      { file: "src/a.mjs", line: 2, start: 4, end: 17, rule: "home-path-win", digestId: undefined, category: undefined },
    ],
  );
  assert.equal(result.scanned, 3);
});

test("tree: a binary file is not skipped: the printable strings of its bytes are scanned, and its name too", (t) => {
  const { runtime, id } = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, { [`${TERM}.bin`]: Buffer.from([0, 1, 2, ...Buffer.from(TERM)]), "plain.bin": Buffer.from([0, ...Buffer.from(TERM)]) });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.binary, 2);
  assert.deepEqual(result.findings.map(key), ["plain.bin:1:digest", `${TERM}.bin:0:digest`, `${TERM}.bin:1:digest`], "the file name is a hit (line 0), and so is the string in the bytes");
  assert.deepEqual(result.findings.map((finding) => finding.id), [id(TERM), id(TERM), id(TERM)]);
});

test("extractStrings: runs of four or more printable characters, UTF-8 or ASCII first and UTF-16LE after, each in file order", () => {
  const bytes = Buffer.concat([
    Buffer.from([0, 1, 2]), Buffer.from("abcd"), Buffer.from([3]), Buffer.from("abc"), Buffer.from([0]), Buffer.from("héllo wörld"), Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from("tab\tin side"), Buffer.from("\n"), Buffer.from("next line"), Buffer.from([0, 0]),
    Buffer.from("wide text", "utf16le"), Buffer.from([0xff]), Buffer.from("xy", "utf16le"), Buffer.from([0, 0]),
  ]);
  assert.deepEqual(extractStrings(bytes), ["abcd", "héllo wörld", "tab\tin side", "next line", "wide text"]);
  assert.deepEqual(extractStrings(Buffer.concat([Buffer.from([7]), Buffer.from("odd offset", "utf16le")])), ["odd offset"], "UTF-16LE that does not start at an even offset");
  assert.deepEqual(extractStrings(Buffer.from([0, 1, 2, 3, 0xff, 0xfe])), []);
  assert.deepEqual(extractStrings(Buffer.alloc(0)), []);
  assert.deepEqual(extractStrings(Buffer.from("ab\0cd\0efgh")), ["efgh"], "a NUL ends a string");
});

test("tree: a term in a binary file is found in UTF-8, ASCII and UTF-16LE, in an encoded string and by a rule, and not across a NUL or in noise", (t) => {
  const { runtime, id } = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  const noise = Buffer.from(Array.from({ length: 4000 }, (_, index) => (index * 7919 + 13) % 251));
  writeFiles(dir, {
    "ascii.bin": Buffer.concat([Buffer.from([0, 0, 1]), Buffer.from(`config=${TERM};`), Buffer.from([0])]),
    "utf16.bin": Buffer.concat([Buffer.from([0, 1]), Buffer.from(`name ${TERM}`, "utf16le"), Buffer.from([0, 0])]),
    "camel.bin": Buffer.concat([Buffer.from([0]), Buffer.from("fooZzLeakTermBar"), Buffer.from([0])]),
    "encoded.bin": Buffer.concat([Buffer.from([0]), Buffer.from(pct(TERM)), Buffer.from([0])]),
    "address.bin": Buffer.concat([Buffer.from([0]), Buffer.from(j("write to alice", "@", "zz-corp.net")), Buffer.from([0])]),
    "cut.bin": Buffer.concat([Buffer.from([0]), Buffer.from("zz-leak"), Buffer.from([0]), Buffer.from("term"), Buffer.from([0])]),
    "noise.bin": noise,
    "after-noise.bin": Buffer.concat([noise, Buffer.from([0]), Buffer.from(`last ${TERM}`)]),
  });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.binary, 8);
  assert.deepEqual(
    result.findings.map((finding) => `${finding.path}:${finding.rule}`),
    ["address.bin:email-any", "after-noise.bin:digest", "ascii.bin:digest", "camel.bin:digest", "encoded.bin:digest", "utf16.bin:digest"],
  );
  const columns = Object.fromEntries(result.findings.map((finding) => [finding.path, [finding.line, finding.start, finding.end]]));
  assert.deepEqual(columns["ascii.bin"], [1, 8, 19], "line is the ordinal of the string; the columns are in it");
  assert.deepEqual(columns["utf16.bin"], [1, 6, 17], "a UTF-16LE string is one string, numbered after the UTF-8 ones");
  assert.equal(result.findings.find((finding) => finding.path === "ascii.bin").id, id(TERM));
});

test("tree: the generic rules skip tests/fixtures/leak-guard in a binary file too, the digests do not", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  const bytes = Buffer.concat([Buffer.from([0]), Buffer.from(`${j("C:", BS, "Users", BS, "alice")} ${TERM}`), Buffer.from([0])]);
  writeFiles(dir, { "tests/fixtures/leak-guard/vector.bin": bytes, "tests/other/vector.bin": bytes });
  assert.deepEqual(
    scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW }).findings.map(key).sort(),
    ["tests/fixtures/leak-guard/vector.bin:1:digest", "tests/other/vector.bin:1:digest", "tests/other/vector.bin:1:home-path-win"],
  );
});

test("history: the strings of a binary blob are scanned, the ones that a change adds or removes are findings, and the ones that it keeps are not", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  const blob = (...texts) => Buffer.concat(texts.flatMap((text) => [Buffer.from([0]), Buffer.from(text)]));
  writeFiles(repo, { "data.bin": blob(`first ${TERM}`) });
  const added = commitAll(repo, "add a binary file that holds the term");
  writeFiles(repo, { "data.bin": blob(`first ${TERM}`, "another string") });
  commitAll(repo, "add a string, keep the term: no finding");
  writeFiles(repo, { "data.bin": blob("another string") });
  const removed = commitAll(repo, "drop the term");
  writeFiles(repo, { "wide.bin": Buffer.concat([Buffer.from([0, 1]), Buffer.from(`w ${TERM}`, "utf16le"), Buffer.from([0, 0])]) });
  const wide = commitAll(repo, "add a binary file with a UTF-16LE term");
  git(repo, ["rm", "-q", "wide.bin"]);
  git(repo, ["commit", "-q", "-m", "delete it"]);
  const deleted = git(repo, ["rev-parse", "HEAD"]).trim();

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  const at = (sha) => sha.slice(0, 7);
  assert.deepEqual(
    failing(result).map((finding) => `${at(finding.commit)} ${key(finding)}`).sort(),
    [`${at(added)} data.bin:1:digest:added`, `${at(removed)} data.bin:1:digest:removed`, `${at(wide)} wide.bin:1:digest:added`, `${at(deleted)} wide.bin:1:digest:removed`].sort(),
  );
});

test("history: a leak in the name of a binary file is still found, and a clean binary change is not a finding", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { [`${TERM}.bin`]: Buffer.from([0, 1, 2, 3]), "clean.bin": Buffer.from([0, ...Buffer.from("nothing to see here")]) });
  commitAll(repo, "add two binary files");
  writeFiles(repo, { "clean.bin": Buffer.from([0, ...Buffer.from("still nothing to see")]) });
  commitAll(repo, "change one");
  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(failing(result).map(key), [`${TERM}.bin:0:digest`]);
});

test("output: a finding in a binary file is a position and a rule, the summary says that binary files are scanned, and nothing of the string is printed", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, { "a.bin": Buffer.concat([Buffer.from([0]), Buffer.from(`xx ${TERM} yy`), Buffer.from([0])]) });
  const run = cli(["--tree", "--root", dir, ...configFiles(tempDir(t, "config"), denylist)]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /^a\.bin:1:4-15 rule=digest id=d01 category=handle$/m);
  assert.match(run.stdout, /\(0 text files scanned, 1 binary scanned for strings\)/);
  for (const text of [TERM, "zz_leak_term", "zzleakterm"]) assert.ok(!run.output.toLowerCase().includes(text), `the output must not contain ${text.length} characters of a matched text`);
  const report = cli(["--report", "--root", dir, ...configFiles(tempDir(t, "config2"), denylist)]);
  assert.match(report.stdout, /0 scanned as text, 1 binary \(strings scanned\), 0 missing/);
});

test("tree: a UTF-16 file with a byte-order mark is decoded and scanned, not skipped as binary", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  const text = `first\n${TERM}\n`;
  const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  writeFiles(dir, { "le.txt": littleEndian, "be.txt": bigEndian });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.binary, 0);
  assert.deepEqual(result.findings.map(key), ["be.txt:2:digest", "le.txt:2:digest"]);
});

test("tree: a UTF-8 byte-order mark does not shift the columns of the first line", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  writeFiles(dir, { "bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${TERM}\n`)]) });
  const [finding] = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW }).findings;
  assert.deepEqual([finding.line, finding.start, finding.end], [1, 1, 12]);
});

test("tree: a tracked file that was deleted from the working copy is skipped, not an error", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "gone.txt": `${TERM}\n`, "kept.txt": "clean\n" });
  commitAll(repo, "add");
  fs.rmSync(path.join(repo, "gone.txt"));
  const result = scanTree({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.missing, 1);
  assert.deepEqual(result.findings, []);
});

test("tree: tests/fixtures/leak-guard is exempt from the generic rules and never from the digest rules", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  const line = `${j("C:", BS, "Users", BS, "alice")} ${TERM}\n`;
  writeFiles(dir, { "tests/fixtures/leak-guard/vector.txt": line, "tests/other/vector.txt": line });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(result.findings.map(key).sort(), ["tests/fixtures/leak-guard/vector.txt:1:digest", "tests/other/vector.txt:1:digest", "tests/other/vector.txt:1:home-path-win"]);
});

test("tree: a git checkout scans tracked files only; a plain directory skips node_modules and nested .git", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "tracked.txt": `${TERM}\n` });
  commitAll(repo, "add tracked");
  writeFiles(repo, { "untracked.txt": `${TERM}\n` });
  assert.deepEqual(scanTree({ root: repo, denylist: runtime, allow: NO_ALLOW }).findings.map(key), ["tracked.txt:1:digest"]);

  const plain = tempDir(t, "plain");
  writeFiles(plain, { "kept.txt": `${TERM}\n`, "node_modules/pkg/index.js": `${TERM}\n`, "vendor/.git/config": `${TERM}\n` });
  assert.deepEqual(scanTree({ root: plain, denylist: runtime, allow: NO_ALLOW }).findings.map(key), ["kept.txt:1:digest"]);
});

test("tree: the guard's own files are clean under the real denylist and the generic rules", () => {
  const files = fs.readdirSync(path.join(ROOT, "tools", "leak-guard")).map((name) => `tools/leak-guard/${name}`);
  files.push("tests/leak-guard.test.mjs");
  const denylist = loadDenylist(REAL_DENYLIST, { allowEmpty: process.env.SDLC_LEAK_ALLOW_EMPTY === "1" });
  const allow = loadAllow(REAL_ALLOW, { denylist });
  const result = scanTree({ root: ROOT, denylist, allow, list: () => files });
  assert.deepEqual(failing(result).map(key), []);
  assert.deepEqual(result.findings.filter((finding) => finding.status === "soft").map(key), [], "and they add nothing to the report-only counts");
});

// ---------------------------------------------------------------------------------------------------------------------
// Line breaks: a term that a line break cut in two
// ---------------------------------------------------------------------------------------------------------------------

test("tree: a term that a line break cut in two is found on the line where it ends, in whatever way it was cut", (t) => {
  const { runtime, id } = makeDenylist([[TERM, "handle"], [SOLO]]);
  const dir = tempDir(t);
  writeFiles(dir, {
    "between-words.txt": "zz-leak\nterm\n",
    "after-hyphen.txt": "const x = zz-leak-\nterm;\n",
    "inside-a-word.txt": "see zz-le\nak-term here\n",
    "prose.txt": "the zz leak\nterm is here\n",
    "glued.txt": "xzzleak\nterm\n",
    "camel.txt": "zzLeak\nTermSync\n",
    "solo.txt": "zzsolo\nterm\n",
    "indented.txt": "call(zz-leak,\n      term)\n",
    "crlf.txt": "zz-leak\r\nterm\r\n",
  });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(
    result.findings.map((finding) => `${finding.path}:${finding.line}:${finding.start}-${finding.end}=${finding.id === id(TERM) ? "term" : "solo"}`),
    [
      "after-hyphen.txt:2:1-4=term",
      "between-words.txt:2:1-4=term",
      "camel.txt:2:1-4=term",
      "crlf.txt:2:1-4=term",
      "glued.txt:2:1-4=term",
      "indented.txt:2:1-10=term",
      "inside-a-word.txt:2:1-7=term",
      "prose.txt:2:1-4=term",
      "solo.txt:2:1-4=solo",
    ],
    "the span is the part of the term that is on the second line",
  );
});

test("tree: a term on one line is reported once, and a term over three lines, over a blank line, or cut, glued and spelled with separators is not found", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  writeFiles(dir, {
    "one-line.txt": `before\n${TERM}\nafter\n`,
    "first-line.txt": `${TERM}\nnext line\n`,
    "three-lines.txt": "zz-\nleak-\nterm\n",
    "blank-between.txt": "zz-leak\n\nterm\n",
    "other-words.txt": "zz-leak is a\nterm that does not belong\n",
    "separate.txt": "zz-leak\nnot-the-term\n",
    "glued-with-separators.txt": "xzz-leak\nterm\n", // the one search that is not made across a break: it would cost too much on every pair of lines
  });
  const rows = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW }).findings.map(key);
  assert.deepEqual(rows, ["first-line.txt:1:digest", "one-line.txt:2:digest"]);
});

test("tree: a generic rule sees across a line break too: an address, a token that a hyphen or a break cut, and a home path", (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  const token = j("gh", "p_", "QzXwVuTs1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p");
  const windowsHome = j("C:", BS, "Users", BS, "alice", BS, "x");
  writeFiles(dir, {
    "address.txt": `write to ${j("alice", "@")}\n${j("zz-corp", ".net")} now\n`,
    "token-hyphen.txt": `t = ${token.slice(0, 20)}-\n${token.slice(20)}\n`,
    "token-break.txt": `t = ${token.slice(0, 20)}\n${token.slice(20)}\n`,
    "home.txt": `at ${j("C:", BS, "Users", BS)}\n${j("alice", BS, "x")}\n`,
    "clean.txt": `write to alice\nat zz-corp now\nsee ${j("C:", BS)}\nUsers\n`,
    "whole-line.txt": `${windowsHome}\nnext\n`,
  });
  const rows = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW }).findings.map(key);
  assert.deepEqual(rows, ["address.txt:2:email-any", "home.txt:2:home-path-win", "token-break.txt:2:secret-shape", "token-hyphen.txt:2:secret-shape", "whole-line.txt:1:home-path-win"], "clean.txt: words that merely sit on two lines are not a hit");
});

test("history: a term that a line break cut in two is found in an added line, in a removed line and beside an unchanged one, and not between two unchanged ones", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  const file = (second, fourth = "filler two") => `zz-leak\n${second}\nfiller one\n${fourth}\nfiller three\nfiller four\nfiller five\n`;
  writeFiles(repo, { "a.txt": file("term") });
  const added = commitAll(repo, "add the wrapped term");
  writeFiles(repo, { "a.txt": file("term", "filler 2") });
  commitAll(repo, "change a line near it: the lines that hold the term are unchanged context, so no finding");
  writeFiles(repo, { "a.txt": file("not-it", "filler 2") });
  const removed = commitAll(repo, "change the second line: the term loses its tail");
  writeFiles(repo, { "a.txt": file("term", "filler 2") });
  const readded = commitAll(repo, "put the tail back: a changed line beside an unchanged one");

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  const at = (sha) => sha.slice(0, 7);
  assert.deepEqual(
    failing(result).map((finding) => `${at(finding.commit)} ${key(finding)}`).sort(),
    [`${at(added)} a.txt:2:digest:added`, `${at(removed)} a.txt:2:digest:removed`, `${at(readded)} a.txt:2:digest:added`].sort(),
  );
});

test("history: the lines of a commit message and of a tag message are joined too", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a subject\n\nthe body wraps a name at zz-leak\nterm in two lines");
  tagAnnotated(repo, "v1", "release notes\n\nthe message wraps zz-leak\nterm too");
  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(failing(result).map(key).sort(), ["commit:body:2:digest", "tag:message:4:digest"]);
});

test("output: a finding across a line break is a position and a rule, and nothing of the text", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, { "wrapped.txt": "zz-leak\nterm\n" });
  const run = cli(["--tree", "--root", dir, ...configFiles(tempDir(t, "config"), denylist)]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /^wrapped\.txt:2:1-4 rule=digest id=d01 category=handle$/m);
  for (const text of ["zz-leak", "zz_leak_term", "zzleakterm"]) assert.ok(!run.output.toLowerCase().includes(text), `the output must not contain ${text.length} characters of a matched text`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Encodings: percent-encoding, backslash escapes, HTML entities
// ---------------------------------------------------------------------------------------------------------------------

/** Every byte of `text` percent-encoded. */
const pct = (text) => [...Buffer.from(text)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");

test("decode: percent-encoding, escapes and entities are decoded, in at most two passes, and plain text has no variant", () => {
  const same = (text) => assert.deepEqual(decodedVariants(text), [], `nothing to decode in ${show(text)}`);
  for (const text of ["", "plain words", "100% sure", "%s and %d", "50%%", "a%zzb", "%2", "&nbsp;", "&unknown;", "&#;", "&;", "\\n and \\t", "\\u12", "\\xZZ", "AT&T"]) same(text);

  // percent: ASCII, UTF-8 sequences, bytes that are not UTF-8 (only the ASCII ones are decoded)
  assert.deepEqual(decodedVariants("a%2Fb%20c%2f"), ["a/b c/"]);
  assert.deepEqual(decodedVariants(pct("zz-leak")), ["zz-leak"], "every byte encoded");
  assert.deepEqual(decodedVariants("caf%C3%A9 %E2%82%AC"), ["café €"]);
  assert.deepEqual(decodedVariants("%41%FF%42"), ["A%FFB"], "an invalid byte stays, the ASCII ones around it do not");
  assert.deepEqual(decodedVariants("%C3%28"), ["%C3("], "an invalid sequence stays, its ASCII byte does not");

  // escapes of a script or JSON string: \u, \u{...} and \x
  assert.deepEqual(decodedVariants("\\u0041\\u00e9\\u{1F600}\\x41\\x7a"), ["Aé😀Az"]);
  assert.deepEqual(decodedVariants("\\uD83D\\uDE00"), ["😀"], "a surrogate pair written as two escapes");
  assert.deepEqual(decodedVariants("\\u{110000}\\u{D800}"), [], "no code point beyond Unicode, and no lone surrogate in braces");

  // entities: decimal, hexadecimal and the named ones
  assert.deepEqual(decodedVariants("&#65;&#x42;&#X43;&#97;"), ["ABCa"]);
  assert.deepEqual(decodedVariants("&amp;&lt;&gt;&quot;&apos;&sol;&bsol;&colon;&period;&commat;&lowbar;"), [`&<>"'/\\:.@_`]);
  assert.deepEqual(decodedVariants("&#0;&#1114112;&#xD800;&unknown;"), [], "no code point 0, none beyond Unicode, no surrogate, no unknown name");

  // one pass applies the escapes, then the entities, then the percent-encoding: one layer inside another is decoded at once
  assert.deepEqual(decodedVariants("\\u0025\\u0032F"), ["/"]);
  assert.deepEqual(decodedVariants("&#37;2F"), ["/"]);
  assert.deepEqual(decodedVariants("&#92;u0041"), ["\\u0041", "A"], "an escape that an entity made is a second pass");
  // two passes in all: a double encoding is decoded, a triple one is not
  assert.deepEqual(decodedVariants("%252F"), ["%2F", "/"]);
  assert.deepEqual(decodedVariants("%25252F"), ["%252F", "%2F"]);
  assert.deepEqual(decodedVariants("%26amp%3B"), ["&amp;", "&"]);
});

test("tree: a term or a rule that is percent-encoded, escaped or an entity is found, on the whole line, and clean text with such marks is not", (t) => {
  const { runtime, id } = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, {
    "percent-all.txt": `url = https://example.test/${pct(TERM)}\n`,
    "percent-part.txt": "ref=zz%2Dleak%2Dterm&x=1\n",
    "percent-lower.txt": "ref=zz%2dleak%2dterm\n",
    "json-escape.txt": '{"name": "\\u007a\\u007a-leak-term"}\n',
    "hex-escape.txt": 'const name = "\\x7a\\x7a-leak-term";\n',
    "brace-escape.txt": 'const name = "\\u{7a}z-leak-term";\n',
    "entity-numeric.txt": "<p>zz&#45;leak&#x2d;term</p>\n",
    "entity-named.txt": "<p>zz&lowbar;leak&lowbar;term</p>\n",
    "double.txt": "ref=zz%252Dleak%252Dterm\n",
    "triple.txt": "ref=zz%25252Dleak%25252Dterm\n",
    "address-percent.txt": `to=${j("alice", "%40", "zz-corp.net")}\n`,
    "address-entity.txt": `<a>${j("alice", "&commat;", "zz-corp.net")}</a>\n`,
    "address-escape.txt": `"${j("alice", "\\u0040", "zz-corp.net")}"\n`,
    "path-percent.txt": `p=${j("C:", "%5C", "Users", "%5C", "alice")}\n`,
    "path-double.txt": `p=${j("C:", "%255C", "Users", "%255C", "alice")}\n`,
    "path-escape.txt": `{"p": "${j("C:", "\\u005c", "Users", "\\u005c", "alice")}"}\n`,
    "clean.txt": ["printf(\"%d%%\\n\", 100);", "a && b || c", "AT&T and &amp; and &lt;b&gt;", "x = \"\\n\\t\\\\\"", "https://example.test/a%20b?q=%7Bx%7D", "caf%C3%A9", ""].join("\n"),
  });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  const rows = result.findings.map((finding) => `${finding.path}:${finding.line}:${finding.rule}`);
  assert.deepEqual(rows, [
    "address-entity.txt:1:email-any",
    "address-escape.txt:1:email-any",
    "address-percent.txt:1:email-any",
    "brace-escape.txt:1:digest",
    "double.txt:1:digest",
    "entity-named.txt:1:digest",
    "entity-numeric.txt:1:digest",
    "hex-escape.txt:1:digest",
    "json-escape.txt:1:digest",
    "path-double.txt:1:home-path-win",
    "path-escape.txt:1:home-path-win",
    "path-percent.txt:1:home-path-win",
    "percent-all.txt:1:digest",
    "percent-lower.txt:1:digest",
    "percent-part.txt:1:digest",
  ], "triple.txt (three layers) and clean.txt hold nothing");
  const lengths = Object.fromEntries(["percent-all.txt", "json-escape.txt", "address-percent.txt"].map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8").replace(/\n$/, "").length]));
  for (const finding of result.findings.filter((candidate) => candidate.path in lengths)) {
    assert.deepEqual([finding.start, finding.end], [1, lengths[finding.path]], `${finding.path}: a decoded hit covers the whole line`);
  }
  assert.equal(result.findings.find((finding) => finding.path === "percent-all.txt").id, id(TERM));
});

test("tree: a hit that the raw line already has is not reported again, a second one is, and a mark that decodes to a report-only match is not a finding", (t) => {
  const { runtime } = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, {
    "raw-only.txt": `${TERM} and an unrelated %2F mark\n`,
    "raw-and-encoded.txt": `${TERM} ${pct(TERM)}\n`,
    "two-passes.txt": "zz%2Dleak%2Dterm and %2541\n", // the term is in both decoded lines, and is one finding
    "soft.txt": `${j("%53PEC", "-01")} and ${j("%41", "C12")}\n`,
  });
  const result = scanTree({ root: dir, denylist: runtime, allow: NO_ALLOW });
  const whole = TERM.length + 1 + pct(TERM).length;
  assert.deepEqual(
    result.findings.map((finding) => `${finding.path}:${finding.rule}:${finding.start}-${finding.end}`),
    ["raw-and-encoded.txt:digest:1-12", `raw-and-encoded.txt:digest:1-${whole}`, "raw-only.txt:digest:1-12", "two-passes.txt:digest:1-26"],
  );
});

test("tree: a path that holds an encoded term is a finding on line 0, and the output masks the whole path", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  const name = `docs/${pct(TERM)}.txt`;
  writeFiles(dir, { [name]: "clean\n" });
  const result = scanTree({ root: dir, denylist: denylist.runtime, allow: NO_ALLOW });
  assert.deepEqual(result.findings.map(key), [`${name}:0:digest`]);
  assert.equal(createMasker(denylist.runtime)(name), "*".repeat(name.length));
  const run = cli(["--tree", "--root", dir, ...configFiles(tempDir(t, "config"), denylist)]);
  assert.equal(run.code, 1);
  assert.ok(!run.output.includes("%7A") && !run.output.toLowerCase().includes("zz-leak"), "the output holds no part of the path");
});

test("history: an encoded term in an added line and in a commit message is found", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": `x\nzz%2Dleak%2Dterm\n` });
  commitAll(repo, `subject ${pct(TERM)}`);
  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(failing(result).map(key).sort(), ["a.txt:2:digest:added", "commit:subject:1:digest"]);
});

test("output: a finding in an encoded line is a position and a rule, and nothing of the line", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, { "a.txt": `url = ${pct(TERM)}\n` });
  const run = cli(["--tree", "--root", dir, ...configFiles(tempDir(t, "config"), denylist)]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /^a\.txt:1:1-\d+ rule=digest id=d01 category=handle$/m);
  for (const text of ["zz-leak", "%7A", "zzleakterm"]) assert.ok(!run.output.includes(text), `the output must not contain ${text.length} characters of a matched text`);
});

// ---------------------------------------------------------------------------------------------------------------------
// The allow list
// ---------------------------------------------------------------------------------------------------------------------

const HANDLE = "zz-handle-msft"; // invented; contains the invented name below
const NAME = "zz-handle";

function allowFor(denylist, entries) {
  return parseAllow({ version: 1, entries }, { denylist: denylist.runtime });
}

test("allow: an entry waives exactly its rule in exactly its paths", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, { "package.json": `{"x": "${TERM}"}\n`, "other.json": `{"x": "${TERM}"}\n` });
  const waived = allowFor(denylist, [{ rule: `digest:${denylist.id(TERM)}`, paths: ["package.json"], reason: "invented handle" }]);
  const result = scanTree({ root: dir, denylist: denylist.runtime, allow: waived });
  assert.deepEqual(result.findings.map((finding) => `${finding.path}=${finding.status}`), ["other.json=fail", "package.json=allowed"]);
  assert.deepEqual(result.stale, []);

  const wrongRule = allowFor(denylist, [{ rule: "email-any", paths: ["package.json"], reason: "a different rule" }]);
  assert.deepEqual(failing(scanTree({ root: dir, denylist: denylist.runtime, allow: wrongRule })).map(key), ["other.json:1:digest", "package.json:1:digest"]);
});

test("allow: waiving a digest also waives a digest hit inside its span, but not the same text elsewhere", (t) => {
  const denylist = makeDenylist([[HANDLE, "handle"], [NAME, "person"]]);
  const dir = tempDir(t);
  writeFiles(dir, { "package.json": `{"url": "https://example.test/${HANDLE}/x.git"}\nby ${NAME} himself\n` });
  const allow = allowFor(denylist, [{ rule: `digest:${denylist.id(HANDLE)}`, paths: ["package.json"], reason: "the maintainer handle" }]);
  const result = scanTree({ root: dir, denylist: denylist.runtime, allow });
  assert.deepEqual(result.findings.map((finding) => `${finding.line}:${finding.id === denylist.id(HANDLE) ? "handle" : "name"}=${finding.status}`), [
    "1:name=allowed",
    "1:handle=allowed",
    "2:name=fail",
  ]);
});

test("allow: an entry that waives nothing is stale, and a stale entry fails the run", (t) => {
  const denylist = makeDenylist([[TERM]]);
  const dir = tempDir(t);
  writeFiles(dir, { "clean.txt": "nothing here\n" });
  const allow = allowFor(denylist, [{ rule: `digest:${denylist.id(TERM)}`, paths: ["gone.txt"], reason: "once needed" }]);
  const result = scanTree({ root: dir, denylist: denylist.runtime, allow });
  assert.equal(result.stale.length, 1);
  assert.deepEqual(failing(result), []);

  const files = { denylist: path.join(dir, "d.json"), allow: path.join(dir, "a.json") };
  fs.writeFileSync(files.denylist, JSON.stringify(denylist.document));
  fs.writeFileSync(files.allow, JSON.stringify({ version: 1, entries: [{ rule: `digest:${denylist.id(TERM)}`, paths: ["gone.txt"], reason: "once needed" }] }));
  const run = cli(["--root", dir, "--denylist", files.denylist, "--allow", files.allow]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /allow\.json: entry 1 .* waived nothing/);
});

test("allow: every entry of the committed allow.json is used by the real tree", () => {
  const denylist = loadDenylist(REAL_DENYLIST, { allowEmpty: process.env.SDLC_LEAK_ALLOW_EMPTY === "1" });
  const allow = loadAllow(REAL_ALLOW, { denylist });
  for (const entry of allow) assert.ok(entry.reason.trim().length > 0);
  const stale = scanTree({ root: ROOT, denylist, allow }).stale;
  assert.deepEqual(stale.map(({ index, entry }) => `entry ${index + 1} (${entry.rule})`), []);
});

test("allow: a bad entry is a configuration error", () => {
  const denylist = makeDenylist([[TERM]]);
  const id = `digest:${denylist.id(TERM)}`;
  const entry = (overrides) => ({ rule: id, paths: ["package.json"], reason: "because", ...overrides });
  const bad = {
    "no reason": entry({ reason: undefined }),
    "a blank reason": entry({ reason: "   " }),
    "an unknown digest id": entry({ rule: "digest:d99" }),
    "an unknown rule": entry({ rule: "no-such-rule" }),
    "a report-only rule": entry({ rule: "soft:spec-ac-reference" }),
    "no paths": entry({ paths: [] }),
    "a glob": entry({ paths: ["src/*.mjs"] }),
    "an absolute path": entry({ paths: ["/package.json"] }),
    "a parent segment": entry({ paths: ["../package.json"] }),
    "an extra field": entry({ note: "x" }),
    "a mix of commit metadata and files": entry({ paths: ["commit:author", "package.json"] }),
    "an unknown commit path": entry({ paths: ["commit:tagger"] }),
  };
  for (const [label, candidate] of Object.entries(bad)) assert.throws(() => allowFor(denylist, [candidate]), /allow list:/, label);
  assert.throws(() => allowFor(denylist, [entry({}), entry({})]), /repeats/);
  assert.throws(() => parseAllow({ version: 2, entries: [] }, { denylist: denylist.runtime }), /version/);
});

test("allow: a digest rule is never waived under src, bin, schemas, prompts, examples or tests", () => {
  const denylist = makeDenylist([[TERM]]);
  const id = `digest:${denylist.id(TERM)}`;
  for (const dir of ["src", "bin", "schemas", "prompts", "examples", "tests"]) {
    assert.throws(() => allowFor(denylist, [{ rule: id, paths: [`${dir}/a/b.txt`], reason: "because" }]), /never allowed/, dir);
  }
  assert.doesNotThrow(() => allowFor(denylist, [{ rule: id, paths: ["package.json", "docs/readme.md"], reason: "because" }]));
  assert.doesNotThrow(() => allowFor(denylist, [{ rule: "secret-shape", paths: ["tests/s5/fixture.test.mjs"], lines: [3], reason: "a generic rule may be waived for a fixture" }]));
});

// ---------------------------------------------------------------------------------------------------------------------
// The allow list: lines
// ---------------------------------------------------------------------------------------------------------------------

test("allow: lines is a non-empty list of distinct positive integers, only for a file, and a secret-shape waiver must have it", () => {
  const denylist = makeDenylist([[TERM]]);
  const entry = (overrides) => ({ rule: "secret-shape", paths: ["tests/f.test.mjs"], lines: [3], reason: "because", ...overrides });
  const bad = {
    "lines that is not a list": entry({ lines: 3 }),
    "an empty list": entry({ lines: [] }),
    "a zero": entry({ lines: [0] }),
    "a negative number": entry({ lines: [-1] }),
    "a fraction": entry({ lines: [1.5] }),
    "a string": entry({ lines: ["3"] }),
    "a repeated line": entry({ lines: [3, 3] }),
    "lines for commit metadata": entry({ paths: ["commit:body"], lines: [1] }),
    "a secret-shape waiver for a file with no lines": entry({ lines: undefined }),
  };
  for (const [label, candidate] of Object.entries(bad)) assert.throws(() => allowFor(denylist, [candidate]), /allow list:/, label);
  assert.throws(() => allowFor(denylist, [entry({ lines: undefined })]), /names the lines/);
  const [parsed] = allowFor(denylist, [entry({ lines: [9, 3] })]);
  assert.deepEqual(parsed.lines, [9, 3]);
  const [digest] = allowFor(denylist, [{ rule: `digest:${denylist.id(TERM)}`, paths: ["package.json"], lines: [13], reason: "because" }]);
  assert.deepEqual(digest.lines, [13], "any rule may pin lines");
  assert.equal(allowFor(denylist, [{ rule: `digest:${denylist.id(TERM)}`, paths: ["package.json"], reason: "because" }])[0].lines, undefined, "and a waiver of another rule may leave them out");
  assert.doesNotThrow(() => allowFor(denylist, [{ rule: "secret-shape", paths: ["commit:body"], reason: "metadata has no lines to pin" }]));
});

test("allow: lines pin a waiver to those lines of the tree: another line of the file fails, and a pinned line that waives nothing is stale", (t) => {
  const denylist = makeDenylist([[TERM]]);
  const token = j("gh", "p_", TOKEN_BODY);
  const dir = tempDir(t);
  writeFiles(dir, { "tests/f.test.mjs": ["a", `x = "${token}"`, "b", `y = "${token}"`, "c", `z = "${token}"`, ""].join("\n") });
  const entry = (lines) => ({ rule: "secret-shape", paths: ["tests/f.test.mjs"], lines, reason: "an invented token" });
  const scan = (lines) => scanTree({ root: dir, denylist: denylist.runtime, allow: allowFor(denylist, [entry(lines)]) });

  const pinned = scan([2, 4]);
  assert.deepEqual(pinned.findings.map((finding) => `${finding.line}=${finding.status}`), ["2=allowed", "4=allowed", "6=fail"]);
  assert.deepEqual(pinned.stale, []);

  const partly = scan([2, 4, 6, 9, 12]);
  assert.deepEqual(failing(partly), []);
  assert.deepEqual(partly.stale.map(({ index, unusedLines }) => [index, unusedLines]), [[0, [9, 12]]], "the lines that waive nothing are named");

  const moved = scan([3]);
  assert.deepEqual(failing(moved).map((finding) => finding.line), [2, 4, 6], "the token is not on the pinned line");
  assert.deepEqual(moved.stale.map(({ index, unusedLines }) => [index, unusedLines]), [[0, undefined]], "and the pin that waives nothing at all is stale as a whole entry");

  const files = configFiles(tempDir(t, "config"), denylist, { version: 1, entries: [entry([2, 4, 6, 9, 12])] });
  const run = cli(["--tree", "--root", dir, ...files]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /^allow\.json: entry 1 \(rule=secret-shape paths=tests\/f\.test\.mjs\) waived nothing at line\(s\) 9, 12: remove them$/m);
  const whole = cli(["--tree", "--root", dir, ...configFiles(tempDir(t, "config2"), denylist, { version: 1, entries: [entry([3])] })]);
  assert.match(whole.stdout, /^allow\.json: entry 1 \(rule=secret-shape paths=tests\/f\.test\.mjs\) waived nothing: remove it$/m);
});

test("allow: the history cannot know where a line was in an earlier commit, so lines do not narrow a waiver there, and are not stale there", async (t) => {
  const denylist = makeDenylist([[TERM]]);
  const token = j("gh", "p_", TOKEN_BODY);
  const repo = initRepo(t);
  writeFiles(repo, { "tests/f.test.mjs": `a\nb\nc\nd\n${token}\n` });
  commitAll(repo, "add a token-shaped constant at line 5");
  const waived = allowFor(denylist, [{ rule: "secret-shape", paths: ["tests/f.test.mjs"], lines: [99], reason: "an invented token" }]);
  const result = await scanHistory({ root: repo, denylist: denylist.runtime, allow: waived });
  assert.deepEqual(failing(result), []);
  assert.deepEqual(result.findings.map((finding) => `${finding.line}=${finding.status}`), ["5=allowed"]);
  assert.deepEqual(result.stale, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// History mode
// ---------------------------------------------------------------------------------------------------------------------

test("history: every added and removed line, the commit message and the authors are scanned", async (t) => {
  const { runtime, id } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": `clean\n${j("C:", BS, "Users", BS, "alice")}\n`, "sp ace.txt": `x\r\nsee ${TERM}\r\n` });
  const first = commitAll(repo, "first");
  writeFiles(repo, { "a.txt": `clean\nmore\n${TERM}\n` });
  const second = commitAll(repo, `second ${TERM}\n\nbody mentions ${TERM}`);
  writeFiles(repo, { "b.txt": "b\n" });
  const third = commitAll(repo, "third", { name: `Name ${TERM}`, email: "author@example.com" });
  writeFiles(repo, { "a.txt": "clean\n" });
  const fourth = commitAll(repo, "fourth");

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.commits, 4);
  const at = (sha) => sha.slice(0, 7);
  const digest = id(TERM);
  const rows = failing(result).map((finding) => `${at(finding.commit)} ${key(finding)}${finding.id ? `=${finding.id}` : ""}`).sort();
  assert.deepEqual(
    rows,
    [
      `${at(first)} a.txt:2:home-path-win:added`,
      `${at(first)} sp ace.txt:2:digest:added=${digest}`,
      `${at(second)} a.txt:2:home-path-win:removed`,
      `${at(second)} a.txt:3:digest:added=${digest}`,
      `${at(second)} commit:body:1:digest=${digest}`,
      `${at(second)} commit:subject:1:digest=${digest}`,
      `${at(third)} commit:author:1:digest=${digest}`,
      `${at(third)} commit:committer:1:digest=${digest}`,
      `${at(fourth)} a.txt:3:digest:removed=${digest}`,
    ].sort(),
  );
});

test("history: a leak that a later commit removes is still found, on the removed side", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": `keep\n${TERM}\n` });
  commitAll(repo, "add");
  writeFiles(repo, { "a.txt": "keep\n" });
  commitAll(repo, "remove");
  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(failing(result).map(key).sort(), ["a.txt:2:digest:added", "a.txt:2:digest:removed"]);
  assert.deepEqual(failing(await scanTree({ root: repo, denylist: runtime, allow: NO_ALLOW })), [], "the tree is clean while the history is not");
});

test("history: a line that exists only in a merge resolution is scanned", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "m.txt": "base\n" });
  commitAll(repo, "base");
  git(repo, ["checkout", "-q", "-b", "side"]);
  writeFiles(repo, { "m.txt": "side\n" });
  commitAll(repo, "side");
  git(repo, ["checkout", "-q", "main"]);
  writeFiles(repo, { "m.txt": "main\n" });
  commitAll(repo, "main");
  assert.throws(() => git(repo, ["merge", "--no-edit", "side"]), /./, "the merge conflicts");
  writeFiles(repo, { "m.txt": `${TERM}\n` });
  git(repo, ["add", "m.txt"]);
  git(repo, ["commit", "-q", "--no-edit"]);
  const merge = git(repo, ["rev-parse", "HEAD"]).trim();

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.deepEqual(failing(result).map((finding) => `${finding.commit === merge ? "merge" : "other"} ${key(finding)}`), ["merge m.txt:1:digest:added"]);
});

test("history: an empty repository has no commits and no findings", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const result = await scanHistory({ root: initRepo(t), denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.commits, 0);
  assert.deepEqual(result.findings, []);
});

test("history: commit:author and commit:committer entries waive the identity lines, and a stale one is reported", async (t) => {
  const denylist = makeDenylist([[HANDLE, "handle"], [NAME, "person"]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, `subject ${HANDLE}`, { name: HANDLE, email: `1+${HANDLE}@users.noreply.github.com` });
  const handle = `digest:${denylist.id(HANDLE)}`;

  const identity = allowFor(denylist, [{ rule: handle, paths: ["commit:author", "commit:committer"], reason: "the commit identity" }]);
  const result = await scanHistory({ root: repo, denylist: denylist.runtime, allow: identity });
  assert.deepEqual(failing(result).map(key).sort(), ["commit:subject:1:digest", "commit:subject:1:digest"], "the subject is scanned like any other text");
  assert.deepEqual(result.stale, []);

  const unused = allowFor(denylist, [{ rule: handle, paths: ["commit:committer"], reason: "x" }, { rule: handle, paths: ["commit:body"], reason: "never used" }]);
  const second = await scanHistory({ root: repo, denylist: denylist.runtime, allow: unused });
  assert.deepEqual(second.stale.map(({ index }) => index), [1], "only the entry that waived nothing is stale");
});

// ---------------------------------------------------------------------------------------------------------------------
// History mode: tags (a tag object has a name, a tagger and a message that `git log` never shows)
// ---------------------------------------------------------------------------------------------------------------------

/** An annotated tag with `message`, made by `identity` (the committer of the environment is the tagger); returns the id of the tag object. */
function tagAnnotated(dir, name, message, identity, target = []) {
  git(dir, ["-c", "tag.gpgsign=false", "-c", "advice.nestedTag=false", "tag", "-a", name, "-m", message, ...target], identity);
  return git(dir, ["rev-parse", `refs/tags/${name}`]).trim();
}

test("history: the name, tagger and message of an annotated tag are scanned, though every commit is clean", async (t) => {
  const { runtime, id } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  const object = tagAnnotated(repo, `rel-${TERM}`, `release notes\n\nsee ${TERM} for details`, { name: `Tagger ${TERM}`, email: "tagger@example.com" });

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.commits, 1);
  assert.equal(result.tags, 1);
  const digest = id(TERM);
  assert.deepEqual(
    failing(result).map((finding) => `${key(finding)}=${finding.id} ${finding.tag === object ? "tag object" : "other"}`).sort(),
    [`tag:message:3:digest=${digest} tag object`, `tag:name:1:digest=${digest} tag object`, `tag:tagger:1:digest=${digest} tag object`],
    "the message line is numbered from the start of the message",
  );
});

test("history: the name of a lightweight tag is scanned, and the finding names the commit that the tag points at", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  const head = commitAll(repo, "a clean commit");
  git(repo, ["tag", `light-${TERM}`]);

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.tags, 0, "a lightweight tag has no object of its own");
  assert.deepEqual(failing(result).map((finding) => `${key(finding)} ${finding.tag === head}`), ["tag:name:1:digest true"]);
});

test("history: a tag that points at another tag is followed, so a leak in the inner object is found after the inner ref is gone", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  const inner = tagAnnotated(repo, "inner", `inner message ${TERM}`);
  const outer = tagAnnotated(repo, "outer", "a clean message", {}, ["inner"]);
  git(repo, ["tag", "-d", "inner"]);
  assert.match(git(repo, ["cat-file", "tag", outer]), /^type tag$/m, "the outer tag points at a tag object");

  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.tags, 2, "both tag objects");
  assert.deepEqual(failing(result).map((finding) => `${key(finding)} ${finding.tag === inner ? "inner" : "outer"}`), ["tag:message:1:digest inner"]);
});

test("history: a tag object that two refs name is scanned once, each ref name is scanned, and clean tags give no finding", async (t) => {
  const { runtime } = makeDenylist([[TERM]]);
  const clean = initRepo(t, "clean");
  writeFiles(clean, { "a.txt": "clean\n" });
  commitAll(clean, "a clean commit");
  tagAnnotated(clean, "v1", "release one");
  tagAnnotated(clean, "v2", "release two");
  git(clean, ["tag", "light"]);
  const cleanResult = await scanHistory({ root: clean, denylist: runtime, allow: NO_ALLOW });
  assert.equal(cleanResult.tags, 2, "the two annotated tags are counted, the lightweight one is not");
  assert.deepEqual(cleanResult.findings, []);

  const repo = initRepo(t, "alias");
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  const object = tagAnnotated(repo, "v1", `message ${TERM}`);
  git(repo, ["update-ref", `refs/tags/alias-${TERM}`, object]);
  const result = await scanHistory({ root: repo, denylist: runtime, allow: NO_ALLOW });
  assert.equal(result.tags, 1, "one tag object");
  assert.deepEqual(failing(result).map(key).sort(), ["tag:message:1:digest", "tag:name:1:digest"], "the message once, and the name of the alias ref");
});

test("allow: tag:name, tag:tagger and tag:message are history paths, valid alone or beside commit paths and never beside files; commit:tagger stays unknown", () => {
  const denylist = makeDenylist([[TERM]]);
  const rule = `digest:${denylist.id(TERM)}`;
  for (const metadata of ["tag:name", "tag:tagger", "tag:message"]) {
    const [entry] = allowFor(denylist, [{ rule, paths: [metadata], reason: "because" }]);
    assert.equal(entry.scope, "history", metadata);
  }
  const [identity] = allowFor(denylist, [{ rule, paths: ["commit:author", "commit:committer", "tag:tagger"], reason: "the identity" }]);
  assert.equal(identity.scope, "history");
  assert.throws(() => allowFor(denylist, [{ rule, paths: ["tag:tagger", "package.json"], reason: "because" }]), /mixes commit or tag metadata and file paths/);
  assert.throws(() => allowFor(denylist, [{ rule, paths: ["tag:subject"], reason: "because" }]), /unknown commit or tag path/);
  assert.throws(() => allowFor(denylist, [{ rule, paths: ["commit:tagger"], reason: "because" }]), /unknown commit or tag path/);
});

test("history: a tag:tagger entry waives the tagger identity and nothing else of the tag, and an entry that waives nothing is stale", async (t) => {
  const denylist = makeDenylist([[HANDLE, "handle"], [NAME, "person"]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  tagAnnotated(repo, "v1", `released by ${HANDLE}`, { name: HANDLE, email: `1+${HANDLE}@users.noreply.github.com` });
  const handle = `digest:${denylist.id(HANDLE)}`;

  const identity = allowFor(denylist, [{ rule: handle, paths: ["tag:tagger"], reason: "the tagger identity" }]);
  const result = await scanHistory({ root: repo, denylist: denylist.runtime, allow: identity });
  assert.deepEqual(failing(result).map(key).sort(), ["tag:message:1:digest", "tag:message:1:digest"], "the message is scanned like any other text");
  assert.deepEqual(result.stale, []);

  const unused = allowFor(denylist, [{ rule: handle, paths: ["tag:tagger"], reason: "used" }, { rule: handle, paths: ["tag:name"], reason: "never used" }]);
  const second = await scanHistory({ root: repo, denylist: denylist.runtime, allow: unused });
  assert.deepEqual(second.stale.map(({ index }) => index), [1], "only the entry that waived nothing is stale");
});

test("output: a finding in a tag names the tag object by its id, and the output never holds the tag's name, tagger or message; a tag-only leak fails --history and passes --tree", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  writeFiles(repo, { "b.txt": "clean\n" });
  commitAll(repo, "another clean commit");
  const object = tagAnnotated(repo, `rel-${TERM}`, `notes about ${TERM} and ${j("C:", BS, "Users", BS, "qzxwvu")}`, { name: `Tagger ${TERM}`, email: j("qzxwvu", "@", "zz-corp.net") });
  const flags = configFiles(tempDir(t, "config"), denylist);

  assert.equal(cli(["--tree", "--root", repo, ...flags]).code, 0, "no file holds the leak, so the tree is clean");
  const history = cli(["--history", "--root", repo, ...flags]);
  assert.equal(history.code, 1);
  const lines = history.stdout.split("\n").filter((line) => line.startsWith("tag:"));
  assert.ok(lines.length >= 5, `name, tagger (name and address) and message are reported: ${lines.length} lines`);
  for (const line of lines) {
    assert.match(line, /^tag:(?:name|tagger|message):\d+:\d+-\d+ rule=[a-z-]+(?: id=d\d+ category=\w+)? tag=[0-9a-f]{10}$/, "a position, a rule and the tag object, nothing else");
    assert.ok(line.endsWith(` tag=${object.slice(0, 10)}`), "the tag object is named by the first ten characters of its id");
  }
  for (const text of [TERM, "zz_leak_term", "zzleakterm", "qzxwvu", "zz-corp"]) assert.ok(!history.output.toLowerCase().includes(text), `the output must not contain ${text.length} characters of a matched text`);
  assert.match(history.stdout, /\(2 commits and 1 annotated tags scanned\)/);
});

test("report: tag findings are counted under their own heading, and the header counts the annotated tags", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  writeFiles(repo, { "b.txt": "clean\n" });
  commitAll(repo, "another clean commit");
  tagAnnotated(repo, "v1", `notes ${TERM}`, { name: `Tagger ${TERM}`, email: "tagger@example.com" });
  const report = cli(["--history", "--report", "--root", repo, ...configFiles(tempDir(t, "config"), denylist)]);
  assert.equal(report.code, 0);
  assert.match(report.stdout, /^leak-guard report \(history\): 2 commits, 1 annotated tags$/m);
  assert.match(report.stdout, /^ {2}\(tag metadata\)\s+digest=2$/m);
  assert.ok(!report.output.includes(TERM));
});

test("history: a waived tagger identity in one tag does not waive a nested hit in the tagger of another tag", async (t) => {
  const denylist = makeDenylist([[HANDLE, "handle"], [NAME, "person"]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "a clean commit");
  tagAnnotated(repo, "v1", "release one", { name: HANDLE, email: `1+${HANDLE}@users.noreply.github.com` });
  const other = tagAnnotated(repo, "v2", "release two", { name: NAME, email: "tagger@example.com" });
  const allow = allowFor(denylist, [{ rule: `digest:${denylist.id(HANDLE)}`, paths: ["tag:tagger"], reason: "the tagger identity" }]);

  const result = await scanHistory({ root: repo, denylist: denylist.runtime, allow });
  assert.deepEqual(failing(result).map((finding) => `${key(finding)} ${finding.tag === other ? "v2" : "v1"}`), ["tag:tagger:1:digest v2"], "the name in the second tag is not inside any waived span of its own tag");
});

test("masker: a pseudo-path of commit or tag metadata is never rewritten, even when its text would match the denylist", () => {
  const denylist = makeDenylist([["tag:message"]]);
  const mask = createMasker(denylist.runtime);
  assert.equal(mask("tag:message"), "tag:message");
  assert.equal(mask("docs/tag-message.txt"), "docs/***********.txt", "the same text in a file path is masked");
});

test("parseTagObject: the headers, the tagger without its time stamp, and the message after the first empty line", () => {
  const parsed = parseTagObject(["object 0123", "type commit", "tag v1", "tagger A Person <p@example.com> 1700000000 +0100", "", "first line", "", "third line"]);
  assert.deepEqual(parsed, { object: "0123", type: "commit", name: "v1", tagger: "A Person <p@example.com>", message: ["first line", "", "third line"] });
  assert.deepEqual(parseTagObject(["object 0123", "type commit", "tag v1"]), { object: "0123", type: "commit", name: "v1", tagger: null, message: [] }, "no tagger, no message");
  assert.equal(parseTagObject(["tagger Only Name <> 1 +0000", "", "tagger not a header"]).tagger, "Only Name <>", "only the headers are read, not the message");
});

// ---------------------------------------------------------------------------------------------------------------------
// The scanner never prints what it found
// ---------------------------------------------------------------------------------------------------------------------

function plantedMatches(dir, result) {
  const texts = [];
  for (const finding of result.findings.filter((candidate) => candidate.status === "fail")) {
    if (finding.line === 0) {
      texts.push(finding.path.slice(finding.start - 1, finding.end));
    } else if (!finding.path.startsWith("commit:")) {
      const lines = fs.readFileSync(path.join(dir, ...finding.path.split("/")), "utf8").split("\n");
      texts.push(lines[finding.line - 1].replace(/\r$/, "").slice(finding.start - 1, finding.end));
    }
  }
  return texts;
}

test("output: no line of a failing run contains the text it matched, in content or in a path", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, {
    "src/win.mjs": `// ${j("C:", BS, "Users", BS, "qzxwvu", BS, "x")}\n`,
    "src/posix.mjs": `const p = "${j("/home/", "qzxwvu")}";\n`,
    "src/mail.txt": `${j("qzxwvu", "@", "zz-corp.net")} and ${j("qzxwvu", "@", "microsoft", ".com")}\n`,
    "src/host.txt": `${j("https://qzxwvu.visual", "studio.com/feed")}\n`,
    "src/secret.mjs": `const t = "${j("gh", "p_", "QzXwVuTs1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p")}";\n${j("-----BEGIN ", "RSA PRIVATE KEY-----")}\n`,
    "src/run.mjs": `// ${j("workflow run ", RUN_NUMBER)}\n`,
    "src/session.txt": `${j("session", "-state/", "a1b2c3d4-e5f6-4a7b")}\n`,
    "src/guid.txt": `${j("123e4567-", "e89b-42d3-a456-426614174000")}\n`,
    "src/digest.md": `see ${TERM} and ZZ_LEAK_TERM\n`,
    [`docs/${TERM}-notes.txt`]: `about ${TERM}\n`,
    "src/ref.md": `${j("see plan", ".md and issue #", "12")}\n`,
  });
  const config = tempDir(t, "config");
  const flags = configFiles(config, denylist);
  const result = scanTree({ root: dir, denylist: denylist.runtime, allow: NO_ALLOW });
  const rules = new Set(failing(result).map((finding) => finding.rule));
  for (const expected of ["home-path-win", "home-path-posix", "microsoft-email", "email-any", "internal-host", "secret-shape", "run-id-in-comment", "session-state-path", "guid", "digest", "plan-md-reference", "issue-or-pr-number"]) {
    assert.ok(rules.has(expected), `the fixture exercises ${expected}`);
  }

  const forbidden = [...plantedMatches(dir, result), "qzxwvu", "QzXwVuTs", TERM, "zz_leak_term", "zzleakterm"];
  assert.ok(forbidden.every((text) => text.length >= 4));
  const tree = cli(["--tree", "--root", dir, ...flags]);
  assert.equal(tree.code, 1);
  assert.match(tree.stdout, / rule=/);
  const report = cli(["--report", "--root", dir, ...flags]);
  assert.equal(report.code, 0);
  assert.match(report.stdout, /^secret-shape\s+hard/m);
  for (const [label, run] of [["--tree", tree], ["--report", report]]) {
    for (const text of forbidden) {
      assert.ok(!run.output.toLowerCase().includes(text.toLowerCase()), `the output of ${label} must not contain a matched text (${text.length} characters of it)`);
    }
  }
});

test("output: a path that is itself the leak is masked, not printed", (t) => {
  const denylist = makeDenylist([[TERM]]);
  const mask = createMasker(denylist.runtime);
  assert.equal(mask(`docs/${TERM}-notes.txt`), "docs/************-notes.txt");
  assert.equal(mask("src/ordinary.mjs"), "src/ordinary.mjs");
  assert.equal(mask("commit:author"), "commit:author");

  const dir = tempDir(t);
  writeFiles(dir, { [`${TERM}-notes.txt`]: `about ${TERM}\n` });
  const lines = formatRun(scanTree({ root: dir, denylist: denylist.runtime, allow: NO_ALLOW }), mask);
  assert.deepEqual(lines.slice(0, 2), [
    `************-notes.txt:0:1-12 rule=digest id=${denylist.id(TERM)} category=other`,
    `************-notes.txt:1:7-18 rule=digest id=${denylist.id(TERM)} category=other`,
  ]);
});

test("output: a failing history run prints no matched text either", async (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": `x\n${TERM}\n${j("C:", BS, "Users", BS, "qzxwvu")}\n`, [`${TERM}.txt`]: "x\n" });
  commitAll(repo, `message ${TERM}`, { name: `Person ${TERM}`, email: "p@example.com" });
  writeFiles(repo, { "a.txt": "x\n" });
  commitAll(repo, "cleanup");
  const dir = tempDir(t, "config");
  writeFiles(dir, { "denylist.json": JSON.stringify(denylist.document), "allow.json": JSON.stringify({ version: 1, entries: [] }) });
  const run = cli(["--history", "--root", repo, "--denylist", path.join(dir, "denylist.json"), "--allow", path.join(dir, "allow.json")]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /side=added/);
  assert.match(run.stdout, /side=removed/);
  for (const text of [TERM, "zz_leak_term", "zzleakterm", "qzxwvu"]) assert.ok(!run.output.toLowerCase().includes(text), `the output must not contain ${text.length} characters of a matched text`);
});

test("output: a digest finding names an id and a category and nothing else", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const dir = tempDir(t);
  writeFiles(dir, { "a.txt": `see ${TERM}\n` });
  const lines = formatRun(scanTree({ root: dir, denylist: denylist.runtime, allow: NO_ALLOW }), createMasker(denylist.runtime));
  assert.equal(lines[0], `a.txt:1:5-16 rule=digest id=${denylist.id(TERM)} category=handle`);
  assert.match(lines.at(-1), /^leak-guard tree: 1 failing finding\(s\) in 1 file\(s\), 0 allowed, 0 stale allow entries \(1 text files scanned, 0 binary scanned for strings\); 0 report-only finding\(s\); FAILED$/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------------------------------

function configFiles(dir, denylist, allow = { version: 1, entries: [] }) {
  writeFiles(dir, { "denylist.json": JSON.stringify(denylist.document), "allow.json": JSON.stringify(allow) });
  return ["--denylist", path.join(dir, "denylist.json"), "--allow", path.join(dir, "allow.json")];
}

test("cli: exit 0 on a clean tree, 1 on findings, 2 on a usage or configuration error; --report always exits 0", (t) => {
  const denylist = makeDenylist([[TERM]]);
  const config = tempDir(t, "config");
  const flags = configFiles(config, denylist);
  const clean = tempDir(t, "clean");
  writeFiles(clean, { "a.txt": "nothing\n" });
  const dirty = tempDir(t, "dirty");
  writeFiles(dirty, { "a.txt": `${TERM}\n` });

  assert.equal(cli(["--root", clean, ...flags]).code, 0);
  const failed = cli(["--root", dirty, ...flags]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^a\.txt:1:1-12 rule=digest id=d01 category=other$/m);
  const report = cli(["--report", "--root", dirty, ...flags]);
  assert.equal(report.code, 0);
  assert.match(report.stdout, /^digest\s+hard\s+1\s+0\s+1\s+1$/m);
  assert.match(report.stdout, /^ {2}\(root\)\s+digest=1$/m);

  assert.equal(cli(["--bogus"]).code, 2);
  assert.equal(cli(["--root", path.join(clean, "missing"), ...flags]).code, 2);
  assert.equal(cli(["--root"]).code, 2);
  assert.equal(cli(["--help"]).code, 0);
  const both = cli(["--tree", "--history", "--root", clean, ...flags]);
  assert.equal(both.code, 2, "--history needs a git repository");
  assert.match(both.stderr, /git log failed/);
});

test("cli: an empty denylist is an error, and only SDLC_LEAK_ALLOW_EMPTY=1 lets a development job continue", (t) => {
  const config = tempDir(t, "config");
  const empty = { document: { version: 1, prefix: "sdlc-leak-v1:", maxWindow: 8, digests: {} } };
  const flags = configFiles(config, empty);
  const clean = tempDir(t, "clean");
  writeFiles(clean, { "a.txt": "nothing\n" });
  const refused = cli(["--root", clean, ...flags]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /denylist is empty/);
  assert.equal(cli(["--report", "--root", clean, ...flags]).code, 2, "--report does not bypass it either");
  assert.equal(cli(["--root", clean, ...flags], { env: { SDLC_LEAK_ALLOW_EMPTY: "1" } }).code, 0);
});

test("cli: --tree and --history run together and both must pass", (t) => {
  const denylist = makeDenylist([[TERM]]);
  const config = tempDir(t, "config");
  const flags = configFiles(config, denylist);
  const repo = initRepo(t);
  writeFiles(repo, { "a.txt": `${TERM}\n` });
  commitAll(repo, "add");
  writeFiles(repo, { "a.txt": "clean\n" });
  commitAll(repo, "clean up");
  const run = cli(["--tree", "--history", "--root", repo, ...flags]);
  assert.equal(run.code, 1, "the tree is clean but the history is not");
  assert.match(run.stdout, /^leak-guard tree: 0 failing/m);
  assert.match(run.stdout, /^leak-guard history: 2 failing/m);
});

test("cli: main() can be called in process with its own streams", async (t) => {
  const denylist = makeDenylist([[TERM]]);
  const config = tempDir(t, "config");
  const flags = configFiles(config, denylist);
  const dirty = tempDir(t, "dirty");
  writeFiles(dirty, { "a.txt": `${TERM}\n` });
  const { sink, io } = inMemoryIo();
  assert.equal(await scanMain(["--root", dirty, ...flags], io), 1);
  assert.match(sink.out, /rule=digest/);
  assert.equal(sink.err, "");
});

test("report: counts per rule, per top-level directory and per category, and never a finding's text", (t) => {
  const denylist = makeDenylist([[TERM, "handle"]]);
  const config = tempDir(t, "config");
  const flags = configFiles(config, denylist);
  const dir = tempDir(t);
  writeFiles(dir, {
    "src/a.mjs": `// ${j("SPEC-", "01")} and ${j("C:", BS, "Users", BS, "alice")}\n// ${TERM}\n`,
    "tests/b.test.mjs": `// ${j("A", "C12")} ${TERM}\n// ${j("A", "C13")}\n`,
    "root.txt": `${TERM}\n`,
  });
  const run = cli(["--report", "--root", dir, ...flags]);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^digest\s+hard\s+3\s+0\s+3\s+3$/m, "three findings on three lines in three files");
  assert.match(run.stdout, /^home-path-win\s+hard\s+1\s+0\s+1\s+1$/m);
  assert.match(run.stdout, /^soft:spec-ac-reference\s+soft\s+3\s+0\s+3\s+2$/m);
  assert.match(run.stdout, /digest findings by category: handle=3/);
  assert.match(run.stdout, /^ {2}src\s+digest=1 home-path-win=1 soft:spec-ac-reference=1$/m);
  assert.match(run.stdout, /^ {2}tests\s+digest=1 soft:spec-ac-reference=2$/m);
  assert.match(run.stdout, /^ {2}\(root\)\s+digest=1$/m);
  assert.match(run.stdout, /^ +2 {2}tests\/b\.test\.mjs$/m, "report-only findings are counted per file");
  assert.ok(!run.output.includes(TERM));
});

// ---------------------------------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------------------------------

test("generator: it writes digests only, sorted, the same bytes every time, and keeps ids when the list changes", async (t) => {
  const dir = tempDir(t, "gen");
  const out = path.join(dir, "denylist.json");
  const terms = path.join(dir, "terms.txt");
  const run = async (lines) => {
    fs.writeFileSync(terms, `${lines.join("\n")}\n`);
    const { sink, io } = inMemoryIo();
    const code = await makeDigests(["--terms", terms, "--out", out], io);
    return { code, text: fs.readFileSync(out, "utf8"), sink };
  };
  const base = [`${TERM}\thandle`, "zz-other-term\torg", "ZZ Third Term\tperson", "zz-fourth-term\trepo", "zz-fifth-term\tapp", "zz-sixth-term\tother"];

  const first = await run(["# a comment", "", ...base]);
  assert.equal(first.code, 0);
  const document = JSON.parse(first.text);
  assert.deepEqual(Object.keys(document), ["version", "prefix", "maxWindow", "digests"]);
  assert.deepEqual(Object.keys(document.digests), Object.keys(document.digests).sort());
  assert.deepEqual(Object.values(document.digests).map((entry) => entry.category).sort(), ["app", "handle", "org", "other", "person", "repo"]);
  assert.ok(!/zz|third|fourth|fifth|sixth/i.test(first.text), "the file holds hex digests, ids and categories, not terms");
  assert.ok(!/zz-|third|fourth|fifth|sixth/i.test(first.sink.out + first.sink.err), "the generator prints counts and positions, never a term");
  assert.equal((await run(["# a comment", "", ...base])).text, first.text, "same input, same bytes");

  // A new term whose digest sorts before all the others would renumber everything if ids followed the sort order.
  const before = Object.fromEntries(Object.entries(document.digests).map(([digest, entry]) => [digest, entry.id]));
  const newTerm = Array.from({ length: 500 }, (_, index) => `zz-new-term-${index}`).find((term) => digestOfTerm(term) < Object.keys(before)[0]);
  assert.ok(newTerm, "a term that sorts first exists");
  const second = JSON.parse((await run([`${newTerm}\tother`, ...base])).text);
  for (const [digest, id] of Object.entries(before)) assert.equal(second.digests[digest].id, id, "an existing digest keeps its id");
  assert.deepEqual(Object.entries(second.digests).filter(([digest]) => !(digest in before)).map(([, entry]) => entry.id), ["d07"]);

  const third = JSON.parse((await run([`${TERM}\thandle`, "zz-other-term\torg"])).text);
  assert.equal(Object.keys(third.digests).length, 2, "a term removed from the file is removed from the denylist");

  fs.writeFileSync(out, "{ not json");
  const { sink, io } = inMemoryIo();
  assert.equal(await makeDigests(["--terms", terms, "--out", out], io), 2, "a damaged output is not silently renumbered");
  assert.match(sink.err, /not a valid denylist/);
});

test("generator: it refuses short terms, common words, the engine's own name and bad categories, and says where, not what", () => {
  const entries = [
    { term: "abc", category: "other", label: "terms:1" },
    { term: "portfolio", category: "repo", label: "terms:2" },
    { term: "ai-sdlc-factory", category: "repo", label: "terms:3" },
    { term: "---", category: "other", label: "terms:4" },
    { term: "zz-ok-term", category: "other", label: "terms:5" },
    { term: "ZZ OK TERM", category: "org", label: "terms:6" },
    { term: "zz-ok-owner/portfolio", category: "repo", label: "terms:7" },
    { term: "docs-config", category: "repo", label: "terms:8" },
  ];
  const built = buildDenylist(entries);
  assert.equal(built.accepted, 2, "the term and the qualified name are kept; the spelling duplicate is folded");
  assert.equal(built.duplicates, 1);
  assert.deepEqual(built.refused.map((item) => item.label), ["terms:1", "terms:2", "terms:3", "terms:4", "terms:8"]);
  for (const item of built.refused) assert.ok(!/abc|portfolio|sdlc|docs|config/.test(item.reason), "a reason never quotes the term");
  assert.equal(refusalFor("portfolio"), "only common words (use the qualified owner/name form)");
  assert.equal(refusalFor("docs-config"), "only common words (use the qualified owner/name form)", "two common words are still common text");
  assert.equal(refusalFor("zz-ok-owner/portfolio"), null);
  assert.equal(refusalFor("docs-config-zz"), null, "a third, uncommon token makes it specific");
  assert.deepEqual(parseTerms("zz-term-one\tnonsense\nzz-term-two\tapp\n", "terms").problems, [{ label: "terms:1", reason: "unknown category" }]);
  const tooLong = buildDenylist([{ term: Array.from({ length: 17 }, (_, index) => `t${index}x`).join("-"), category: "other", label: "terms:9" }]);
  assert.equal(tooLong.accepted, 0);
  assert.deepEqual(tooLong.refused, [{ label: "terms:9", reason: "more than 16 tokens" }]);
});

const EMAIL_REFUSAL = "email address (covered by email-any and microsoft-email rules)";

test("generator: it refuses an e-mail address, because the prefix is public and a digest of an address would let anyone confirm a candidate offline", async (t) => {
  const own = j("zz-person", "@", "zz-corp.net");
  const company = j("zz.person", "@", "microsoft", ".com");
  assert.equal(refusalFor(own), EMAIL_REFUSAL);
  assert.equal(refusalFor(company), EMAIL_REFUSAL);
  assert.equal(refusalFor(j("zz-person", "@", "x")), EMAIL_REFUSAL, "an at sign anywhere refuses the term, whatever follows it");
  assert.equal(refusalFor("zz-person-no-address"), null, "a term without an at sign is not affected");

  const built = buildDenylist([
    { term: own, category: "person", label: "terms:1" },
    { term: TERM, category: "handle", label: "terms:2" },
    { term: company, category: "other", label: "terms:3" },
  ]);
  assert.equal(built.accepted, 1);
  assert.deepEqual(built.refused, [{ label: "terms:1", reason: EMAIL_REFUSAL }, { label: "terms:3", reason: EMAIL_REFUSAL }]);
  for (const address of [own, company]) assert.ok(!(digestOfTerm(address) in built.document.digests), "no digest of an address is written");

  // the command line says where the refused term is and why, and never what it is
  const dir = tempDir(t, "gen");
  writeFiles(dir, { "terms.txt": `${TERM}\thandle\n${own}\tperson\n${company}\tother\n` });
  const out = path.join(dir, "denylist.json");
  const { sink, io } = inMemoryIo();
  assert.equal(await makeDigests(["--terms", path.join(dir, "terms.txt"), "--out", out], io), 0, sink.err);
  assert.match(sink.out, /refused: 2/);
  assert.match(sink.out, new RegExp(`refused terms\\.txt:2: ${EMAIL_REFUSAL.replace(/[()]/g, "\\$&")}`));
  assert.match(sink.out, new RegExp(`refused terms\\.txt:3: ${EMAIL_REFUSAL.replace(/[()]/g, "\\$&")}`));
  assert.ok(!/zz-person|zz\.person|zz-corp/i.test(sink.out + sink.err), "the output holds no part of a refused address");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out, "utf8")).digests), [digestOfTerm(TERM)]);
});

test("generator: it harvests owners, qualified and bare repository names, reviewers and the App slug, but not project keys", () => {
  const manifest = {
    projects: [{ projectKey: "zz-project-key", repo: "zz-org-one/zz-repo-one" }],
    dependencyEdges: [{ upstreamRepo: "zz-org-two/zz-repo-two", downstreamRepo: "zz-org-one/zz-repo-one", reviewers: ["@zz-reviewer-name"], branchName: "sdlc/zz-branch" }],
  };
  const entries = [...harvestManifest(manifest), ...harvestRequest({ appSlug: "zz-app-slug-name" })];
  const { document } = buildDenylist(entries);
  const has = (term) => digestOfTerm(term) in document.digests;
  for (const term of ["zz-org-one", "zz-org-two", "zz-org-one/zz-repo-one", "zz-org-two/zz-repo-two", "zz-repo-one", "zz-repo-two", "zz-reviewer-name", "zz-app-slug-name"]) {
    assert.ok(has(term), `harvested ${term.length} characters`);
  }
  assert.ok(!has("zz-project-key"), "a projectKey is a generic word and is not harvested");
  assert.ok(!has("zz-branch"));
  const categories = Object.fromEntries(Object.entries(document.digests).map(([digest, entry]) => [digest, entry.category]));
  assert.equal(categories[digestOfTerm("zz-reviewer-name")], "handle");
  assert.equal(categories[digestOfTerm("zz-app-slug-name")], "app");
  assert.equal(categories[digestOfTerm("zz-org-one")], "org");
});

test("generator: the command line reads a manifest and a request, and refuses an input inside the repository", async (t) => {
  const dir = tempDir(t, "gen");
  writeFiles(dir, {
    "sdlc.yaml": "projects:\n  - projectKey: zz-project-key\n    repo: zz-org-one/zz-repo-one\ndependencyEdges:\n  - reviewers: [zz-reviewer-name]\n",
    "request.json": JSON.stringify({ appSlug: "zz-app-slug-name" }),
    "terms.txt": `${TERM}\thandle\n`,
  });
  const out = path.join(dir, "out", "denylist.json");
  const { sink, io } = inMemoryIo();
  const code = await makeDigests(["--from-manifest", path.join(dir, "sdlc.yaml"), "--from-request", path.join(dir, "request.json"), "--terms", path.join(dir, "terms.txt"), "--out", out], io);
  assert.equal(code, 0, sink.err);
  const document = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(Object.keys(document.digests).length, 6);
  assert.match(sink.out, /by category: app=1 handle=2 org=1 repo=2/);

  for (const [args, pattern] of [
    [["--terms", path.join(ROOT, "package.json")], /inside this repository/],
    [["--from-manifest", path.join(ROOT, "tools", "leak-guard", "terms.txt")], /inside this repository/],
    [[], /at least one of/],
    [["--terms", path.join(dir, "terms.txt"), "--max-window", "99"], /--max-window/],
    [["--terms", path.join(dir, "terms.txt"), "--nope"], /unknown argument/],
  ]) {
    const failure = inMemoryIo();
    assert.equal(await makeDigests([...args, "--out", out], failure.io), 2);
    assert.match(failure.sink.err, pattern);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------------------------------------------------

const enforceTree = process.env.SDLC_LEAK_TREE === undefined ? ENFORCE_TREE_BY_DEFAULT : process.env.SDLC_LEAK_TREE === "1";

test("whole tree: no failing finding and no stale allow entry in the tracked files", { skip: enforceTree ? false : "switched off by SDLC_LEAK_TREE=0" }, () => {
  const denylist = loadDenylist(REAL_DENYLIST, { allowEmpty: process.env.SDLC_LEAK_ALLOW_EMPTY === "1" });
  const allow = loadAllow(REAL_ALLOW, { denylist });
  const result = scanTree({ root: ROOT, denylist, allow });
  assert.equal(failing(result).length + result.stale.length, 0, `\n${formatRun(result, createMasker(denylist)).join("\n")}`);
});

test("the whole tree is enforced by default: only SDLC_LEAK_TREE=0 switches the scan off", () => {
  assert.equal(ENFORCE_TREE_BY_DEFAULT, true);
});
