// The README is what an adopter reads first. These tests keep it true: it states the gh-aw prerequisite with the reason that the code gives, every command and flag
// that it shows is one that the package has, the snippets that it tells you to write are valid (the dependency, the manifest, the shell blocks), and its
// sections come in the order in which you need them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { engineSecretNames } from "../../bin/lib/actions-secrets.mjs";
import { BOOTSTRAP_USAGE, ENGINES, MODES, ONBOARD_USAGE, STRATEGIES } from "../../bin/lib/cli-flags.mjs";
import { ADVISORY_ID, MIN_GH_AW_VERSION } from "../../bin/lib/ghaw-version.mjs";
import { POLL_TIMEOUT_MS } from "../../bin/lib/installations.mjs";
import { FLOW_TIMEOUT_MS } from "../../bin/lib/manifest-flow.mjs";
import { renderFleet } from "../../src/reconcile.mjs";
import { createWorkspace, referenceRequest } from "../helpers/mini-fleet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json"));

/** The fenced blocks of the README: [{ language, body }], with the indentation of a block inside a list item removed. */
function fences(markdown) {
  return [...markdown.matchAll(/^([ \t]*)```([A-Za-z]*)\n([\s\S]*?)^[ \t]*```$/gm)].map((match) => ({
    language: match[2],
    body: match[3].split("\n").map((line) => (line.startsWith(match[1]) ? line.slice(match[1].length) : line)).join("\n"),
  }));
}

/** The text of the section that starts at the heading `## <title>` or `### <title>`, up to the next heading of the same or a higher level. */
function section(title) {
  const match = new RegExp(`^(#{2,3}) ${title.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m").exec(readme);
  assert.ok(match !== null, `the heading '${title}' exists`);
  const rest = readme.slice(match.index + match[0].length);
  const end = rest.search(new RegExp(`^#{2,${match[1].length}} `, "m"));
  return end === -1 ? rest : rest.slice(0, end);
}

const flagsOf = (text) => [...new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((match) => match[0]))].sort();

// ---------------------------------------------------------------------------------------------------------------------
// Prerequisites: gh-aw, and why
// ---------------------------------------------------------------------------------------------------------------------

test("the README requires the gh-aw version that the commands enforce, and says it is the project's floor", () => {
  const prerequisites = section("Prerequisites");
  assert.match(prerequisites, new RegExp(`gh-aw extension, version ${MIN_GH_AW_VERSION.replaceAll(".", "\\.")} or newer`));
  assert.match(prerequisites, new RegExp(`This project requires ${MIN_GH_AW_VERSION.replaceAll(".", "\\.")}, which is the floor it chose`));
  assert.match(prerequisites, /Node\.js 22 or newer/);
  assert.equal(pkg.engines.node, ">=22");
  assert.match(prerequisites, /gh aw version/);
});

test("the README names the advisory, the range of releases that it affects (as the code states it) and the fix", () => {
  const range = /gh-aw >= (\d+\.\d+\.\d+) and < (\d+\.\d+\.\d+)/.exec(read("bin", "lib", "ghaw-version.mjs"));
  assert.ok(range !== null, "the code states the range");
  const prerequisites = section("Prerequisites");
  assert.ok(prerequisites.includes(ADVISORY_ID), "the advisory id");
  assert.ok(prerequisites.includes(`\`>= ${range[1]}\` and \`< ${range[2]}\``), `the affected range ${range[1]} to ${range[2]}`);
  assert.ok(prerequisites.includes(`The fix is in ${range[2]}`));
  assert.ok(prerequisites.includes("safe-outputs-items"), "what the advisory is about");
  assert.ok(prerequisites.includes("CI trigger tokens"));
});

test("the README says why upgrading the CLI is not enough: gh aw upgrade, and committing the regenerated .lock.yml files", () => {
  const prerequisites = section("Prerequisites");
  assert.match(prerequisites, /`gh aw upgrade`/);
  assert.match(prerequisites, /regenerated `\.lock\.yml` files/);
  assert.match(prerequisites, /SHA-pinned action references/);
});

