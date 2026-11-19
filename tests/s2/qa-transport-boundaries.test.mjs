// AC22/AC38: bounded transport reads, per-entry failures and real bundle inspection
// through the scratch repository. The size probes change metadata, not allocate 64 MiB.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  bundleCommits,
  FILE_LIMIT_BYTES,
  git as artifactGit,
  openScratch,
  patchTrees,
  snapshotTransportFiles,
  transportFiles,
} from "../../src/drift/lib/git-artifacts.mjs";
import { targetFiles, withoutSection } from "../helpers/target-fixture.mjs";
import { forceRemove, hashTree, tempDir, writeTree } from "./helpers/fixtures.mjs";
import { git, writeGitFixtureConfig } from "./helpers/git-fixture.mjs";
import { cleanEnv } from "./helpers/stub-server.mjs";

const wrappedFs = (overrides) => new Proxy(fs, {
  get(target, property) {
    if (Object.hasOwn(overrides, property)) return overrides[property];
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

test("AC22 QA: a transport exactly at the byte limit is copied, one byte over is refused without a copy, and entries stay sorted", () => {
  const root = tempDir("sdlc-qa-size-");
  const input = path.join(root, "input");
  const scratch = { directory: path.join(root, "scratch") };
  fs.mkdirSync(input);
  fs.mkdirSync(scratch.directory);
  writeTree(input, { "aw-z.bundle": "over", "aw-a.patch": "at", "notes.patch": "ignored", "aw-z.bundle.bak": "ignored" });
  const before = hashTree(input);
  const sized = wrappedFs({
    statSync(file) {
      const stat = fs.statSync(file);
      return { isFile: () => stat.isFile(), size: path.basename(file) === "aw-a.patch" ? FILE_LIMIT_BYTES : FILE_LIMIT_BYTES + 1 };
    },
  });
  try {
    const entries = snapshotTransportFiles(input, scratch, sized);
    assert.deepEqual(entries.map(({ name }) => name), ["aw-a.patch", "aw-z.bundle"]);
    assert.equal(entries[0].error, undefined);
    assert.equal(fs.readFileSync(entries[0].file, "utf8"), "at", "the accepted bytes were really copied");
    assert.match(String(entries[1].error?.message), /more than/);
    assert.equal(fs.existsSync(path.join(scratch.directory, "transport", "aw-z.bundle")), false, "no oversized copy was made");
    assert.deepEqual(fs.readdirSync(path.join(scratch.directory, "transport")), ["aw-a.patch"]);
    assert.equal(hashTree(input), before, "the input files were not touched");
  } finally {
    forceRemove(root);
  }
});

test("AC22 QA: stat, non-regular-file and copy errors are recorded per transport and do not prevent a good sibling from being copied", () => {
  const root = tempDir("sdlc-qa-copy-errors-");
  const input = path.join(root, "input");
  const scratch = { directory: path.join(root, "scratch") };
  fs.mkdirSync(input);
  fs.mkdirSync(scratch.directory);
  writeTree(input, { "aw-a-stat.patch": "a", "aw-c-copy.bundle": "c", "aw-d-good.patch": "good" });
  fs.mkdirSync(path.join(input, "aw-b-directory.bundle"));
  const before = hashTree(input);
  const broken = wrappedFs({
    statSync(file) {
      if (path.basename(file) === "aw-a-stat.patch") throw Object.assign(new Error("injected stat denial"), { code: "EACCES" });
      return fs.statSync(file);
    },
    copyFileSync(from, to) {
      if (path.basename(from) === "aw-c-copy.bundle") throw Object.assign(new Error("injected copy failure"), { code: "EIO" });
      return fs.copyFileSync(from, to);
    },
  });
  try {
    const entries = snapshotTransportFiles(input, scratch, broken);
    assert.deepEqual(entries.map(({ name }) => name), ["aw-a-stat.patch", "aw-b-directory.bundle", "aw-c-copy.bundle", "aw-d-good.patch"]);
    assert.equal(entries[0].error?.code, "EACCES");
    assert.match(String(entries[1].error?.message), /not a regular file/);
    assert.equal(entries[2].error?.code, "EIO");
    assert.equal(entries[3].error, undefined);
    assert.equal(fs.readFileSync(entries[3].file, "utf8"), "good");
    assert.deepEqual(fs.readdirSync(path.join(scratch.directory, "transport")), ["aw-d-good.patch"]);
    assert.equal(hashTree(input), before);
  } finally {
    forceRemove(root);
  }
});

test("AC22 QA: missing transport directories are empty, but an unreadable directory is not silently treated as empty", () => {
  for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EIO"]) {
    const error = Object.assign(new Error(`injected ${code}`), { code });
    const io = { readdirSync: () => { throw error; } };
    if (code === "ENOENT" || code === "ENOTDIR") assert.deepEqual(transportFiles("unused", io), []);
    else assert.throws(() => transportFiles("unused", io), (caught) => caught === error);
  }
});

test("AC22 QA: both patch and bundle readers recheck the byte limit before reading a copied transport", () => {
  let reads = 0;
  const io = {
    statSync: () => ({ size: FILE_LIMIT_BYTES + 1 }),
    readFileSync: () => { reads += 1; throw new Error("oversized bytes must not be read"); },
  };
  for (const read of [patchTrees, bundleCommits]) {
    assert.throws(
      () => read({ directory: "unused", options: {} }, { file: "aw-too-large.patch", baseSha: "0".repeat(40), fs: io }),
      /more than/,
    );
  }
  assert.equal(reads, 0, "neither reader consumed oversized bytes");
});

for (const format of ["sha1", "sha256"]) {
  test(`AC22 QA: a ${format} bundle with packed prerequisite refs and detached HEAD is inspected without opening git in the checkout`, async () => {
    const root = tempDir(`sdlc-qa-bundle-${format}-`);
    const checkout = path.join(root, "checkout with spaces");
    const transport = path.join(root, "artifacts");
    const out = path.join(transport, "agent");
    fs.mkdirSync(checkout);
    fs.mkdirSync(out, { recursive: true });
    try {
      git(checkout, ["init", "-q", `--object-format=${format}`]);
      writeGitFixtureConfig(checkout);
      writeTree(checkout, targetFiles());
      git(checkout, ["add", "--", "."]);
      git(checkout, ["commit", "-q", "-m", "base"]);
      const base = git(checkout, ["rev-parse", "HEAD"]);
      git(checkout, ["tag", "-a", "qa-base", "-m", "packed prerequisite", base]);
      const initialBranch = git(checkout, ["symbolic-ref", "--short", "HEAD"]);
      const report = targetFiles()["reports/audit-report.md"];

      for (const missingSection of [false, true]) {
        git(checkout, ["switch", "-q", "-c", "sdlc/qa-candidate", base]);
        writeTree(checkout, {
          "docs/qa.md": missingSection ? "candidate with a missing report section\n" : "mechanical candidate\n",
          "reports/audit-report.md": missingSection ? withoutSection(report, "Verification") : report,
        });
        git(checkout, ["add", "--", "docs/qa.md", "reports/audit-report.md"]);
        git(checkout, ["commit", "-q", "-m", "candidate"]);
        const candidate = git(checkout, ["rev-parse", "HEAD"]);
        const bundle = path.join(transport, "aw-qa-candidate.bundle");
        git(checkout, ["bundle", "create", bundle, `${base}..sdlc/qa-candidate`]);
        git(checkout, ["switch", "-q", "--detach", base]);
        git(checkout, ["branch", "-D", "sdlc/qa-candidate"]);
        git(checkout, ["pack-refs", "--all", "--prune"]);
        assert.ok(fs.existsSync(path.join(checkout, ".git", "packed-refs")));
        assert.equal(git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
        assert.equal(git(checkout, ["rev-parse", initialBranch]), base);
        const before = hashTree(path.join(checkout, ".git"));
        const trace = path.join(transport, "git-trace.jsonl");
        fs.writeFileSync(trace, "");
        const scratch = openScratch({ checkout, env: cleanEnv({ GIT_TRACE2_EVENT: trace }), fs });
        try {
          const [transportFile] = snapshotTransportFiles(transport, scratch, fs);
          assert.equal(transportFile.name, "aw-qa-candidate.bundle");
          assert.equal(transportFile.error, undefined);
          const inspected = bundleCommits(scratch, { file: transportFile.file, baseSha: base, fs });
          assert.deepEqual(inspected.tips, [candidate]);
          assert.deepEqual(inspected.commits, [candidate], "the candidate is found although HEAD is back at the base and its branch is gone");
          assert.equal(artifactGit(["show", `${candidate}:reports/audit-report.md`], scratch.options), missingSection ? withoutSection(report, "Verification") : report, "the inspector reads the transported report, not HEAD's copy");
          assert.equal(artifactGit(["show", `${candidate}:docs/qa.md`], scratch.options), missingSection ? "candidate with a missing report section\n" : "mechanical candidate\n");
        } finally {
          scratch.dispose();
          assert.equal(fs.existsSync(scratch.directory), false, "the inspection's scratch repository is removed");
        }
        assert.equal(hashTree(path.join(checkout, ".git")), before, "bundle inspection wrote nothing to the checkout's repository");
        const starts = fs.readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter(({ event }) => event === "start");
        assert.ok(starts.some(({ argv }) => argv.includes("unbundle")));
        assert.ok(starts.some(({ argv }) => argv.includes("--alternate-refs")), "the connectivity check really consulted alternates");
        assert.deepEqual(
          starts.filter(({ argv }) => argv.includes("-C") || argv.some((argument) => /^--git-dir(?:=|$)/.test(argument))).map(({ argv }) => argv.join(" ")),
          [],
          "no git process selected the checkout as its repository",
        );
      }
    } finally {
      forceRemove(root);
    }
  });
}
