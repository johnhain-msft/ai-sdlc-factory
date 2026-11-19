// A copy of the repository as a cascade job has it after `actions/checkout` with `sparse-checkout: "src\nschemas"` in cone mode: src/, schemas/ and the files at the
// root, and no bin/ or tests/. installedSparseCopy instead puts only the preset's package files and manifest at the root, with the engine installed below the
// given factory directory. Dependencies are copied, never linked to the checkout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { presetAbs } from "../../helpers/preset.mjs";
import { abs } from "./fixtures.mjs";

const ROOT_FILES = ["package.json", "package-lock.json", "sdlc.yaml"];

function copyWorkspace(factoryDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-sparse-"));
  const engineDir = factoryDir === null ? dir : path.join(dir, factoryDir);
  fs.mkdirSync(engineDir, { recursive: true });
  fs.cpSync(abs("src"), path.join(engineDir, "src"), { recursive: true });
  fs.cpSync(abs("schemas"), path.join(engineDir, "schemas"), { recursive: true });
  for (const file of ROOT_FILES) {
    const source = factoryDir === null ? abs(file) : presetAbs(file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, file));
  }
  fs.cpSync(abs("node_modules"), path.join(dir, "node_modules"), { recursive: true });
  if (factoryDir !== null) fs.copyFileSync(abs("package.json"), path.join(engineDir, "package.json"));
  return {
    dir,
    engineDir,
    /** A minimal environment: no token, no workspace, nothing that could make a request. */
    environment: () => ({ PATH: process.env.PATH ?? process.env.Path ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: os.tmpdir(), TMP: os.tmpdir(), TMPDIR: os.tmpdir() }),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The original workspace-engine layout, with the same zero-argument API. */
export function sparseCopy() {
  return copyWorkspace(null);
}

/** A sparse adopter workspace with the engine installed at its declared factory directory. */
export function installedSparseCopy(factoryDir) {
  return copyWorkspace(factoryDir);
}