test("the README says which commands refuse an older gh-aw, and that is true of the code", () => {
  assert.match(section("Prerequisites"), /`sdlc-bootstrap` and `sdlc-onboard` refuse to run with an older gh-aw/);
  for (const file of ["bootstrap-run.mjs", "onboard-run.mjs"]) assert.match(read("bin", "lib", file), /assertGhAwVersion\(/, file);
  assert.match(read("bin", "lib", "reconcile-client.mjs"), /minGhAwVersion: "1\.0\.1"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------------------------------

test("the README shows the dependency at the release tag of this package, with <owner> for the account that hosts the factory", () => {
  const block = fences(section("Install")).find((entry) => entry.language === "json");
  assert.ok(block !== undefined);
  const parsed = JSON.parse(block.body);
  assert.equal(parsed.dependencies["ai-sdlc-factory"], `github:<owner>/ai-sdlc-factory#v${pkg.version}`);
  assert.equal(parsed.private, true);
});

test("the manifest that the README tells you to write is accepted by the renderer, and an empty fleet renders only the onboarding workflow and its config", (t) => {
  const block = fences(section("Install")).find((entry) => entry.language === "yaml" && entry.body.includes("factory:"));
  assert.ok(block !== undefined);
  const text = block.body.replaceAll("<owner>", "example-org");
  assert.deepEqual(YAML.parse(text).factory, { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: true });
  const work = createWorkspace(t, { text, files: { "package.json": JSON.stringify({ name: "my-orchestrator", dependencies: { "ai-sdlc-factory": "github:example-org/ai-sdlc-factory#v0.1.0" } }) } });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.deepEqual([...result.files.keys()].sort(), [".github/workflows/aw.json", ".github/workflows/sdlc-onboard.md"]);
});

test("the README tells you to commit the lockfile, to use origin for the repository, and links the private-factory page and the state dialect", () => {
  const install = section("Install");
  assert.match(install, /commit `package\.json` and `package-lock\.json`/);
  assert.match(install, /`origin` remote points at GitHub/);
  assert.match(readme, /\(docs\/private-engine\.md\)/);
  assert.match(install, /\(docs\/architecture\.md#the-state-dialect\)/);
  assert.match(section("Private factory"), /`factory\.private: false` and run `sdlc-reconcile`|`factory\.private` to `false`|set `factory\.private: false`/);
  assert.match(section("Private factory"), /`sdlc-bootstrap` checks this when `factory\.private` is `true`/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------

const normalize = (text) => text.replace(/\s+/g, " ").trim();

test("the README has a section and a usage block for each command that the package installs", () => {
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["sdlc-bootstrap", "sdlc-onboard", "sdlc-reconcile"]);
  for (const command of Object.keys(pkg.bin)) {
    const body = section(command);
    const usage = fences(body).find((entry) => entry.language === "text");
    assert.ok(usage !== undefined, `${command} has a usage block`);
    assert.ok(usage.body.trimStart().startsWith(`npx ${command} `), `${command}: the usage starts with npx ${command}`);
  }
});

test("the usage of sdlc-bootstrap in the README is the usage of the command: the same flags and the same engines", () => {
  const usage = fences(section("sdlc-bootstrap")).find((entry) => entry.language === "text").body;
  assert.deepEqual(flagsOf(usage), flagsOf(BOOTSTRAP_USAGE));
  assert.ok(normalize(usage).includes(`[--engine ${ENGINES.join("|")}]`));
  assert.ok(normalize(usage).includes("[--app-name <up to 34 characters>]"));
});

test("the usage of sdlc-onboard in the README is the usage of the command: the same flags, strategies and modes", () => {
  const usage = fences(section("sdlc-onboard")).find((entry) => entry.language === "text").body;
  assert.deepEqual(flagsOf(usage), flagsOf(ONBOARD_USAGE));
  assert.ok(normalize(usage).includes(`[--strategy ${STRATEGIES.join("|")}]`));
  assert.ok(normalize(usage).includes(`[--mode ${MODES.join("|")}]`));
  assert.ok(normalize(usage).includes("--repo <owner/repo-or-path>"));
});

test("the usage of sdlc-reconcile in the README is the usage that the command prints", () => {
  const usage = fences(section("sdlc-reconcile")).find((entry) => entry.language === "text").body.trim();
  assert.equal(usage, "npx sdlc-reconcile --request <file>");
  const run = spawnSync(process.execPath, [path.join(ROOT, "bin", "sdlc-reconcile.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("--request <file>"));
  assert.ok(run.stdout.includes("sdlc-reconcile --request <file>"));
});

test("every flag that the README shows in a command block is a flag of one of the three commands", () => {
  const known = new Set([...flagsOf(BOOTSTRAP_USAGE), ...flagsOf(ONBOARD_USAGE), "--request", "--help", "--ignore-scripts", "--non-interactive", "--tree", "--compile"]);
  for (const block of fences(readme)) {
    for (const line of block.body.split("\n")) {
      if (!/\b(?:sdlc-(?:bootstrap|onboard|reconcile)|ai-sdlc-factory)\b/.test(line) || /^\s*"/.test(line)) continue;
      for (const flag of flagsOf(line)) assert.ok(known.has(flag), `${flag} in: ${line.trim()}`);
    }
  }
});

test("the environment variables of the README's table are the ones that the commands read, and the README names the key of every engine", () => {
  const table = tableRows(section("sdlc-bootstrap"));
  const documented = table.flatMap(([names]) => [...names.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]));
  const sources = ["bin/lib", "src/lib"].flatMap((directory) => fs.readdirSync(path.join(ROOT, directory)).filter((name) => name.endsWith(".mjs")).map((name) => read(...directory.split("/"), name)));
  const everything = sources.join("\n");
  for (const name of documented) {
    const read_ = ["GH_TOKEN", "GITHUB_TOKEN"].includes(name) ? /\bGH_TOKEN\b/.test(everything) && /\bGITHUB_TOKEN\b/.test(everything) : everything.includes(name) || ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY"].includes(name);
    assert.ok(read_, `${name} is read by the commands`);
  }
  for (const engine of ENGINES.filter((candidate) => candidate !== "copilot")) {
    for (const name of engineSecretNames(engine)) assert.ok(documented.includes(name), `${name} (${engine}) is in the table`);
  }
  for (const name of ["APP_CLIENT_ID", "APP_PRIVATE_KEY", "COPILOT_GITHUB_TOKEN", "SDLC_MANIFEST", "SDLC_BOOTSTRAP_NO_OPEN_BROWSER", "SDLC_GH_AW_DATA_HOME"]) assert.ok(documented.includes(name), `${name} is in the table`);
});

/** The rows of the first table of a section: arrays of trimmed cells. */
function tableRows(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.slice(1, line.lastIndexOf("|")).split("|").map((cell) => cell.trim()));
}

test("the README says what the bootstrap does, step by step, in the order in which it does it", () => {
  const body = section("sdlc-bootstrap");
  const steps = [...body.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => match[2]);
  const expected = [
    /^checks that gh-aw is 1\.0\.1 or newer;$/,
    /^reads the manifest and resolves the orchestrator repository from `origin`;$/,
    /^registers a GitHub App through GitHub's manifest flow in your browser, or uses the one that `APP_CLIENT_ID` and `APP_PRIVATE_KEY` name, and checks that its permissions stay within a fixed ceiling;$/,
    /^checks, for up to ten minutes, that the App is installed with the required permissions on every repository that it needs, and after a new registration sends you to the installation page of each account;$/,
    /^sets the Actions variable `APP_CLIENT_ID` and one `SDLC_SYNC_STATE_<SLUG>` variable for each edge \(it creates a state variable only when it does not exist, and never changes an existing one\);$/,
    /^sets the secret `APP_PRIVATE_KEY` and the credential of the engine you chose, if it has one;$/,
    /^with `--deconflict-upstream-schedules`, disables the in-repository schedules that the manifest names, with your own credentials;$/,
    /^runs the reconciler, then `gh aw validate` and `gh aw doctor`, and prints a summary report\.$/,
  ];
  assert.equal(steps.length, expected.length, steps.join("\n"));
  expected.forEach((pattern, index) => assert.match(steps[index], pattern, `step ${index + 1}`));
  // The numbers in the steps are the numbers in the code.
  assert.equal(MIN_GH_AW_VERSION, "1.0.1");
  assert.equal(POLL_TIMEOUT_MS, 10 * 60 * 1000, "the installation check waits for ten minutes");
  assert.equal(FLOW_TIMEOUT_MS, 10 * 60 * 1000, "the registration waits for ten minutes");
  assert.match(read("bin", "lib", "bootstrap-run.mjs"), /--deconflict-upstream-schedules|deconflictUpstreamSchedules/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------------------------------------------------

test("the update steps install the tag with the same three URL rewrites that the workflows use, regenerate with sdlc-reconcile and point at the changelog", () => {
  const body = section("Updating");
  for (const rewrite of ["ssh://git@github.com/$repo", "git@github.com:$repo", "https://github.com/$repo"]) assert.ok(body.includes(rewrite), rewrite);
  assert.ok(body.includes("GIT_CONFIG_COUNT"));
  assert.ok(body.includes("npx sdlc-reconcile --request <request.json>"));
  assert.match(body, /\[Breaking and Migration notes\]\(CHANGELOG\.md\)/);
  assert.match(body, /Do not update `sdlc-onboard\.md` with `gh aw update`/);
  assert.match(body, /`package\.json`, `package-lock\.json` and `\.github\/workflows` together/);
});

const have = (command, args) => spawnSync(command, args, { encoding: "utf8" }).status === 0;

test("the bash blocks of the README are valid bash", { skip: have("bash", ["--version"]) ? false : "bash is not installed" }, () => {
  const blocks = fences(readme).filter((entry) => entry.language === "bash");
  assert.ok(blocks.length >= 2);
  // The script goes in through stdin: a bash that is not native to the host (WSL, for one) cannot open a path of the host.
  blocks.forEach((block, index) => {
    const outcome = spawnSync("bash", ["-n"], { input: block.body, encoding: "utf8" });
    assert.equal(outcome.status, 0, `block ${index}: ${outcome.stderr}`);
  });
});

const powershell = ["pwsh", "powershell"].find((name) => have(name, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]));

test("the PowerShell blocks of the README parse", { skip: powershell ? false : "PowerShell is not installed" }, (t) => {
  const blocks = fences(readme).filter((entry) => entry.language === "powershell");
  assert.ok(blocks.length >= 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-readme-ps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  blocks.forEach((block, index) => {
    const file = path.join(dir, `block-${index}.ps1`);
    fs.writeFileSync(file, block.body);
    const script = `$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    const outcome = spawnSync(powershell, ["-NoProfile", "-Command", script], { encoding: "utf8" });
    assert.equal(outcome.status, 0, `block ${index}: ${outcome.stdout}${outcome.stderr}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Limitations, development, license and the order of the sections
// ---------------------------------------------------------------------------------------------------------------------

test("the README lists the known limitations: the onboarding workflow, and the install that fails without an issue", () => {
  const body = section("Known limitations");
  assert.match(body, /The onboarding workflow cannot complete on its own/);
  assert.match(body, /installs neither the factory nor the gh-aw CLI/);
  assert.match(body, /Run `sdlc-onboard` from your machine/);
  assert.match(body, /`escalate_failure` or `finalize_poll_state`/);
  assert.match(read("docs", "architecture.md"), /Run `sdlc-onboard` from your own machine/);
});

test("the development commands of the README are commands of this repository", () => {
  const body = section("Development");
  for (const command of ["npm ci", "npm test", "node tools/leak-guard/scan.mjs --tree", "node tools/update-payload.mjs"]) assert.ok(body.includes(command), command);
  assert.ok(pkg.scripts.test && pkg.scripts["leak-guard"]);
  assert.ok(fs.existsSync(path.join(ROOT, "tools", "leak-guard", "scan.mjs")));
  assert.ok(fs.existsSync(path.join(ROOT, "tools", "update-payload.mjs")));
  assert.match(body, /SDLC_REAL_GH_AW=1/);
  assert.match(body, /`examples\/` is a synthetic reference preset/);
});

test("the README ends with the license, which is MIT, and the LICENSE file says so", () => {
  assert.match(section("License"), /MIT\. See \[LICENSE\]\(LICENSE\)\./);
  assert.match(read("LICENSE"), /^MIT License\n/);
  assert.equal(pkg.license, "MIT");
});

test("the sections of the README come in the order in which you need them", () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  const wanted = ["Prerequisites", "Install", "Commands", "Manifest", "Updating", "Known limitations", "Development", "License"];
  const positions = wanted.map((heading) => headings.indexOf(heading));
  assert.ok(positions.every((position) => position !== -1), `every section exists: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(readme, /^# ai-sdlc-factory\n\n.{200,}\n/s, "a paragraph that says what it is comes first");
});
