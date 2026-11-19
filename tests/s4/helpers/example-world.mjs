// The small downstream of the rendered-runtime tests. Its policy, paths and commands come from the preset; its page and source bytes are synthetic.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AI, edgeOf, workflowOf } from "./workflows.mjs";

export const SOURCE_FILES = ["units/page-01.md", "units/page-02.md", "units/page-03.md"];
export const CHANGED_SOURCE = SOURCE_FILES[1];
export const CHANGED_VIEW = "view-02";
export const RUNS = [{ name: "build", id: 101 }, { name: "checks", id: 102 }];
export const INPUT_REPORTS = {
  clean: `Source revision: example\nInputs checked: ${SOURCE_FILES.length}; changed 0, new 0, gone 0\n`,
  drift: `Source revision: example\nInputs checked: ${SOURCE_FILES.length}; changed 1, new 0, gone 0\n PROBLEM a source page changed\n`,
  crash: "Error: the input reader failed\n    at readInputs (example-reader.mjs:1:1)\n",
};
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const downstreamName = (spec) => workflowOf(spec).frontmatter.checkout.find((checkout) => checkout.current).path;
export const factoryDirectory = (manifest) => `node_modules/${manifest.factory.package}`;
export const commandOf = (command) => command.replaceAll("<checkout>", '"$UPSTREAM_DIR"');
export const verifyGate = (spec) => edgeOf(spec).verifyCommands.filter((command) => !command.trimStart().startsWith("#"));
export const postRunChecks = (spec) => edgeOf(spec).verifyCommands.filter((command) => command.trimStart().startsWith("#"));
export const reportsOf = (spec) => edgeOf(spec).adaptation?.preflightReports ?? [];

