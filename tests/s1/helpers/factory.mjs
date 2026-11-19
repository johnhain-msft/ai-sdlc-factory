// Expected install wiring of the preset's private factory, shared by render assertions.
import { presetManifest } from "./fixtures.mjs";

const { factory } = presetManifest();
const [owner, repository] = factory.source.replace(/^github:/, "").split("/");
const source = `${owner}/${repository}`;
const rewriteKey = `url.https://x-access-token:\${{ steps.factory_token.outputs.token }}@github.com/${source}.insteadOf`;

export const FACTORY_DIR = factory.dir ?? `node_modules/${factory.package}`;
export const FACTORY_PATH = `$GITHUB_WORKSPACE/${FACTORY_DIR}`;
export const FACTORY_TOKEN = {
  name: "Mint the factory read token",
  id: "factory_token",
  uses: "actions/create-github-app-token@v2",
  with: {
    "app-id": "${{ vars.APP_CLIENT_ID }}",
    "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
    owner,
    repositories: repository,
    "permission-contents": "read",
  },
};
export const FACTORY_INSTALL = {
  name: "Install the factory",
  env: {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: rewriteKey,
    GIT_CONFIG_VALUE_0: `ssh://git@github.com/${source}`,
    GIT_CONFIG_KEY_1: rewriteKey,
    GIT_CONFIG_VALUE_1: `git@github.com:${source}`,
    GIT_CONFIG_KEY_2: rewriteKey,
    GIT_CONFIG_VALUE_2: `https://github.com/${source}`,
  },
  run: "npm ci --ignore-scripts",
};
export const FACTORY_SPARSE = {
  "sparse-checkout": "/package.json\n/package-lock.json\n/sdlc.yaml",
  "sparse-checkout-cone-mode": false,
  "persist-credentials": false,
};

/** Manifest command placeholders as used by the installed factory. */
export const fillCommand = (command) => command.replaceAll("<checkout>", '"$UPSTREAM_DIR"').replaceAll("<factory>", `"${FACTORY_PATH}"`).replaceAll("<factory-dir>", FACTORY_DIR);
