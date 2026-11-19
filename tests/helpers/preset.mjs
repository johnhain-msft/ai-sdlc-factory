// The preset seam (design I.3): where the tests read the fleet that they use as their input.
//
// The engine's tests render, route and verify a fleet, and they need one. It is examples/, the synthetic reference fleet of this repository; its committed
// render under examples/.github/workflows is the golden set. `SDLC_PRESET_ROOT` points the same helpers at another fleet (the root of a repository that has an
// sdlc.yaml, instructions/ and a committed render), for example while debugging an adopter's orchestrator; it is not the mechanism of an adopter's own tests,
// which import the package (`ai-sdlc-factory/reconcile`) and keep a small helper of their own.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/** Where src/, bin/, schemas/ and prompts/ are: the engine itself. */
export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The root of the fleet that the tests use: $SDLC_PRESET_ROOT, else examples/. */
export const PRESET_ROOT = process.env.SDLC_PRESET_ROOT ? path.resolve(process.env.SDLC_PRESET_ROOT) : path.join(ENGINE_ROOT, "examples");

/** A path inside the engine. */
export const engineAbs = (...parts) => path.join(ENGINE_ROOT, ...parts);

/** A path inside the preset fleet. */
export const presetAbs = (...parts) => path.join(PRESET_ROOT, ...parts);

/** The manifest of the preset, parsed; every call returns a copy that a test may change. */
export const presetManifest = () => YAML.parse(fs.readFileSync(presetAbs("sdlc.yaml"), "utf8"));

/** The `dependencyEdges` of the preset. */
export const presetEdges = () => presetManifest().dependencyEdges;

/** The `projects` of the preset. */
export const presetProjects = () => presetManifest().projects;

/** The first path segments that name what the preset fleet owns: its manifest, its instructions and its committed render (the goldens). */
const PRESET_OWNED = new Set(["sdlc.yaml", "instructions", ".github"]);

/**
 * A path that a test names the way it named it when the repository was the fleet: `abs("sdlc.yaml")`, `abs(".github", "workflows", "x.md")`, `abs("src", ...)`. What the
 * preset fleet owns (the manifest, the instructions, the committed workflows) is read from the preset, and everything else from the engine. The one place that decides.
 */
export const repoAbs = (...parts) => (PRESET_OWNED.has(String(parts[0] ?? "").split(/[\\/]/)[0]) ? presetAbs(...parts) : engineAbs(...parts));
