// --help and -h of the two entry points print the usage on stdout and exit 0 without asking for gh-aw, so that a machine that has no
// gh-aw, or one that is too old, can still read how to call them. It is the one invocation that runs before the gh-aw gate (AC6),
// because it reads nothing, writes nothing and sends nothing; and only an invocation of exactly one argument is a help request
// (as for sdlc-reconcile), so no other argument gets past the gate.
import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_USAGE, ONBOARD_USAGE } from "../../bin/lib/cli-flags.mjs";
import { createScenario, runCli } from "./helpers/harness.mjs";

const ENTRIES = [
  ["bootstrap", BOOTSTRAP_USAGE],
  ["onboard", ONBOARD_USAGE],
];
const NO_GH_ON_PATH = { PATH: "", Path: "" };

for (const [entry, usage] of ENTRIES) {
  for (const flag of ["--help", "-h"]) {
    test(`${entry} ${flag} prints the usage on stdout and exits 0, even for a gh-aw that is too old, with no call to gh, no request and no write`, async () => {
      const scenario = await createScenario({ gh: { version: "0.86.2" } });
      try {
        const before = scenario.workspace.status();
        const run = await scenario[entry]([flag], { env: scenario.env(scenario.appCredentials()) });
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.stdout, `${usage}\n`);
        assert.equal(run.stderr, "");
        assert.deepEqual(scenario.gh.log(), [], "gh was not called, not even for its version");
        assert.deepEqual(scenario.fake.log, [], "zero network calls");
        assert.equal(scenario.workspace.status(), before, "the working copy is untouched");
      } finally {
        await scenario.cleanup();
      }
    });
  }

  test(`${entry} --help as a real process with no gh on PATH prints the usage and exits 0, with no write and no listener`, async () => {
    const scenario = await createScenario();
    try {
      const run = await runCli(entry, ["--help"], { env: { ...scenario.env(), ...NO_GH_ON_PATH }, cwd: scenario.workspace.dir });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout, `${usage}\n`);
      assert.equal(run.stderr, "");
      assert.deepEqual(run.trace, [], "no file write and no listener");
    } finally {
      await scenario.cleanup();
    }
  });

  for (const argv of [["--help", "--bogus"], ["--bogus", "--help"], ["--help", "--help"], ["-h", "--non-interactive"]]) {
    test(`${entry} ${JSON.stringify(argv)} is not a help request: a gh-aw that is too old still stops it, and a good one refuses the flags`, async () => {
      const tooOld = await createScenario({ gh: { version: "0.86.2" } });
      try {
        const run = await tooOld[entry](argv, { env: tooOld.env(tooOld.appCredentials()) });
        assert.notEqual(run.code, 0);
        assert.match(run.stderr, /GHSA-8h78-hpm7-29gg/);
        assert.equal(run.stdout, "");
      } finally {
        await tooOld.cleanup();
      }
      const current = await createScenario();
      try {
        const run = await current[entry](argv, { env: current.env(current.appCredentials()) });
        assert.equal(run.code, 2, run.stderr);
        assert.match(run.stderr, new RegExp(`usage: node bin/sdlc-${entry}\\.mjs`));
        assert.equal(run.stdout, "");
        assert.deepEqual(current.fake.log, [], "zero network calls");
      } finally {
        await current.cleanup();
      }
    });
  }
}
