#!/usr/bin/env node
// Runs every test file of the repository in a process of its own, with a time limit for each (design M step 7).
//
//   node tools/run-each.mjs [--concurrency <n>] [--timeout <seconds>] [--grep <regex>] [--report <file>] [--tmp-root <dir>] [--fail-on-leak] [--list] [<file or directory> ...]
//
// Why one process per file: `node --test` with a shared run hides which file hangs or leaves state behind, and a file that passes only after another has run is not a
// passing file. Here every file stands alone. The heavy files (real git, real bash, child node processes) take minutes on a busy Windows host, so the default is one at a time
// and a long limit; raise --concurrency for the light ones.
//
// --tmp-root <dir> gives every file its own empty temp directory under <dir> (TEMP, TMP and TMPDIR of the process, so os.tmpdir(), mktemp and every child agree), and reports what the
// file left in it once the process is gone: a test that does not clean up after itself, or a child that ignores the variables, is named. The run's own temp root is then never
// touched. --fail-on-leak makes a leftover a failure of the file (status LEAK). Without --tmp-root the files run in the environment they are given.
//
// Defaults: every tests/**/*.test.mjs, --concurrency 1, --timeout 900. A file is
//   PASS     every test passed (at least one test ran)
//   FAIL     a test failed, or the file could not be loaded
//   TIMEOUT  it did not finish in time; the process tree is killed
//   EMPTY    the process exited without running a test
//   LEAK     it passed, but left something in its temp directory, and --fail-on-leak was given
// Exit code: 0 when every file passes, 1 otherwise, 2 for a usage error. --report writes the same results as JSON.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  process.stderr.write(`${message}\nusage: node tools/run-each.mjs [--concurrency <n>] [--timeout <seconds>] [--grep <regex>] [--report <file>] [--tmp-root <dir>] [--fail-on-leak] [--list] [<file or directory> ...]\n`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { concurrency: 1, timeout: 900, grep: null, report: null, tmpRoot: null, failOnLeak: false, list: false, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) usage(`${argument} needs a value`);
      index += 1;
      return argv[index];
    };
    if (argument === "--concurrency") options.concurrency = Number(value());
    else if (argument === "--timeout") options.timeout = Number(value());
    else if (argument === "--grep") options.grep = new RegExp(value());
    else if (argument === "--report") options.report = path.resolve(value());
    else if (argument === "--tmp-root") options.tmpRoot = path.resolve(value());
    else if (argument === "--fail-on-leak") options.failOnLeak = true;
    else if (argument === "--list") options.list = true;
    else if (argument.startsWith("--")) usage(`unknown option ${argument}`);
    else options.targets.push(argument);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) usage("--concurrency must be a positive integer");
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) usage("--timeout must be a positive number of seconds");
  if (options.failOnLeak && options.tmpRoot === null) usage("--fail-on-leak needs --tmp-root: the leftovers are counted in the temp dir that it gives each file");
  return options;
}

/** The test files below a directory, sorted, as paths relative to the repository root with forward slashes. */
function testFilesIn(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.mjs")) found.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(directory);
  return found.sort();
}

function selectFiles({ targets, grep }) {
  let files = [];
  if (targets.length === 0) files = testFilesIn(path.join(ROOT, "tests"));
  for (const target of targets) {
    const absolute = path.resolve(target);
    if (!fs.existsSync(absolute)) usage(`${target} does not exist`);
    if (fs.statSync(absolute).isDirectory()) files.push(...testFilesIn(absolute));
    else files.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
  }
  files = [...new Set(files)];
  return grep === null ? files : files.filter((file) => grep.test(file));
}

