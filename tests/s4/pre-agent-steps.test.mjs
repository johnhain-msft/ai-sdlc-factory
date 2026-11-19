// AC8, AC9, AC24 (the validation step), AC56, AC57, AC58, AC59 and AC64: the rendered pre-agent-steps, executed in bash against local git checkouts with a read-only gh.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { presetAbs } from "../helpers/preset.mjs";
import { abs, git, readText } from "./helpers/fixtures.mjs";
import { CHANGED_SOURCE, CHANGED_VIEW, INPUT_REPORTS, commandOf, downstreamName, fileIn, pathsOf, reportsOf } from "./helpers/example-world.mjs";
import { createRun, dispatchInputs } from "./helpers/runtime.mjs";
import { AI, edgeOf, workflowOf } from "./helpers/workflows.mjs";

const CONTENT = AI.find((spec) => pathsOf(spec).sourceManifest);
const PIPELINES = AI.find((spec) => edgeOf(spec).preflightCommands.some((command) => command.startsWith("gh api ")));
const COURSE = AI.find((spec) => edgeOf(spec).preflightCommands.some((command) => command.startsWith("git -C ")));
const FIVE = ["BASE_SHA", "UPSTREAM_SHA", "PREVIOUS_SHA", "BRANCH_NAME", "UPSTREAM_DIR"];
const writes = (run) => run.calls().filter((line) => line.startsWith("WRITE"));
const statuses = (run) => run.pre().map(() => 0);
const throughCapture = (run) => [...statuses(run).slice(0, -2), 2];

test("AC8/AC24: the validation step passes for the dispatch of the run, and exits 2 when the upstream checkout is at the wrong commit or lacks previous_sha (a shallow clone)", () => {
  for (const spec of AI) {
    const run = createRun(spec);
    try {
      const validate = run.pre().find((step) => step.name === "Validate dispatch inputs and checkouts");
      const ok = run.step(validate);
      assert.equal(ok.status, 0, `${spec.id}: ${ok.stderr}`);
      assert.match(run.box.environment().DRY_RUN ?? "x", /^$/, "DRY_RUN is exported, empty for an empty input");
      // the wrong commit
      run.inputs.upstream_sha = run.previousSha;
      const wrong = run.step(validate);
      assert.equal(wrong.status, 2, `${spec.id}: ${wrong.stderr}`);
      assert.match(wrong.stderr, /not at upstream_sha/);
      // a shallow clone of the right commit: previous_sha is not in it
      run.inputs.upstream_sha = run.upstreamSha;
      const full = path.join(path.dirname(run.upstream), "full-history");
      fs.renameSync(run.upstream, full);
      git(path.dirname(run.upstream), ["clone", "-q", "--depth", "1", pathToFileURL(full).href, run.upstream]);
      assert.equal(git(run.upstream, ["rev-parse", "HEAD"]).stdout.trim(), run.upstreamSha);
      const missing = run.step(validate);
      assert.equal(missing.status, 2, `${spec.id}: ${missing.stderr}`);
      assert.equal(run.porcelain(), "", "and nothing was written to the downstream");
    } finally {
      run.cleanup();
    }
  }
});

test("AC9/AC56: the pre-agent steps leave the downstream clean at BASE_SHA, write base-sha.txt and the five GITHUB_ENV lines, and a later bash process sees all five", () => {
  for (const spec of AI) {
    const run = createRun(spec);
    try {
      const results = run.runPre();
      assert.deepEqual(results.map((result) => result.status), statuses(run), `${spec.id}: ${JSON.stringify(results.map((result) => result.stderr))}`);
      assert.equal(run.porcelain(), "", `${spec.id}: git status --porcelain prints nothing`);
      assert.equal(run.head(), run.baseSha, `${spec.id}: HEAD is BASE_SHA`);
      assert.equal(run.upstreamPorcelain(), "", `${spec.id}: the upstream checkout is untouched`);
      assert.equal(run.box.readArtifact("base-sha.txt"), `${run.baseSha}\n`, `${spec.id}: base-sha.txt holds the sha alone, newline-terminated`);
      const env = run.box.environment();
      assert.equal(env.BASE_SHA, run.baseSha);
      assert.equal(env.UPSTREAM_SHA, run.upstreamSha);
      assert.equal(env.PREVIOUS_SHA, run.previousSha);
      assert.equal(env.BRANCH_NAME, spec.branchName);
      assert.ok(env.UPSTREAM_DIR.endsWith(`/upstream/${spec.repo}`), env.UPSTREAM_DIR);
      const seen = run.script(FIVE.map((name) => `printf '%s=%s\\n' ${name} "$${name}"`).join("\n"));
      assert.equal(seen.status, 0, seen.stderr);
      for (const name of FIVE) assert.match(seen.stdout, new RegExp(`^${name}=.+$`, "m"), `${spec.id}: ${name} is non-empty in a later bash process`);
    } finally {
      run.cleanup();
    }
  }
});

