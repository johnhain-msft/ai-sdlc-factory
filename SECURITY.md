# Security policy

## Reporting a vulnerability

Please report a vulnerability privately. Open a private security advisory on this repository (the *Security* tab, then *Report a vulnerability*). Do not open a public issue or pull request for it, and do not put the details in a discussion.

A useful report says which release or commit is affected, what an attacker gains, and how to reproduce it. Please allow the maintainers reasonable time to respond before you disclose the problem elsewhere.

## Supported versions

The supported version is the most recent release of the 0.x line, together with `main`. Older releases are not patched: update to the latest tag, regenerate your workflows with `sdlc-reconcile` and review the diff.

## What is in scope

- the commands `sdlc-bootstrap`, `sdlc-onboard` and `sdlc-reconcile`;
- the workflows that the reconciler renders, and the scripts that they run;
- the way the factory is installed in a job, including the private-repository token;
- the handling of the GitHub App's credentials and of the secrets and variables that the bootstrap writes.

Vulnerabilities in gh-aw, in GitHub Actions or in the AI engines belong to their own projects. A weakness that the factory adds on top of them is in scope.

## How secrets are handled

- **Secrets are never flags.** The commands refuse every flag that they do not define. The private key of the App and the credentials of the engine come from the environment or from a prompt that does not echo them.
- **Values are checked before anything is sent.** A secret value that contains `gho_`, the prefix of an OAuth token, is refused. Secrets are encrypted locally as libsodium sealed boxes before they are uploaded, and a plaintext value never appears in a request, a URL, a log line or a file.
- **No secret is printed.** The summary report names the variables and secrets that were set and never their values. Tokens are registered with the logger as secrets, and a finding of the repository's own leak guard prints a position and a rule, never the text that matched.
- **The App's private key is stored once.** When the bootstrap registers the App, the key lives only in memory and is stored only as the Actions secret `APP_PRIVATE_KEY`. Rotate it by generating a new key in the App's settings and running `sdlc-bootstrap` again with `APP_CLIENT_ID` and `APP_PRIVATE_KEY` in the environment.
- **Tokens are short-lived and narrow.** The workflows mint installation tokens, each limited to the repositories that the job needs. The read token for a private factory repository has `contents: read` on that one repository, exists only in the environment of the install step, is masked and is revoked when the job ends. Checkouts are rendered with `persist-credentials: false`.
- **The App has a permission ceiling** (contents, pull requests, issues, actions and variables write; metadata read). The bootstrap refuses an App that holds more.
- **Nothing is merged.** No rendered workflow enables auto-merge, pull requests are created only through safe outputs, protected files are blocked, and threat detection is on in every workflow that creates one.
- **Install scripts stay off.** Jobs that hold the App's key install with `npm ci --ignore-scripts`, and the package has no install-time script.
- **The repository is checked for leaks.** Generic rules and a digest denylist run over every tracked file and every commit and tag message, in `npm test` and in CI; see [Architecture](docs/architecture.md#the-factory-repositorys-own-safeguards).

If you find a secret in this repository or its history, report it as described above, and revoke it if it is yours.
