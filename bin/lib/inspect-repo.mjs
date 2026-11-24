// Read-only inspection of an onboarding target (AC45): a local path or <owner>/<repo> through GET requests only.
// The target is never modified and no script of it is ever run. The inspection collects the language manifests,
// the workflow files (which of them declare a schedule trigger), the test and build scripts of the root package.json,
// the provenance files and the owners of .github/CODEOWNERS.
//
// An aiam repository is inspected first-class. A library that uses the aiam toolkit (its governance/policy.yaml is the marker) is verified with
// the toolkit's own commands, names the upstream that it imports in governance/upstream-sync.yaml and keeps that upstream's commit in the
// provenance file that the file names; the toolkit itself (a pyproject.toml that declares the package aiam) is verified with its tests. What the
// inspection finds is `aiam` on the result, and `aiam sdlc-preset` of the toolkit prints the document that the synthesis builds from it.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { individualOwners, parseCodeowners } from "./codeowners.mjs";
import { SdlcError } from "./errors.mjs";
import { parseRemoteUrl } from "./central-repo.mjs";
import { isRepoSlug, splitSlug } from "./validators.mjs";

/**
 * The file names that an inspection takes for a provenance file when the manifest names none: a file of this base name, at any depth, is one. A repository that keeps its
 * provenance elsewhere (a registry, a list of sources) is onboarded with its own names in `onboarding.provenanceNames` of the manifest.
 */
export const DEFAULT_PROVENANCE_NAMES = Object.freeze(["source.json", "provenance.json"]);
export const MANIFEST_NAMES = Object.freeze([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
]);
const MANIFEST_EXTENSIONS = [".csproj", ".fsproj", ".vbproj"];
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox"]);
const MAX_FILES = 20000;
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const NPM_PLACEHOLDER_TEST = /no test specified/i;

const AIAM_POLICY = "governance/policy.yaml";
const AIAM_UPSTREAM_SYNC = "governance/upstream-sync.yaml";
const AIAM_PREFERENCES = "governance/cowork-preferences-source.md";
const AIAM_PROVENANCE_FORMAT = "aiam-upstream/1";
const AIAM_INSTANCE_VERIFY = Object.freeze(["aiam validate", "aiam governance codeowners"]);
const AIAM_TOOLKIT_VERIFY = Object.freeze(["python -m pytest -q"]);
const AIAM_IMPORT_COMMAND = "aiam sync-upstream --from <checkout>";
const AIAM_PYTHON_VERSION = "3.12";
const AIAM_INSTALL_STEP = "Install the aiam toolkit";
const AIAM_PACKAGE_DECLARATION = /^\s*name\s*=\s*["']aiam["']/m;
const DEFAULT_CODEOWNERS = ".github/CODEOWNERS";
/** The `path` of the upstream-sync schema of the toolkit: a relative path that stays inside the repository. */
const RELATIVE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000-\u001f]+$/;
const ENGINE_KEYS = ["package", "source", "ref", "private"];
const ENGINE_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENGINE_GITHUB_SOURCE = /^github:([A-Za-z0-9][A-Za-z0-9-]*)\/((?!\.{1,2}$)[A-Za-z0-9._-]+)$/;
// The allow-lists that `aiam reconcile` applies to the same block: the values end up in a shell command and a pip URL.
const ENGINE_GIT_REF = /^(?!\.)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_][A-Za-z0-9._+\/-]*$/;
const ENGINE_PYPI_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const basename = (file) => file.slice(file.lastIndexOf("/") + 1);