/** The concrete data files named by an edge, rather than a second handwritten fleet. */
export function pathsOf(spec) {
  const edge = edgeOf(spec);
  const sourceManifest = edge.adaptation?.helpers?.sourceCheck?.manifest;
  const provenance = edge.allowedFiles.find((file) => file.endsWith("/provenance.json")) ?? edge.provenanceFile;
  const generated = sourceManifest ? edge.allowedFiles.find((file) => file.startsWith("public/") && file.endsWith("/**")) : null;
  return {
    provenance,
    inputProvenance: edge.provenanceFile,
    sourceManifest,
    generated: generated ? `${generated.slice(0, -3)}/source.json` : null,
    capture: edge.buildCommands.find((command) => /^node [^"$\s]+\.mjs$/.test(command))?.slice("node ".length),
    runData: edge.allowedFiles.find((file) => file.endsWith("/run-data.json")),
    snapshot: `${path.posix.dirname(edge.provenanceFile)}/runs.json`,
  };
}

export function upstreamFiles() {
  return Object.fromEntries(SOURCE_FILES.map((file, index) => [file, `# Source page ${index + 1}\n\nAn invented example for a downstream view.\n`]));
}

const representative = (pattern) => pattern.endsWith("/**")
  ? `${pattern.slice(0, -3)}/example.txt`
  : pattern.replaceAll("**/", "").replaceAll("*", "01");

/** Locked companion tests with the preset's real headers, blocks and named imports, plus one editable assertion. */
function companion(entry, invariants) {
  const imports = ['import { describe, it, expect } from "vitest";'];
  for (const name of entry.lockedImports ?? []) {
    let relative = path.posix.relative(path.posix.dirname(entry.file), invariants.customerTerms.module);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    imports.push(`import { ${name} } from ${JSON.stringify(relative)};`);
  }
  const body = entry.blocks.map(({ kind, title }) => kind === "describe"
    ? `  describe(${JSON.stringify(title)}, () => {\n    it("keeps a neutral example", () => { expect("example").not.toBe(""); });\n  });`
    : `  it(${JSON.stringify(title)}, () => { expect("example").not.toBe(""); });`);
  return `${imports.join("\n")}\n\ndescribe("example content", () => {\n${body.join("\n")}\n  it("allows a new content assertion", () => { expect(1).toBe(1); });\n});\n`;
}

/** A committed tree that can actually pass the preset's immutable-gate helper. */
export function downstreamFiles(previousSha) {
  const files = {
    ".gitignore": "node_modules/\n",
    "package.json": json({ name: "example-downstream", private: true, type: "module" }),
    "README.md": "# Example downstream\n",
  };
  for (const spec of AI) {
    const edge = edgeOf(spec);
    const paths = pathsOf(spec);
    for (const pattern of edge.allowedFiles) {
      const file = representative(pattern);
      files[file] ??= /\.(?:ts|tsx)$/.test(file) ? 'export const example = "neutral";\n' : "Example content.\n";
    }
    for (const entry of edge.immutableGates.zeroDiffPaths) {
      files[path.posix.extname(entry) ? entry : `${entry}/guard.ts`] ??= "export const guard = true;\n";
    }
    const invariants = edge.immutableGates.inProcessInvariants;
    for (const module of invariants.frozenModules ?? []) files[module] ??= "export const guard = true;\n";
    for (const constant of invariants.constants ?? []) {
      files[constant.module] ??= "";
      files[constant.module] += `export const ${constant.export} = ${JSON.stringify(constant.value)};\n`;
    }
    if (invariants.check && !files[invariants.check.module]?.includes(`function ${invariants.check.export}(`)) {
      files[invariants.check.module] ??= "";
      files[invariants.check.module] += `export function ${invariants.check.export}(pages) {
  if (!Array.isArray(pages)) return [{ level: "error", message: "pages must be a list" }];
  return pages.flatMap((page) => typeof page.script === "string" && page.script.trim() !== "" ? [] : [{ level: "error", message: "a page needs a script" }]);
}\n`;
    }
    if (invariants.customerTerms) {
      files[invariants.customerTerms.module] = `export function ${invariants.customerTerms.export}(text) { return text.includes("PRIVATE_MARKER") ? ["PRIVATE_MARKER"] : []; }\n`;
    }
    if (invariants.course) files[invariants.course.module] = `export const ${invariants.course.export} = [{ id: "p01", script: "An original, neutral example page." }];\n`;
    for (const entry of edge.immutableGates.lockedTestBlocks) files[entry.file] = companion(entry, invariants);
    files[paths.provenance] = json({ repository: spec.upstreamRepo, commit: previousSha });
    files[paths.inputProvenance] = json({ repository: spec.upstreamRepo, commit: previousSha });
    if (paths.sourceManifest) {
      files[paths.sourceManifest] = json({
        _provenance: { commit: previousSha },
        views: Object.fromEntries(Object.entries(upstreamFiles()).map(([source, text], index) => [
          `view-${String(index + 1).padStart(2, "0")}`,
          { source, sha256: crypto.createHash("sha256").update(text).digest("hex") },
        ])),
      });
      files[paths.generated] = files[paths.provenance];
    }
    if (paths.capture) {
      files[paths.capture] = `import fs from "node:fs";
export const RUNS = ${JSON.stringify(RUNS)};
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, ${JSON.stringify(`capture ${paths.capture}\n`)});
if (process.env.STUB_CAPTURE_RC) { console.error("example capture failed"); process.exit(Number(process.env.STUB_CAPTURE_RC)); }
fs.writeFileSync(${JSON.stringify(paths.runData)}, JSON.stringify({ runs: RUNS }, null, 2) + "\\n");
`;
      files[paths.runData] = json({ runs: RUNS });
      files[paths.snapshot] = json({ runs: Object.fromEntries(RUNS.map(({ name, id }) => [name, id])) });
    }
  }
  return files;
}

const words = (command) => (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((word) => /^["']/.test(word) ? word.slice(1, -1) : word);
const invocation = (command, tool, upstream) => {
  const line = command.trim();
  const match = new RegExp(`^(?:[A-Z_]+=\\S+\\s+)*${tool} (.+)$`).exec(line);
  return match ? words(match[1].replaceAll("<checkout>", JSON.stringify(upstream.replaceAll("\\", "/")))) : null;
};

/** Only declared npm/npx commands are accepted by the recording stand-ins, including the rendered factory install and edge setup. */
export function commandPlan(spec, upstream) {
  const edge = edgeOf(spec);
  const frontmatter = workflowOf(spec).frontmatter;
  const commands = [
    ...edge.preflightCommands,
    ...edge.acceptCommands,
    ...edge.buildCommands,
    ...verifyGate(spec),
    ...frontmatter.steps.map((step) => step.run ?? ""),
    ...frontmatter["pre-agent-steps"].slice(0, 2).map((step) => step.run ?? ""),
  ];
  const paths = pathsOf(spec);
  return {
    allowed: Object.fromEntries(["npm", "npx"].map((tool) => [tool, commands.flatMap((command) => {
      const args = invocation(command, tool, upstream);
      return args ? [args] : [];
    })])),
    inputCheck: edge.preflightCommands.map((command) => invocation(command, "npm", upstream)).find(Boolean),
    inputAccept: edge.acceptCommands.map((command) => invocation(command, "npm", upstream)).find(Boolean),
    acceptFiles: paths.sourceManifest ? [...new Set([paths.provenance, paths.inputProvenance])] : [],
    build: edge.buildCommands.map((command) => invocation(command, "npm", upstream)).find(Boolean),
    generated: paths.sourceManifest ? { source: paths.provenance, target: paths.generated } : null,
  };
}

export const fileIn = (directory, file) => path.join(directory, ...file.split("/"));
export const readDocument = (directory, file) => JSON.parse(fs.readFileSync(fileIn(directory, file), "utf8"));