test("AC56/AC29: upstream-diff.txt, dispatch-inputs.json (the ten inputs verbatim) and existing-pr.json are written for the agent, and the only gh request is a GET", () => {
  for (const spec of AI) {
    const open = { number: 42, html_url: "https://example.invalid/pull/42", head: { sha: "f".repeat(40) } };
    for (const pull of [undefined, JSON.stringify(open)]) {
      const run = createRun(spec, { pull });
      try {
        assert.deepEqual(run.runPre().map((result) => result.status), statuses(run), spec.id);
        const diff = git(run.upstream, ["diff", "--name-status", run.previousSha, run.upstreamSha]).stdout;
        assert.equal(run.artifact("upstream-diff.txt"), diff, `${spec.id}: the name-status diff of previous_sha..upstream_sha`);
        assert.ok(diff.includes(CHANGED_SOURCE));
        assert.deepEqual(JSON.parse(run.artifact("dispatch-inputs.json")), run.inputs, `${spec.id}: the ten inputs, verbatim`);
        assert.equal(Object.keys(JSON.parse(run.artifact("dispatch-inputs.json"))).length, 10);
        assert.deepEqual(JSON.parse(run.artifact("existing-pr.json")), pull === undefined ? null : open, `${spec.id}: the open pull request, or null`);
        const calls = run.calls().filter((line) => line.startsWith("gh "));
        assert.ok(calls.some((line) => line.includes(`pulls?state=open&head=${edgeOf(spec).downstreamRepo.split("/")[0]}:${spec.branchName}`)), `${spec.id}: ${calls.join(" | ")}`);
        assert.deepEqual(writes(run), [], `${spec.id}: no write request`);
      } finally {
        run.cleanup();
      }
    }
  }
});

test("AC57: the capture hook runs the input check and source-check helper against the upstream checkout, and both declared reports land in the artifact directory", () => {
  const run = createRun(CONTENT, { inputReport: INPUT_REPORTS.drift, inputRc: 1 });
  try {
    const [inputReport, sourceReport] = reportsOf(CONTENT);
    assert.deepEqual(run.runPre().map((result) => result.status), statuses(run), "an expected drift report passes through");
    assert.equal(run.artifact(inputReport), INPUT_REPORTS.drift);
    assert.equal(run.artifact("preflight-1.txt"), INPUT_REPORTS.drift);
    const source = JSON.parse(run.artifact(sourceReport));
    assert.deepEqual(source, { status: "drift", changed: [CHANGED_VIEW] });
    assert.equal(run.artifact(sourceReport), run.artifact("preflight-2.txt"));
    assert.equal(run.artifact("preflight-exit-codes.txt"), "preflight exit codes: 1 1\n");
    assert.equal(run.porcelain(), "", "neither command wrote into the downstream");
    assert.equal(run.upstreamPorcelain(), "", "nor into the upstream checkout");
    const check = edgeOf(CONTENT).preflightCommands[0].split("<checkout>")[0];
    assert.ok(run.calls().some((line) => line.startsWith(check) && !line.includes("--accept")), "the input script ran without --accept");
  } finally {
    run.cleanup();
  }
});

test("AC57: the hook runs exactly the declared preflight commands with <checkout> as $UPSTREAM_DIR, in the downstream, and TARGET_SHA as upstream_sha", () => {
  const capture = workflowStep(CONTENT, "Capture the drift reports");
  assert.equal(capture["working-directory"], downstreamName(CONTENT));
  const text = capture.run;
  assert.ok(text.includes('TARGET_SHA="$UPSTREAM_SHA"'));
  edgeOf(CONTENT).preflightCommands.forEach((command, index) => {
    assert.ok(text.includes(`( ${commandOf(command)} ) > /tmp/gh-aw/agent/preflight-${index + 1}.txt 2>&1`), command);
  });
  assert.ok(text.includes("rc1=$?") && text.includes("rc2=$?"));
  reportsOf(CONTENT).forEach((report, index) => assert.ok(text.includes(`cp /tmp/gh-aw/agent/preflight-${index + 1}.txt /tmp/gh-aw/agent/${report}`)));
  assert.ok(text.indexOf("set +e") < text.indexOf("rc1=$?") && text.indexOf("rc2=$?") < text.indexOf("set -e"), "set +e ... set -e around the two commands");
  assert.equal(capture.env, undefined, "this hook calls no gh");
  for (const check of edgeOf(CONTENT).preflightChecks) if (check.classifier) assert.equal(text.includes(check.classifier), false, "classifiers belong to the router, not evidence capture");
});