/** Kills a process and everything that it started (node --test starts a child per file; those start git, bash and node). */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** The name of the temp directory that a file gets: its path below tests/ with the separators and the suffix taken out; a file outside the repository gets a short one. */
const slugOf = (file, index) => (file.startsWith("../") ? `external-${index}-${path.basename(file).replace(/\.test\.mjs$/, "")}` : file.replace(/^tests\//, "").replace(/\.test\.mjs$/, "").replace(/[^A-Za-z0-9._-]+/g, "__"));

function runFile(file, timeoutSeconds, tmpDir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = tmpDir === null ? { ...process.env } : { ...process.env, TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir };
    // started from inside a test (`node --test` sets this), the runner of a child would report as a subtest and print no TAP: every file is a run of its own
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], { cwd: ROOT, env, windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const count = (name) => Number((new RegExp(`^# ${name} (\\d+)`, "m").exec(output) ?? [])[1] ?? 0);
      const result = { file, seconds: (Date.now() - started) / 1000, exitCode: code, tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo") };
      result.status = timedOut ? "TIMEOUT" : result.tests === 0 ? "EMPTY" : code === 0 && result.fail === 0 ? "PASS" : "FAIL";
      result.failed = [...output.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((match) => match[1]).slice(0, 12);
      if (result.status === "FAIL" && result.failed.length === 0) result.failed = [output.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300)];
      // what is left once the process tree is gone (a killed run leaves what its exit handlers did not remove, which is also reported)
      result.leaked = tmpDir === null ? [] : fs.readdirSync(tmpDir).sort();
      resolve(result);
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = selectFiles(options);
  if (options.list) {
    process.stdout.write(`${files.join("\n")}\n`);
    return;
  }
  if (files.length === 0) usage("no test file was selected");
  const tmpDirs = new Map();
  if (options.tmpRoot !== null) {
    for (const [index, file] of files.entries()) {
      const dir = path.join(options.tmpRoot, slugOf(file, index));
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) usage(`${dir} is not empty: the temp dir of a file has to start empty, or what it leaves cannot be counted`);
      fs.mkdirSync(dir, { recursive: true });
      tmpDirs.set(file, dir);
    }
  }
  const results = new Array(files.length);
  let next = 0;
  const began = Date.now();
  const worker = async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      const result = await runFile(files[index], options.timeout, tmpDirs.get(files[index]) ?? null);
      if (result.status === "PASS" && result.leaked.length > 0 && options.failOnLeak) result.status = "LEAK";
      results[index] = result;
      const detail = result.status === "PASS" || result.status === "LEAK" ? `${result.pass} pass` : result.status === "TIMEOUT" ? `no result in ${options.timeout} s` : `${result.fail} fail, ${result.pass} pass`;
      const leak = result.leaked.length > 0 ? `  leaked ${result.leaked.length}: ${result.leaked.slice(0, 3).join(", ")}${result.leaked.length > 3 ? ", ..." : ""}` : "";
      process.stdout.write(`${result.status.padEnd(7)} ${result.seconds.toFixed(1).padStart(7)}s  ${result.file}  (${detail})${leak}\n`);
      for (const name of result.status === "PASS" || result.status === "LEAK" ? [] : result.failed) process.stdout.write(`          x ${name}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, worker));

  const by = (status) => results.filter((result) => result.status === status);
  const total = (key) => results.reduce((sum, result) => sum + result[key], 0);
  const leakers = results.filter((result) => result.leaked.length > 0).length;
  process.stdout.write(
    `\n${files.length} files in ${((Date.now() - began) / 1000).toFixed(0)} s: ${by("PASS").length} pass, ${by("FAIL").length} fail, ${by("TIMEOUT").length} timeout, ${by("EMPTY").length} empty` +
      `${options.failOnLeak ? `, ${by("LEAK").length} leak` : ""}; ${total("pass")} tests passed, ${total("fail")} failed, ${total("skipped")} skipped, ${total("todo")} todo\n`,
  );
  if (options.tmpRoot !== null) process.stdout.write(`${leakers} file(s) left something in their temp dir (${results.reduce((sum, result) => sum + result.leaked.length, 0)} entries), under ${options.tmpRoot}\n`);
  if (options.report !== null) fs.writeFileSync(options.report, `${JSON.stringify({ files: results }, null, 2)}\n`);
  process.exitCode = results.every((result) => result.status === "PASS") ? 0 : 1;
}

await main();
