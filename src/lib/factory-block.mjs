// The `factory` block of the fleet manifest: where the factory package (this engine) runs from in the orchestrator workspace, and how a job installs it.
//
//   factory:
//     package: ai-sdlc-factory                       # the npm dependency of the workspace
//     source: github:<owner>/<repo>                  # the repository that the install token is minted for (no ref: package.json and the lock pin the version)
//     private: true                                  # false once that repository is public: the token step and the git rewrites then disappear
//     dir: node_modules/ai-sdlc-factory              # optional; "." means the workspace root
//
// No block, or `dir: "."`, means the engine is in the workspace itself: every rendered path is `$GITHUB_WORKSPACE/src/...`, and the jobs that install
// it keep the checkout and install they always had. One resolver serves the renderer, the router and the bootstrap, so that they cannot disagree.
// Pure: no imports, no reads.

/** The id of the step that mints the factory read token (not `create-token`, which gh-aw wires specially). */
export const FACTORY_TOKEN_STEP_ID = "factory_token";

const SOURCE = /^github:([A-Za-z0-9][A-Za-z0-9-]*)\/((?!\.{1,2}$)[A-Za-z0-9._-]+)$/;

/** A repository-relative directory, normalized: `./a//b/` is `a/b`, and a path with nothing in it is `.`. */
export const normalizeFactoryDir = (value) => {
  const parts = String(value).split("/").filter((part) => part !== "" && part !== ".");
  return parts.length === 0 ? "." : parts.join("/");
};
const normalizeDir = normalizeFactoryDir;

export const FACTORY_DIR_MAX_LENGTH = 200;

/** Why a `factory.dir` cannot be interpolated into shell text and into a path of the workspace, or null. */
export function factoryDirProblem(dir) {
  if (dir.length > FACTORY_DIR_MAX_LENGTH) return `is longer than ${FACTORY_DIR_MAX_LENGTH} characters`;
  if (!/^[A-Za-z0-9._@/-]+$/.test(dir)) return "may use only the characters A-Z a-z 0-9 . _ @ / - (it is interpolated into shell text)";
  if (dir.startsWith("/")) return "must be relative to the repository root, not absolute";
  if (dir.startsWith("-")) return "must not start with '-'";
  if (dir.split("/").includes("..")) return "must not contain a '..' segment";
  return null;
}

/**
 * Why a string cannot be an entry of `driftAudit.stagedScripts` (a workspace-relative .mjs script that prepare-run stages), or null. The entries travel on a
 * command line as one comma-separated word and become paths of the stage, so they are plain: no comma, space, quote or other shell character, no absolute path,
 * no empty, `.` or `..` segment, no leading dash, and a name before the `.mjs` suffix. The schema states the same rule as a pattern.
 */
export function stagedScriptProblem(script) {
  if (typeof script !== "string" || script === "") return "is empty";
  if (script.length > FACTORY_DIR_MAX_LENGTH) return `is longer than ${FACTORY_DIR_MAX_LENGTH} characters`;
  if (!/^[A-Za-z0-9._@+/-]+$/.test(script)) return "may use only the characters A-Z a-z 0-9 . _ @ + / - (it is passed on a command line)";
  if (script.startsWith("/")) return "must be relative to the workspace, not absolute";
  if (script.startsWith("-")) return "must not start with '-'";
  const segments = script.split("/");
  if (segments.includes("..")) return "must not contain a '..' segment";
  if (segments.includes("") || segments.includes(".")) return "must not contain an empty or '.' segment";
  if (!/[A-Za-z0-9_@+-]\.mjs$/.test(script)) return "must name an .mjs file";
  return null;
}

/**
 * @param {object} manifest a parsed manifest (only `factory` is read)
 * @returns {{ declared: boolean, inWorkspace: boolean, package: string | null, source: string | null, owner: string | null, repo: string | null,
 *   private: boolean, dir: string }}
 */
export function resolveFactory(manifest) {
  const block = manifest?.factory;
  if (block === undefined || block === null) {
    return { declared: false, inWorkspace: true, package: null, source: null, owner: null, repo: null, private: false, dir: "." };
  }
  const dir = typeof block.dir === "string" && block.dir !== "" ? normalizeDir(block.dir) : `node_modules/${block.package}`;
  const match = typeof block.source === "string" ? SOURCE.exec(block.source) : null;
  return {
    declared: true,
    inWorkspace: dir === ".",
    package: typeof block.package === "string" ? block.package : null,
    source: typeof block.source === "string" ? block.source : null,
    owner: match?.[1] ?? null,
    repo: match?.[2] ?? null,
    private: block.private === true,
    dir,
  };
}

/** `owner/repo` of `factory.source`, or null. */
export const factorySlug = (factory) => (factory.owner !== null && factory.repo !== null ? `${factory.owner}/${factory.repo}` : null);

/** The factory directory as a shell path inside the workspace: `$GITHUB_WORKSPACE` or `$GITHUB_WORKSPACE/<dir>`. */
export const factoryWorkspacePath = (factory) => (factory.dir === "." ? "$GITHUB_WORKSPACE" : `$GITHUB_WORKSPACE/${factory.dir}`);

/** A path inside the factory package, relative to the workspace: `src/x.mjs` or `<dir>/src/x.mjs`. */
export const factoryRelative = (factory, relative) => (factory.dir === "." ? relative : `${factory.dir}/${relative}`);

/**
 * Expands the placeholders of a manifest command: `<checkout>` is the upstream checkout (`"$UPSTREAM_DIR"`), `<factory>` the factory directory as a quoted
 * absolute path and `<factory-dir>` the same directory relative to the workspace (unquoted: the `dir` pattern forbids spaces).
 */
export function fillPlaceholders(command, factory) {
  return String(command)
    .split("<checkout>")
    .join('"$UPSTREAM_DIR"')
    .split("<factory-dir>")
    .join(factory.dir)
    .split("<factory>")
    .join(`"${factoryWorkspacePath(factory)}"`);
}
