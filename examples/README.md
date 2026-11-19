# examples: the reference preset

A synthetic orchestrator inside the factory repository, built to exercise every feature of the factory. Everything in it is invented: the names (`example-org`,
`example-reviewer`, `example-orchestrator`), the schedules, the commands, the constants and the scripts. It does not copy a fleet that anyone runs, and nothing here
belongs to an adopter.

It has nine projects, six dependency edges and three drift audits, chosen so that every manifest feature that the factory's tests lean on occurs at least once. Its commands
and constants are stand-ins: they show where a command or a constant of your own goes, and they describe no project. It serves three purposes:

- **the preset of the tests**: the helpers under `tests/` read `examples/sdlc.yaml` and `examples/instructions/` wherever a test needs a fleet (set `SDLC_PRESET_ROOT` to point them at another one);
- **the golden set**: `.github/workflows/` holds the render of `sdlc.yaml` (13 workflow sources, the cascade router and `aw.json`) and the 13 lock files that `gh aw compile --strict` makes of it;
- **a worked example**: the manifest, the instructions, and the four scripts of `scripts/` show what an orchestrator writes itself.

It is not a template to fork. Start from the documentation of the factory, and onboard your own repositories with `sdlc-onboard`.

## What is in it

| Path | What it is |
| --- | --- |
| `sdlc.yaml` | The fleet manifest. The `factory:` block names the package as a private dependency (`github:example-org/ai-sdlc-factory`), so the jobs that install it mint a read token. |
| `instructions/` | The registration instructions of the three drift projects, one file each. |
| `scripts/` | The extension points, exercised: `classify-report.mjs` and `classify-runs.mjs` (classifiers of a preflight check), `check-sources.mjs` (a helper with its own flags and exit codes, reading `adaptation.helpers.sourceCheck` through `ai-sdlc-factory/script-kit`) and `validate-example.mjs` (a staged validator that imports only `ai-sdlc-factory/drift-lib`). |
| `request.reference.json` | The nine-key reconcile request that every golden is rendered from. |
| `.gh-aw-version` | The gh-aw release that compiles the locks. |
| `.github/aw/actions-lock.json` | The pinned action versions that the compiler needs. |
| `.github/workflows/` | The committed render and the compiled locks. |
| `package.json` | The orchestrator's own package: it depends on the factory, as an adopter's does. |

There is no `prompts/` directory on purpose: the drift workflows then take their strategy fragments from the factory package.

## Regenerating the goldens

```sh
node tools/update-examples.mjs            # render examples/ into examples/.github/workflows (sources, router, aw.json)
node tools/update-examples.mjs --compile  # and compile the 13 locks with the gh-aw release of .gh-aw-version
git diff -- examples                      # the diff is the behaviour change of the commit
```

A change of the factory that alters rendered output regenerates `examples/` in the same commit. `tests/examples-golden.test.mjs` fails when the committed render is not what the
renderer produces. The compile needs gh-aw at the release of `.gh-aw-version`; when the globally installed one is older, set `SDLC_GH_AW_DATA_HOME` to an isolated install of it.
