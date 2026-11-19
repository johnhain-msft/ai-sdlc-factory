// A fixture repository has to work under a long temp path. On Windows git refuses to write an object file whose path passes 260 characters unless core.longpaths is on, and a
// sha256 repository (64 hexadecimal characters in a file name) passes the limit in a temp directory that a sha1 one does not: the bundle test of s2/qa-transport-boundaries
// failed in a per-file temp directory for exactly that reason. The fixture config turns core.longpaths on, so the location of a test's temp dir does not decide whether it passes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempDir, writeTree } from "./helpers/fixtures.mjs";
import { git, writeGitFixtureConfig } from "./helpers/git-fixture.mjs";

// The working directory of a process cannot pass 260 characters on Windows, but the object files below it can: the directory is sized to 215, so that
// <directory>/.git/objects/xx/<object name> is over the limit for both object formats (293 for sha256, 269 for sha1).
const DIRECTORY_LENGTH = 215;

for (const format of ["sha1", "sha256"]) {
  test(`a ${format} fixture repository adds and commits under a path whose object files pass 260 characters`, (t) => {
    const root = tempDir("sdlc-longpath-");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "d".repeat(Math.max(1, DIRECTORY_LENGTH - root.length - 1)));
    fs.mkdirSync(dir, { recursive: true });
    const objectName = format === "sha256" ? 62 : 38;
    assert.ok(path.join(dir, ".git", "objects", "00", "0".repeat(objectName)).length > 260, "the object files are over the limit");
    git(dir, ["init", "-q", `--object-format=${format}`]);
    writeGitFixtureConfig(dir);
    writeTree(dir, { "a.txt": "a\n", "docs/b.txt": "b\n" });
    git(dir, ["add", "--", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    assert.equal(git(dir, ["status", "--porcelain"]), "");
    assert.equal(git(dir, ["rev-parse", "HEAD"]).length, format === "sha256" ? 64 : 40);
  });
}

test("the fixture config names core.longpaths, and keeps the settings that it always had", (t) => {
  const dir = tempDir("sdlc-fixture-config-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeGitFixtureConfig(dir);
  const config = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
  assert.match(config, /\blongpaths = true\b/);
  assert.match(config, /autocrlf = false/);
  assert.match(config, /gpgsign = false/);
  assert.equal(git(dir, ["config", "--get", "core.longpaths"]), "true");
});
