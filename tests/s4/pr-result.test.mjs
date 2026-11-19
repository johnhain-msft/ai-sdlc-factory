// AC70: AiPullRequestResult has the four fixed fields and the result arrays declared by the edge, printed as the finalizer's last line and written to
// GITHUB_OUTPUT as result=<json>. The command takes the line that SPEC-03's script printed (the real script is run here, against its local GitHub stub), reads the files of the pull
// request through the stubbed API, and adds nothing to GitHub. Every case is in process, with an injected fetch: no socket is opened.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { adaptedNames, parsePollStateResult, run as resultRun } from "../../src/ai-pull-request-result.mjs";
import { seedState, sha, STUB_API_URL, TOKENS } from "../s3/helpers/fixtures.mjs";
import { BASE, HEAD, TARGET, flagsFor, invoke, world } from "../s3/helpers/poll-state-world.mjs";
import { AI, edgeOf } from "./helpers/workflows.mjs";

const CONTENT_FILES = [
  "content/pages/p3.ts",
  "content/pages/p10.ts",
  "content/pages/index.ts",
  "content/pages/timing.ts",
  "content/rules.ts",
  "apps/site/client/src/views/view12.tsx",
  "apps/site/client/src/views/view05.tsx",
  "apps/site/client/src/views/source.ts",
  "apps/site/sources.json",
  "public/pages/index.html",
  "README.md",
];
const FILES = {
  "lab-to-hub": CONTENT_FILES,
  "pipelines-to-hub": ["content/pipelines/provenance.json", "content/pipelines/run-data.json", "public/pipelines/index.html"],
  "course-to-hub": ["content/course/provenance.json", "content/course/src/engine/sha1.ts", "public/course/index.html"],
};
const KINDS = [
  { kind: "noop-no-changes", head: BASE, start: (entry) => seedState(entry) },
  { kind: "pr-opened", head: HEAD, start: (entry) => seedState(entry) },
  { kind: "pr-updated", head: HEAD, start: (entry) => ({ ...seedState(entry), openPrNumber: 7, openPrTargetSha: sha("an earlier revision") }) },
];