test("AC58: a source-check fatal error, an input-check exit of 2 or more, and an uncaught-exception stack trace each stop capture with exit 2; clean and drift reports leave both files", () => {
  // An unreadable source manifest is a real fatal input of the example helper.
  const fatal = createRun(CONTENT, { inputReport: INPUT_REPORTS.clean, inputRc: 0 });
  try {
    fs.writeFileSync(fileIn(fatal.downstream, pathsOf(CONTENT).sourceManifest), "{ not json\n");
    const results = fatal.runPre();
    assert.deepEqual(results.map((result) => result.status), throughCapture(fatal));
    assert.match(results.at(-1).stderr, /exit code 2/);
    assert.equal(fatal.hasArtifact(reportsOf(CONTENT)[1]), true, "the report is still there for whoever reads the failure");
    assert.equal(fatal.artifact(reportsOf(CONTENT)[0]), INPUT_REPORTS.clean, "earlier evidence survives a later command failure");
  } finally {
    fatal.cleanup();
  }
  // A crash and a drift report can share exit code 1.
  const crash = createRun(CONTENT, { inputReport: INPUT_REPORTS.crash, inputRc: 1, sourceChanged: false });
  try {
    const results = crash.runPre();
    assert.deepEqual(results.map((result) => result.status), throughCapture(crash));
    assert.match(results.at(-1).stderr, /stack trace/);
  } finally {
    crash.cleanup();
  }
  const rc2 = createRun(CONTENT, { inputReport: "something went wrong\n", inputRc: 2, sourceChanged: false });
  try {
    assert.deepEqual(rc2.runPre().map((result) => result.status), throughCapture(rc2));
    assert.equal(rc2.hasArtifact(reportsOf(CONTENT)[1]), true, "a first-command failure does not suppress later evidence");
  } finally {
    rc2.cleanup();
  }
  // a clean report, and a drift report: exit 0, both files left for the agent
  for (const [report, rc, changed] of [["clean", 0, false], ["drift", 1, true]]) {
    const run = createRun(CONTENT, { inputReport: INPUT_REPORTS[report], inputRc: rc, sourceChanged: changed });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), statuses(run), report);
      assert.ok(reportsOf(CONTENT).every((name) => run.hasArtifact(name)), report);
      assert.equal(JSON.parse(run.artifact(reportsOf(CONTENT)[1])).status, changed ? "drift" : "in-sync");
    } finally {
      run.cleanup();
    }
  }
});

test("AC59: evidence capture treats the input report as opaque text: its only reader is the stack-trace check, and unrelated helpers do not parse its summary", () => {
  const capture = workflowStep(CONTENT, "Capture the drift reports").run;
  const readers = capture.split("\n").filter((line) => /\b(?:cat|jq|sed|awk|head|tail|grep|readFileSync)\b/.test(line));
  assert.equal(readers.length, 1, readers.join("\n"));
  assert.match(readers[0], /grep -Eq '\^\[\[:space:\]\]\+at\[\[:space:\]\]\+\[\^\[:space:\]\]'/);
  for (const file of [abs("src", "verify-immutable-gates.mjs"), presetAbs("scripts", "check-sources.mjs")]) {
    const text = readText(file);
    for (const banned of ["Inputs checked:", "PROBLEM"]) assert.equal(text.includes(banned), false, `${file}: ${banned}`);
  }
});

test("AC64: the runs hook saves the response of its declared GET as the named report with a read-only request", () => {
  const body = '{"total_count":1,"workflow_runs":[{"id":777,"head_sha":"abc"}]}\n';
  const run = createRun(PIPELINES, { runs: body });
  try {
    assert.deepEqual(run.runPre().map((result) => result.status), statuses(run));
    assert.equal(run.artifact(reportsOf(PIPELINES)[0]), body);
    assert.equal(run.artifact("preflight-1.txt"), body);
    const calls = run.calls().filter((line) => line.includes("actions/runs"));
    assert.deepEqual(calls, [edgeOf(PIPELINES).preflightCommands[0].replaceAll('"', "")], "one GET, no method flag");
    assert.deepEqual(writes(run), []);
    assert.equal(run.porcelain(), "");
  } finally {
    run.cleanup();
  }
});

test("AC9: a plain diff preflight records 1 when the cumulative range touches its sources and 0 when it does not, without failing capture", () => {
  for (const [sourceChanged, expected] of [[true, "1"], [false, "0"]]) {
    const run = createRun(COURSE, { sourceChanged });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), statuses(run), `sourceChanged=${sourceChanged}`);
      assert.equal(run.artifact("preflight-exit-codes.txt"), `preflight exit codes: ${expected}\n`);
      assert.deepEqual(reportsOf(COURSE), [], "this edge declares no named report");
      for (const name of reportsOf(CONTENT)) assert.equal(run.hasArtifact(name), false, "reports from sibling workflows are not invented");
      assert.equal(run.porcelain(), "");
    } finally {
      run.cleanup();
    }
  }
});

test("AC24: the inputs of the run reach the steps as the dispatch carries them; an input is never taken from the environment of the runner", () => {
  const inputs = dispatchInputs(CONTENT, { previous_sha: "a".repeat(40), upstream_sha: "b".repeat(40) });
  assert.equal(Object.keys(inputs).length, 10);
  const [validate, base] = preSteps(CONTENT).filter((step) => /^(?:Validate dispatch|Record the base revision)/.test(step.name));
  for (const step of [validate, base]) {
    assert.equal(step.env.UPSTREAM_SHA, "${{ inputs.upstream_sha }}");
    assert.equal(step.env.PREVIOUS_SHA, "${{ inputs.previous_sha }}");
  }
});

const preSteps = (spec) => workflowOf(spec).frontmatter["pre-agent-steps"];
const workflowStep = (spec, name) => preSteps(spec).find((step) => step.name === name);
