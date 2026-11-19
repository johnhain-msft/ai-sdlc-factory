// A neutral drift target for the S2 tests: the files of a small content repository (a README, a guide that cites a documentation page, a registry, the audit and
// improvement reports, a package manifest, two test files and a stand-in compiled workflow), as { workspace-relative path: text }.
//
// The engine's scripts (prepare-run, snapshot-watch-sources, read-report, the PR checks, ...) read a target checkout and judge what an agent left in it. The tests need
// one, and it names nothing of an adopter. The report files are valid for scripts/validate-example.mjs of examples/, the staged validator of the example fleet; the
// helpers below make the reports invalid in the ways that the validator refuses.

/** The valid audit report: the four sections that the audit instructions of examples/ require, in order. */
export const AUDIT_REPORT = [
  "# Audit report",
  "",
  "## Summary",
  "",
  "One page cites a changed source; the registry is current.",
  "",
  "## Verification",
  "",
  "- The freshness threshold of the registry is 30 days.",
  "- Every watched source was read.",
  "",
  "## Proposed additions",
  "",
  "- Describe the new `--format` option of the command-line tool.",
  "",
  "## Run details",
  "",
  "- run: dry",
  "",
].join("\n");

/** The valid improvement report: the three sections that the improvement instructions of examples/ require, in order. */
export const IMPROVEMENT_REPORT = ["# Improvement report", "", "## Summary", "", "Nothing to change.", "", "## Findings", "", "- No definition refers to a retired name.", "", "## Run details", "", "- run: dry", ""].join("\n");

/** Every file of the target, as { relative path: text }; every call returns a new object that a test may change. */
export function targetFiles() {
  return {
    "README.md": "# Example content\n\nGuides for the example platform. The overview is at https://docs.example.net/platform/overview.\n",
    "docs/guide.md": "# Guide\n\nInstall the command-line tool as described at https://docs.example.net/platform/install, then read https://docs.example.net/platform/overview.\n",
    "content/registry.yaml": [
      "schema_version: 3",
      "audit:",
      "  threshold_days: 30",
      "  last_verified: 2026-11-01",
      "entries:",
      "  - id: platform-cli",
      "    version: 2.4.1",
      "    consumers:",
      "      - docs/guide.md",
      "",
    ].join("\n"),
    "reports/audit-report.template.md": "# Audit report\n\n## Summary\n\n## Verification\n\n## Proposed additions\n\n## Run details\n",
    "reports/audit-report.md": AUDIT_REPORT,
    "reports/improvement-report.md": IMPROVEMENT_REPORT,
    "package.json": `${JSON.stringify({ name: "example-content", private: true, version: "0.0.0", scripts: { test: "node --test" } }, null, 2)}\n`,
    "tests/catalog-links.test.js": "// stands in for a test of the target\n",
    "tests/page-layout.test.js": "// stands in for a test of the target\n",
    ".github/workflows/stand-in.lock.yml": "# a compiled workflow that no script may touch\nname: stand-in\non: workflow_dispatch\njobs: {}\n",
  };
}

/** The text of a YAML mapping without one top-level key and the lines that belong to it. */
export function withoutTopLevelKey(text, key) {
  const kept = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (new RegExp(`^${key}:`).test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^[ \t]/.test(line) || line === "")) continue;
    skipping = false;
    kept.push(line);
  }
  return kept.join("\n");
}

/** The text of a Markdown report without one `## ` section (its heading and what follows up to the next `## `). */
export function withoutSection(text, heading) {
  const kept = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (/^## /.test(line)) skipping = line === `## ${heading}`;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/** The same report with its `## ` sections in another order (the text before the first section stays first). */
export function withSectionOrder(text, order) {
  const parts = text.split(/^(?=## )/m);
  const preamble = /^## /.test(parts[0]) ? "" : parts.shift();
  const byHeading = new Map(parts.map((part) => [part.split("\n")[0].replace(/^## /, ""), part]));
  return preamble + order.map((heading) => byHeading.get(heading)).join("");
}