/** A reader over a local directory: { list(): string[], read(path): Promise<string|null> }. Files are read, never written. */
export function localReader(directory) {
  const files = [];
  const walk = (relative, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(next, depth + 1);
      } else if (entry.isFile()) {
        files.push(next);
      }
    }
  };
  walk("", 0);
  return {
    list: () => files,
    async read(file) {
      try {
        const absolute = path.join(directory, ...file.split("/"));
        if (fs.statSync(absolute).size > MAX_FILE_BYTES) return null;
        return fs.readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** A reader over a repository on GitHub through read-only GET requests. */
export async function remoteReader({ api, slug, ref }) {
  const { owner, repo } = splitSlug(slug);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const tree = await api.request("GET", `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.status !== 200 || !Array.isArray(tree.json?.tree)) {
    throw new SdlcError(`GET ${base}/git/trees/${ref} answered ${tree.status}: the file list of ${slug} could not be read`, { code: "inspect" });
  }
  const files = tree.json.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
  return {
    truncated: tree.json.truncated === true,
    list: () => files,
    async read(file) {
      const encoded = file.split("/").map(encodeURIComponent).join("/");
      const response = await api.request("GET", `${base}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, { accept: "application/vnd.github.raw+json" });
      if (response.status !== 200) return null;
      return response.text.length > MAX_FILE_BYTES ? null : response.text;
    },
  };
}

/** { repo, defaultBranch, headSha } of a remote repository (GET /repos/{owner}/{repo} and its default-branch commit). */
export async function remoteIdentity({ api, slug }) {
  const { owner, repo } = splitSlug(slug);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const info = await api.request("GET", base);
  if (info.status === 404) throw new SdlcError(`the repository ${slug} was not found or is not readable with the current credentials`, { code: "inspect" });
  if (info.status !== 200 || typeof info.json?.default_branch !== "string") {
    throw new SdlcError(`GET ${base} answered ${info.status}${typeof info.json?.message === "string" ? ` (${info.json.message})` : ""}`, { code: "inspect" });
  }
  const defaultBranch = info.json.default_branch;
  const commit = await api.request("GET", `${base}/commits/${encodeURIComponent(defaultBranch)}`);
  const headSha = commit.status === 200 && SHA.test(String(commit.json?.sha ?? "")) ? commit.json.sha : null;
  return { repo: typeof info.json.full_name === "string" ? info.json.full_name : slug, defaultBranch, headSha };
}

function git(directory, args) {
  const outcome = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return outcome.status === 0 ? outcome.stdout.trim() : null;
}

/** { repo, defaultBranch, headSha } of a local checkout, from its origin remote and its default branch. */
export function localIdentity(directory) {
  const origin = git(directory, ["remote", "get-url", "origin"]);
  const repo = origin === null ? null : parseRemoteUrl(origin);
  if (repo === null) {
    throw new SdlcError(
      `${directory} has no origin remote that names an <owner>/<repo> repository, so its repository cannot be determined; pass <owner/repo> instead of the path`,
      { code: "inspect" },
    );
  }
  const remoteHead = git(directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = remoteHead?.replace(/^origin\//, "") ?? git(directory, ["symbolic-ref", "--short", "HEAD"]);
  if (!defaultBranch) throw new SdlcError(`the default branch of ${directory} cannot be determined`, { code: "inspect" });
  const headSha = [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`, "HEAD"].map((ref) => git(directory, ["rev-parse", "--verify", "-q", ref])).find((sha) => sha && SHA.test(sha)) ?? null;
  return { repo, defaultBranch, headSha };
}

/**
 * The first 40-hex `commit` value of a JSON document and its JSON Pointer (RFC 6901), shallowest first; null when there is none.
 * Objects and arrays are both searched: an element of an array is addressed by its index (`{ "sources": [{ "commit": ... }] }` gives
 * `/sources/0/commit`), and `~` and `/` in a key are escaped as `~0` and `~1`.
 */
export function findCommitPointer(value) {
  const isContainer = (node) => node !== null && typeof node === "object";
  const queue = [{ node: value, pointer: "" }];
  // An index walks the queue instead of shift(), which would be quadratic on a provenance file that holds a very large array.
  for (let next = 0; next < queue.length; next += 1) {
    const { node, pointer } = queue[next];
    if (!isContainer(node)) continue;
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        if (isContainer(child)) queue.push({ node: child, pointer: `${pointer}/${index}` });
      });
      continue;
    }
    if (typeof node.commit === "string" && SHA.test(node.commit)) return { commit: node.commit, pointer: `${pointer}/commit` };
    for (const [key, child] of Object.entries(node)) {
      if (isContainer(child)) queue.push({ node: child, pointer: `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}` });
    }
  }
  return null;
}

function declaresSchedule(text, file) {
  let document;
  try {
    const source = file.endsWith(".md") ? (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "") : text;
    document = YAML.parse(source, { maxAliasCount: 100 });
  } catch {
    return false;
  }
  const on = document?.on ?? document?.true;
  if (typeof on === "string") return on === "schedule";
  if (Array.isArray(on)) return on.includes("schedule");
  return on !== null && typeof on === "object" && "schedule" in on;
}

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The mapping that a YAML file of the repository holds; null, with the reason in `warnings`, when it is unreadable, not YAML or not a mapping. */
async function readYamlMapping(reader, file, warnings) {
  const text = await reader.read(file);
  if (text === null) {
    warnings.push(`${file} could not be read`);
    return null;
  }
  let value;
  try {
    value = YAML.parse(text, { maxAliasCount: 100, logLevel: "error" });
  } catch {
    warnings.push(`${file} is not valid YAML`);
    return null;
  }
  if (!isMapping(value)) {
    warnings.push(`${file} is not a YAML mapping`);
    return null;
  }
  return value;
}

/** Where the generated CODEOWNERS file of an aiam library is: the `codeowners_path` of its policy, relative to the root, or .github/CODEOWNERS. */
function codeownersPathOf(policy) {
  const configured = typeof policy.codeowners_path === "string" ? policy.codeowners_path.trim().replace(/^\/+/, "") : "";
  return configured === "" ? DEFAULT_CODEOWNERS : configured;
}

/**
 * The `setupSteps` that install the toolkit in a cascade workflow, from the `engine` block of a policy: { steps } for a policy that has no block or
 * one that `aiam reconcile` accepts, { steps: [], problem } for one that it would refuse. A problem never quotes the block, because a warning travels to a log.
 *
 * A private engine is installed through three `url.<base>.insteadOf` rewrites that carry ${GH_TOKEN}, set through GIT_CONFIG_COUNT in the environment of that one
 * command. The token is the plain shell variable and never an Actions expression: a manifest string must not hold the expression opener.
 */
function engineSetupSteps(policy) {
  if (!Object.hasOwn(policy, "engine")) return { steps: [] };
  const engine = policy.engine;
  const problem = (text) => ({ steps: [], problem: text });
  if (!isMapping(engine)) return problem("engine must be a mapping with package, source, ref and private");
  if (Object.keys(engine).some((key) => !ENGINE_KEYS.includes(key))) return problem("engine has a key other than package, source, ref and private");
  const packageName = Object.hasOwn(engine, "package") ? engine.package : "aiam";
  const isPrivate = Object.hasOwn(engine, "private") ? engine.private : false;
  const { source, ref } = engine;
  if (typeof packageName !== "string" || !ENGINE_PACKAGE.test(packageName)) return problem("engine.package must be a package name of letters, digits, '.', '_' and '-'");
  if (source === undefined || source === null) return problem("engine.source is required: 'pypi' or 'github:<owner>/<repo>'");
  const github = typeof source === "string" ? ENGINE_GITHUB_SOURCE.exec(source) : null;
  if (typeof source !== "string" || !(source === "pypi" || github) || source.endsWith(".git")) {
    return problem("engine.source must be 'pypi' or 'github:<owner>/<repo>' without a '.git' suffix");
  }
  if (ref === undefined || ref === null) return problem("engine.ref is required: a tag, branch or commit SHA (a version for pypi)");
  if (typeof ref !== "string" || !(source === "pypi" ? ENGINE_PYPI_VERSION : ENGINE_GIT_REF).test(ref)) {
    return problem(`engine.ref must be ${source === "pypi" ? "a version" : "a tag, branch or commit SHA"}, a quoted string without whitespace or shell metacharacters`);
  }
  if (typeof isPrivate !== "boolean") return problem("engine.private must be true or false");
  if (isPrivate && github === null) return problem("engine.private needs a github:<owner>/<repo> source; a PyPI package has no repository to read with a token");

  const slug = github === null ? null : `${github[1]}/${github[2]}`;
  const requirement = github === null ? `${packageName}==${ref}` : `${packageName} @ git+https://github.com/${slug}.git@${ref}`;
  const install = `python -m pip install --quiet "${requirement}"`;
  if (!isPrivate) return { steps: [{ name: AIAM_INSTALL_STEP, run: install }] };
  const token = "${GH_TOKEN}"; // a plain string: the shell, not a template literal, expands it
  const rewrite = `url.https://x-access-token:${token}@github.com/${slug}.insteadOf`;
  const prefixes = [`ssh://git@github.com/${slug}`, `git@github.com:${slug}`, `https://github.com/${slug}`];
  const assignments = ["GIT_TERMINAL_PROMPT=0", `GIT_CONFIG_COUNT=${prefixes.length}`];
  prefixes.forEach((prefix, index) => assignments.push(`GIT_CONFIG_KEY_${index}="${rewrite}"`, `GIT_CONFIG_VALUE_${index}="${prefix}"`));
  return { steps: [{ name: AIAM_INSTALL_STEP, run: [...assignments, install].join(" ") }] };
}

/** Lists the provenance file that governance/upstream-sync.yaml names, unless the name scan listed it already, and warns about a file that is not an aiam one. */
async function listAiamProvenance({ reader, files, warnings, provenanceFiles, provenanceFile, upstreamRepo }) {
  if (!files.includes(provenanceFile)) {
    warnings.push(`${AIAM_UPSTREAM_SYNC} names the provenance file ${provenanceFile}, which the repository does not contain; run aiam sync-upstream once to create it`);
    return;
  }
  const listed = provenanceFiles.some((entry) => entry.path === provenanceFile);
  const text = await reader.read(provenanceFile);
  let document;
  let found = null;
  if (text === null) {
    if (!listed) warnings.push(`${provenanceFile} could not be read`);
  } else {
    try {
      document = JSON.parse(text);
      found = findCommitPointer(document);
    } catch {
      if (!listed) warnings.push(`${provenanceFile} is not valid JSON`);
    }
  }
  if (!listed) {
    provenanceFiles.push({ path: provenanceFile, commit: found?.commit ?? null, pointer: found?.pointer ?? null });
    provenanceFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  if (document === undefined) return;
  if (!isMapping(document) || document.format !== AIAM_PROVENANCE_FORMAT) {
    warnings.push(`${provenanceFile} is not an aiam upstream provenance file (format "${AIAM_PROVENANCE_FORMAT}")`);
  } else if (upstreamRepo !== null && document.repository !== upstreamRepo) {
    warnings.push(`${provenanceFile} records another repository than the upstream_repository of ${AIAM_UPSTREAM_SYNC}`);
  }
}

/** What an aiam library's governance/upstream-sync.yaml says about the cascade into it: the upstream, the provenance file, the import command and what the cascade may change. */
async function readAiamCascade({ reader, files, warnings, provenanceFiles, codeownersPath, setupSteps }) {
  const config = await readYamlMapping(reader, AIAM_UPSTREAM_SYNC, warnings);
  if (config === null) return { kind: "instance" };
  const upstreamRepo = isRepoSlug(config.upstream_repository) ? config.upstream_repository : null;
  if (upstreamRepo === null) warnings.push(`${AIAM_UPSTREAM_SYNC} has no valid upstream_repository (an <owner>/<repo> repository)`);
  const provenanceFile = typeof config.provenance_file === "string" && RELATIVE_PATH.test(config.provenance_file) ? config.provenance_file : null;
  if (provenanceFile === null) warnings.push(`${AIAM_UPSTREAM_SYNC} has no valid provenance_file (a path inside the repository)`);
  else await listAiamProvenance({ reader, files, warnings, provenanceFiles, provenanceFile, upstreamRepo });
  return {
    kind: "instance",
    upstreamRepo,
    provenanceFile,
    importCommands: [AIAM_IMPORT_COMMAND],
    allowedFiles: ["assets/**", AIAM_PREFERENCES, codeownersPath, ...(provenanceFile === null ? [] : [provenanceFile])],
    pythonVersion: AIAM_PYTHON_VERSION,
    setupSteps,
  };
}

/**
 * @param {{ list(): string[], read(path: string): Promise<string|null> }} reader
 * @param {{ repo: string, defaultBranch: string, headSha: string|null }} identity
 * @param {{ provenanceNames?: readonly string[] }} [options] the base names of the provenance files (DEFAULT_PROVENANCE_NAMES when omitted; an empty list names none)
 */
export async function inspectRepository(reader, identity, { provenanceNames = DEFAULT_PROVENANCE_NAMES } = {}) {
  const files = reader.list();
  const warnings = [];
  const packageManifests = files
    .filter((file) => MANIFEST_NAMES.includes(basename(file)) || MANIFEST_EXTENSIONS.some((extension) => file.endsWith(extension)))
    .sort();

  let scriptNames = [];
  const rootPackage = files.includes("package.json") ? await reader.read("package.json") : null;
  if (rootPackage !== null) {
    try {
      const parsed = JSON.parse(rootPackage);
      if (parsed?.scripts && typeof parsed.scripts === "object") {
        scriptNames = Object.keys(parsed.scripts).filter((name) => typeof parsed.scripts[name] === "string" && !(name === "test" && NPM_PLACEHOLDER_TEST.test(parsed.scripts[name])));
        if (typeof parsed.scripts.test === "string" && NPM_PLACEHOLDER_TEST.test(parsed.scripts.test)) warnings.push("package.json has only the placeholder test script of npm init, which is not treated as a test script");
      }
    } catch {
      warnings.push("package.json is not valid JSON; no script was read from it");
    }
  }
  const buildCommands = scriptNames.includes("build") ? ["npm run build"] : [];
  let verifyCommands = scriptNames.includes("test") ? ["npm test"] : [];

  // An aiam library (its policy is the marker) is verified with the toolkit's commands, and its policy says where its CODEOWNERS file is and how the toolkit is
  // installed. The toolkit itself has no policy, and declares its package in a pyproject.toml. Neither is a reason to warn that there is no package.json.
  let aiam = null;
  let codeownersPath = DEFAULT_CODEOWNERS;
  let engineSteps = [];
  if (files.includes(AIAM_POLICY)) {
    verifyCommands = [...AIAM_INSTANCE_VERIFY];
    aiam = { kind: "instance" };
    const policy = await readYamlMapping(reader, AIAM_POLICY, warnings);
    if (policy !== null) {
      codeownersPath = codeownersPathOf(policy);
      const engine = engineSetupSteps(policy);
      if (engine.problem !== undefined) warnings.push(`${AIAM_POLICY}: ${engine.problem}; no step that installs the toolkit was synthesized`);
      else engineSteps = engine.steps;
    }
  } else if (files.includes("pyproject.toml")) {
    const pyproject = await reader.read("pyproject.toml");
    if (pyproject !== null && AIAM_PACKAGE_DECLARATION.test(pyproject)) {
      verifyCommands = [...AIAM_TOOLKIT_VERIFY];
      aiam = { kind: "engine" };
    }
  }
  if (verifyCommands.length === 0) {
    warnings.push(
      rootPackage === null
        ? "the repository has no package.json at its root, so verifyCommands is empty (S5 never invents a command); a drift-enabled project needs at least one verify command in sdlc.yaml"
        : "package.json has no test script, so verifyCommands is empty (S5 never invents a command); a drift-enabled project needs at least one verify command in sdlc.yaml",
    );
  }

  const workflows = [];
  for (const file of files.filter((candidate) => /^\.github\/workflows\/[^/]+\.(?:ya?ml|md)$/.test(candidate)).sort()) {
    const text = await reader.read(file);
    workflows.push({ path: file, scheduled: text !== null && declaresSchedule(text, file) });
  }

  const provenanceFiles = [];
  for (const file of files.filter((candidate) => provenanceNames.includes(basename(candidate))).sort()) {
    let pointer = null;
    let commit = null;
    if (file.endsWith(".json")) {
      const text = await reader.read(file);
      try {
        const found = text === null ? null : findCommitPointer(JSON.parse(text));
        if (found) {
          commit = found.commit;
          pointer = found.pointer;
        }
      } catch {
        warnings.push(`${file} is not valid JSON`);
      }
    }
    provenanceFiles.push({ path: file, commit, pointer });
  }

  if (aiam?.kind === "instance" && files.includes(AIAM_UPSTREAM_SYNC)) {
    aiam = await readAiamCascade({ reader, files, warnings, provenanceFiles, codeownersPath, setupSteps: engineSteps });
  }

  const codeownersText = files.includes(codeownersPath) ? await reader.read(codeownersPath) : null;
  const codeowners =
    codeownersText === null
      ? { present: false, individuals: [], teams: [] }
      : { present: true, individuals: individualOwners(codeownersText), teams: parseCodeowners(codeownersText).teams };

  return {
    repo: identity.repo,
    defaultBranch: identity.defaultBranch,
    headSha: identity.headSha ?? null,
    packageManifests,
    scriptNames,
    buildCommands,
    verifyCommands,
    importScripts: scriptNames.filter((name) => name.startsWith("import:")),
    workflows,
    provenanceFiles,
    codeowners,
    warnings,
    ...(aiam === null ? {} : { aiam }),
  };
}

/** Whether a --repo value names a repository (<owner>/<repo>) rather than an existing local path. */
export function classifyTarget(value, cwd) {
  const asPath = path.resolve(cwd, value);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) return { kind: "local", directory: asPath };
  if (isRepoSlug(value)) return { kind: "remote", slug: value };
  throw new SdlcError(`--repo '${value}' is neither an existing directory nor an <owner>/<repo> repository`, { code: "inspect" });
}
