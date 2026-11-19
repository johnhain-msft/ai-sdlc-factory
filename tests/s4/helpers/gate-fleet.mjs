// The neutral gate fleet, with its policy outside the downstream checkout that the helper inspects.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { abs, readText, repoFrom, tempDir, writeFiles } from "./fixtures.mjs";

export const GATE_FLEET_ROOT = abs("tests", "fixtures", "gate-fleet");
export const GATE_DOWNSTREAM = path.join(GATE_FLEET_ROOT, "downstream");
export const gateManifest = () => YAML.parse(readText(path.join(GATE_FLEET_ROOT, "sdlc.yaml")));

let template = null;

/** A committed copy of the neutral downstream and a separate workspace containing the trusted manifest. */
export function createGateFleet(document = gateManifest()) {
  template ??= repoFrom(GATE_DOWNSTREAM, "sdlc-s4-gate-base-");
  const workspace = tempDir("sdlc-s4-gate-workspace-");
  const dir = path.join(workspace, "downstream");
  fs.cpSync(template.dir, dir, { recursive: true });
  writeFiles(workspace, { "sdlc.yaml": YAML.stringify(document, { lineWidth: 0 }) });
  return { workspace, dir, base: template.base };
}
