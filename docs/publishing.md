# Publication checks

Use synthetic fixtures only. Never add a captured login, real subscription
response, account ID, credential file, database, or usage export to the repository.
The application preserves full raw responses locally, so database files and dumps
must be treated as private. Ignore rules are a convenience, not a security audit.

Before committing:

1. Inspect `git status --short --untracked-files=all` and explicitly stage source,
   tests, configuration, and documentation only.
2. Review `git diff --cached` for personal paths, account labels, subscription
   identifiers, login output, and real usage observations as well as secrets.
3. Run `mise run audit` to scan the exact staged changes with Gitleaks, with
   findings redacted. Resolve findings before committing; do not add broad ignores.
4. Run `mise run check`, `mise run typecheck`, `mise run test`, `mise run build`, and
   `docker compose config --quiet`. Exercise the image when Docker is available.

The Docker build context uses an allowlist, excluding credentials, databases,
exports, tests, and local environment files. Do not copy authentication into an
image or Docker build argument. Authenticate through the normal CLI in its named
volume. `docker compose down` preserves volumes; `down -v` deletes them.