/** The poll-state script of SPEC-03 run for real in the world, then the result command with the output of the first as its input. */
async function finalize(spec, { kind, head, start }, { files = FILES[spec.edgeId], env = {}, omitEnv = [], answer, pollText, resultMap } = {}) {
  const entry = structuredClone(edgeOf(spec));
  if (resultMap !== undefined) entry.adaptation = { ...entry.adaptation, pullRequestResult: resultMap };
  const w = world({ edgeValue: entry, start: start(entry) });
  const poll = await invoke(w, flagsFor(entry, { "--head-sha": head }));
  assert.equal(poll.code, 0, `${spec.id} ${kind}: ${poll.stderr}`);
  const pollFile = path.join(w.workspace.dir, "poll-state-result.json");
  fs.writeFileSync(pollFile, pollText ?? poll.stdout);
  const output = path.join(w.workspace.dir, "github-output.txt");
  fs.writeFileSync(output, "");
  w.stub.inject("GET", /\/pulls\/7\/files/, answer ?? { status: 200, body: files.map((filename) => ({ filename, status: "modified" })) });
  let stdout = "";
  let stderr = "";
  const environment = { GITHUB_WORKSPACE: w.workspace.dir, GH_TOKEN: TOKENS.gh, UPSTREAM_SHA: TARGET, GITHUB_OUTPUT: output, GITHUB_API_URL: STUB_API_URL, ...env };
  for (const name of omitEnv) delete environment[name];
  const code = await resultRun(["--slug", spec.upstreamSlug, "--poll-state-result", pollFile], {
    env: environment,
    cwd: w.workspace.dir,
    fetch: w.stub.fetch,
    now: w.clock.now,
    sleep: w.clock.sleep,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr, output: fs.readFileSync(output, "utf8"), w, poll };
}

for (const spec of AI) {
  for (const entry of KINDS) {
    test(`AC70 ${spec.id} ${entry.kind}: the declared members and their types, the last output line and result=<json> in GITHUB_OUTPUT`, async () => {
      const r = await finalize(spec, entry);
      try {
        assert.equal(r.code, 0, r.stderr);
        const lines = r.stdout.trim().split("\n");
        assert.equal(lines.length, 1, "the command prints exactly one line");
        const result = JSON.parse(lines.at(-1));
        const keys = Object.keys(edgeOf(spec).adaptation?.pullRequestResult ?? {});
        assert.deepEqual(Object.keys(result), ["outcome", "prNumber", "prUrl", "recordedCommit", ...keys]);
        assert.equal(result.outcome, entry.kind);
        assert.equal(result.recordedCommit, TARGET);
        assert.match(result.recordedCommit, /^[0-9a-f]{40}$/);
        for (const key of keys) assert.ok(Array.isArray(result[key]) && result[key].every((name) => typeof name === "string"), key);
        if (entry.kind === "noop-no-changes") {
          assert.equal(result.prNumber, null);
          assert.equal(result.prUrl, null);
          assert.deepEqual(keys.map((key) => result[key]), keys.map(() => []));
          assert.equal(r.w.stub.calls("GET", "/files").length, 0, "no pull request, so no request for its files");
        } else {
          assert.equal(result.prNumber, 7);
          assert.equal(result.prUrl, "https://github.com/acme/portal/pull/7");
          const expected = spec.edgeId === "lab-to-hub" ? { adaptedPages: ["p10", "p3"], adaptedViews: ["view05", "view12"] } : {};
          assert.deepEqual(Object.fromEntries(keys.map((key) => [key, result[key]])), expected, `${spec.id}: only declared arrays, with sorted changed base names`);
        }
        assert.equal(r.output, `result=${JSON.stringify(result)}\n`, "GITHUB_OUTPUT holds result=<json>");
        assert.equal(r.w.stub.calls().filter((request) => request.method !== "GET").length, 1, "the only write is the state variable of SPEC-03's own run");
        assert.deepEqual(r.w.stub.calls("GET", "/files").map((request) => request.method), keys.length > 0 && entry.kind !== "noop-no-changes" ? ["GET"] : [], "the files of the pull request are read, never written");
      } finally {
        r.w.workspace.cleanup();
      }
    });
  }
}

test("AC70: outcome follows SPEC-03's own decision: pr-updated exactly when the verified pull request is the one that the state already recorded, pr-opened otherwise, noop-no-changes when nothing was committed", async () => {
  const outcomes = [];
  for (const entry of KINDS) {
    const r = await finalize(AI[0], entry);
    try {
      outcomes.push(JSON.parse(r.stdout.trim()).outcome);
      assert.equal(JSON.parse(r.poll.stdout.trim().split("\n").at(-1)).outcome, entry.kind, "SPEC-03's line says the same");
    } finally {
      r.w.workspace.cleanup();
    }
  }
  assert.deepEqual(outcomes, ["noop-no-changes", "pr-opened", "pr-updated"]);
});

test("AC70: no-op and undeclared result arrays need no token; reading declared pull-request files needs the App installation token", async () => {
  const noop = await finalize(AI[0], KINDS[0], { omitEnv: ["GH_TOKEN"] });
  try {
    assert.equal(noop.code, 0, noop.stderr);
    assert.equal(JSON.parse(noop.stdout).outcome, "noop-no-changes");
  } finally {
    noop.w.workspace.cleanup();
  }
  const withoutMap = await finalize(AI[1], KINDS[1], { omitEnv: ["GH_TOKEN"] });
  try {
    assert.equal(withoutMap.code, 0, withoutMap.stderr);
    assert.deepEqual(Object.keys(JSON.parse(withoutMap.stdout)), ["outcome", "prNumber", "prUrl", "recordedCommit"]);
    assert.equal(withoutMap.w.stub.calls("GET", "/files").length, 0);
  } finally {
    withoutMap.w.workspace.cleanup();
  }
  for (const [label, options] of [["no token", { omitEnv: ["GH_TOKEN"] }], ["a personal token", { env: { GH_TOKEN: "ghp_stand-in-for-a-personal-token" } }]]) {
    const r = await finalize(AI[0], KINDS[1], options);
    try {
      assert.equal(r.code, 2, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, "", `${label}: nothing is printed`);
      assert.equal(r.output, "", `${label}: nothing is written to GITHUB_OUTPUT`);
      assert.match(r.stderr, /GH_TOKEN|installation token/);
    } finally {
      r.w.workspace.cleanup();
    }
  }
});

test("AC70: a failing request for the files fails the step (exit 1 or 2) and prints no result; the result is printed without GITHUB_OUTPUT too", async () => {
  const failing = await finalize(AI[0], KINDS[1], { answer: { status: 500, body: { message: "Server Error" } } });
  try {
    assert.notEqual(failing.code, 0, "the request error is the error of the step");
    assert.equal(failing.stdout, "");
    assert.equal(failing.output, "");
  } finally {
    failing.w.workspace.cleanup();
  }
  const bare = await finalize(AI[1], KINDS[1], { omitEnv: ["GITHUB_OUTPUT"] });
  try {
    assert.equal(bare.code, 0, bare.stderr);
    assert.equal(JSON.parse(bare.stdout).outcome, "pr-opened");
  } finally {
    bare.w.workspace.cleanup();
  }
});

test("AC70: a malformed input is a usage error (exit 2) that prints nothing: an unknown slug, a bad UPSTREAM_SHA, an unreadable or unusable poll-state result", async () => {
  const cases = [
    ["a poll-state result that is not JSON", { pollText: "not json\n" }, /not a JSON line/],
    ["a poll-state result that is not an object", { pollText: "[1]\n" }, /not a JSON object/],
    ["an outcome that is neither a no-op nor a verified pull request", { pollText: '{"outcome":"something-else"}\n' }, /neither a no-op nor a verified pull request/],
    ["a pull request without a number", { pollText: '{"outcome":"pr-opened","prUrl":"x"}\n' }, /neither a no-op nor a verified pull request/],
    ["an UPSTREAM_SHA that is not 40 hex", { env: { UPSTREAM_SHA: "abc" } }, /UPSTREAM_SHA must be 40 lowercase hexadecimal characters/],
  ];
  for (const [label, options, message] of cases) {
    const r = await finalize(AI[0], KINDS[1], options);
    try {
      assert.equal(r.code, 2, `${label}: ${r.stderr}`);
      assert.match(r.stderr, message, label);
      assert.equal(r.stdout, "", label);
      assert.equal(r.output, "", label);
    } finally {
      r.w.workspace.cleanup();
    }
  }
  const entry = edgeOf(AI[0]);
  const w = world({ edgeValue: entry, start: seedState(entry) });
  try {
    for (const [label, argv, message] of [
      ["an unknown slug", ["--slug", "NO_SUCH_SLUG", "--poll-state-result", path.join(w.workspace.dir, "x.json")], /no dependencyEdges entry/],
      ["a missing --poll-state-result", ["--slug", entry.upstreamSlug], /--poll-state-result is required/],
      ["a missing --slug", ["--poll-state-result", "x.json"], /--slug is required/],
      ["a lower-case slug", ["--slug", entry.upstreamSlug.toLowerCase(), "--poll-state-result", "x.json"], /--slug must be an upstreamSlug/],
      ["a poll-state file that does not exist", ["--slug", entry.upstreamSlug, "--poll-state-result", path.join(w.workspace.dir, "missing.json")], /cannot be read/],
    ]) {
      let stdout = "";
      let stderr = "";
      const code = await resultRun(argv, { env: { GITHUB_WORKSPACE: w.workspace.dir, UPSTREAM_SHA: TARGET, GH_TOKEN: TOKENS.gh }, cwd: w.workspace.dir, fetch: w.stub.fetch, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
      assert.equal(code, 2, `${label}: ${stderr}`);
      assert.match(stderr, message, label);
      assert.equal(stdout, "", label);
    }
  } finally {
    w.workspace.cleanup();
  }
});

test("AC70: free-form result keys select their own globs, retain manifest order and never introduce preset-specific arrays", async () => {
  const r = await finalize(AI[0], KINDS[1], {
    resultMap: { changedWidgets: "widgets/w*.ts", changedGuides: "guides/*.md" },
    files: ["widgets/w2.ts", "widgets/w1.ts", "widgets/w2.ts", "widgets/nested/w3.ts", "guides/start.md", "guides/other.txt"],
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(result), ["outcome", "prNumber", "prUrl", "recordedCommit", "changedWidgets", "changedGuides"]);
    assert.deepEqual(result.changedWidgets, ["w1", "w2"]);
    assert.deepEqual(result.changedGuides, ["start"]);
    assert.equal(r.output, `result=${JSON.stringify(result)}\n`);
    assert.deepEqual(r.w.stub.calls("GET", "/files").map((request) => request.method), ["GET"]);
  } finally {
    r.w.workspace.cleanup();
  }
});

test("AC70: parsePollStateResult reads the last non-empty line of the output of SPEC-03's script, and nothing before it", () => {
  assert.deepEqual(parsePollStateResult('{"outcome":"noop-no-changes"}\n'), { outcome: "noop-no-changes", prNumber: null, prUrl: null });
  assert.deepEqual(parsePollStateResult('a log line\n{"outcome":"pr-opened","prNumber":9,"prUrl":"https://example.invalid/9","headSha":"x","openPrTargetSha":"y"}\n\n'), { outcome: "pr-opened", prNumber: 9, prUrl: "https://example.invalid/9" });
  assert.deepEqual(parsePollStateResult('{"outcome":"pr-updated","prNumber":4,"prUrl":"u"}'), { outcome: "pr-updated", prNumber: 4, prUrl: "u" });
  for (const bad of ["", "\n", "x", "null", '{"outcome":"pr-opened","prNumber":"9","prUrl":"u"}', '{"outcome":"noop"}']) assert.throws(() => parsePollStateResult(bad), /poll-state result/, JSON.stringify(bad));
});

test("AC70: adaptedNames returns the sorted base names, without their extension, of the files that match the glob, each once, and nothing for an empty glob", () => {
  const files = ["a/content/m10.ts", "a/content/m3.ts", "a/content/m3.ts", "a/content/m2.js", "a/content/index.ts", "a/content/sub/m4.ts", "b/content/m5.ts", "a/content/m1.test.ts"];
  assert.deepEqual(adaptedNames(files, "a/content/m*.ts"), ["m1.test", "m10", "m3"], "* does not cross a directory, and only the last extension goes");
  assert.deepEqual(adaptedNames(["x/view12.tsx", "x/view05.tsx", "x/source.ts", "x/views/view01.tsx"], "x/view*.tsx"), ["view05", "view12"]);
  assert.deepEqual(adaptedNames(files, ""), []);
  assert.deepEqual(adaptedNames(files, undefined), []);
  assert.deepEqual(adaptedNames([], "a/content/m*.ts"), []);
  assert.deepEqual(adaptedNames(["a/content/m3.ts"], "a/content/**"), ["m3"]);
});
