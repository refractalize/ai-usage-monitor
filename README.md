# AI Usage Monitor

A self-hosted React Router + Vite dashboard and five-minute Codex/Claude quota collector,
using TypeScript, Node, and SQLite. It reads `account/rateLimits/read` through a
short-lived Codex app-server. It never creates a thread, starts a model turn, or
requests token/cost activity from Codex. Claude uses its experimental structured
usage control request, without a prompt or model turn; only quota percentages
are normalized and displayed.

## Local development

```sh
mise trust
mise install
mise run setup
mise run login          # normal Codex device-code login; install Codex first
mise run dev            # http://127.0.0.1:3000
```

Node is pinned to 26.2.0. SQLite uses Node's built-in `node:sqlite`; there is no
separate database service or native SQLite npm dependency. React Router provides
SSR, Vite builds the app, Express owns the HTTP lifecycle, and tsx runs the small
TypeScript server. Charts use React and CSS without a charting dependency.

`dev` and `start` run collection every **five minutes**, with an immediate attempt
if overdue at startup. Work never overlaps within one server process. Run **one
replica** per database. No systemd or cron is needed for this application.
Opening or refreshing a page only reads stored data. The view refreshes every
minute while visible. Set `AI_USAGE_SCHEDULE=off` for a dashboard without
collection (useful during development against a database copy).

```sh
mise run collect
mise run status
mise run history --weeks 12
mise run dump --format jsonl > usage.jsonl
mise run typecheck
mise run test
mise run build
mise run start
```

The commands accept `--db PATH`. Alternatively set `AI_USAGE_DB`; the default
is `~/.local/share/ai-usage-monitor/usage-v2.sqlite3`. Set `CODEX_BIN` for an executable
outside PATH. `HOST` defaults to 127.0.0.1 and `PORT` to 3000.
`AI_USAGE_TIMEZONE` controls displayed times and daily boundaries; it defaults
to the server's timezone. Use an IANA name such as `Europe/Paris`.

## Formatting and linting

Biome is pinned as a development dependency and formats TypeScript, TSX, CSS,
and JSON. It uses two-space indentation, single JavaScript quotes, and a
100-column target. Recommended lint rules and import organization are enabled.
Non-null assertions are allowed in test fixtures; application code retains the rule.

```sh
mise run format        # Apply formatting
mise run format:check  # Check formatting without changing files
mise run check         # Check formatting, lint rules, and import ordering
mise run check:fix     # Apply safe fixes, including formatting and imports
mise run typecheck     # Separate TypeScript check
```

CI runs `npm run check`. Biome is scoped to application code, tests, and project
JSON/TypeScript configuration; generated output, dependencies, lockfiles, and
private data are excluded. Markdown, YAML, TOML, and Dockerfiles are outside its
formatting scope. Editor integrations should use the project's `biome.json`.

## Docker / Raspberry Pi

Use a 64-bit OS (ARM64). The image uses Node 26.2.0, Codex 0.160.0, and
Claude Code 2.1.289. The npm CLI packages install native executables for the target
architecture. Claude auto-updates are disabled so the experimental protocol stays pinned.

```sh
mise run docker:build
mise run docker:login
mise run docker:claude:login
mise run docker:up
mise run docker:logs
```

During login, follow the device URL and code in your browser on another computer.
The included `compose.yaml` runs the web server and its five-minute collectors
in one container; no systemd installation is needed. Compose creates these named
volumes automatically:

| Volume | Container path | Contents |
| --- | --- | --- |
| `usage-data` | `/data` | SQLite database (`usage-v2.sqlite3`) and its WAL files |
| `codex-auth` | `/codex-home` | Codex login credentials and configuration |
| `claude-auth` | `/home/node` | Claude login credentials and configuration |

Normal CLI authentication handles credential refresh. Data and credentials are
not baked into the image. `docker compose down` preserves these volumes across
container rebuilds and restarts; `docker compose down -v` deletes them.

Compose enables both Codex and Claude by default. To collect only one provider,
set `USAGE_PROVIDERS=codex` or `USAGE_PROVIDERS=claude` in a local `.env` file.

Compose binds the dashboard to localhost. From another computer:

```sh
ssh -L 3000:127.0.0.1:3000 pi@raspberrypi
# Open http://localhost:3000
```

The dashboard has no application login; use private access or an authenticated
reverse proxy if exposing it beyond localhost. `/healthz` reports server
liveness; stale data and collection errors are shown separately in the UI.

Manual collection and history in the running container:

```sh
docker compose exec monitor node --import tsx server/cli.ts collect
docker compose exec monitor node --import tsx server/cli.ts history --weeks 12
```

## Enable Claude (experimental)

Install Claude Code locally and use its normal subscription login. No token copying
or custom credential refresh is implemented:

```sh
mise run claude:login
mise run claude:login:status
mise run collect --provider claude
mise run status --provider claude
USAGE_PROVIDERS=codex,claude mise run dev
```

Outside Compose, `USAGE_PROVIDERS` defaults to `codex`. Use `claude` to collect only Claude, or
`codex,claude` for both. Each enabled provider has an independent five-minute
scheduler, timeout, and failure record. A failed Claude read doesn't stop Codex.
The dashboard has a provider selector; disabled providers' stored history remains
viewable. `Refresh view` reads SQLite and never triggers a CLI collection.

All CLI commands accept `--provider codex|claude|all`. With no flag, they operate
on the providers enabled in `USAGE_PROVIDERS`. A multi-provider collection returns
a nonzero exit code if any provider fails, while retaining the other successes.

For Docker:

```sh
mise run docker:build
mise run docker:claude:login
mise run docker:claude:login:status
mise run docker:up
```

Compose enables both providers by default and reads overrides from `.env`;
local mise/Node commands use exported environment
variables. The `claude-auth` volume mounts `/home/node`, preserving both `.claude/`
and `.claude.json`. It is separate from Codex credentials and the usage database.
Follow the normal CLI browser login flow, including its manual browser-code option
when needed over SSH. Do not use `--console` or an API key for subscription quotas.
Use the Claude login-status task to diagnose credentials; error bodies are never
relayed by the collector.

The Claude collector uses newline-delimited control messages:
`initialize` → `get_usage` with `skip_behaviors: true`. It sends **no user messages**,
starts no model turn, and disables hooks, tools, MCP servers, and session persistence.
It runs in a temporary empty working directory and only uses the CLI for auth and
network access. Tests assert this request allowlist and process cleanup.

Anthropic explicitly marks this control API as experimental; upgrades need a
compatibility check. Claude can return cached quota readings without exposing
whether a fallback occurred or when the underlying reading was fetched. Accordingly,
the dashboard says **Recently collected**, not **Up to date**, for Claude and always
shows a freshness caveat. An unavailable/null quota response fails collection.

`five_hour` maps to 300 minutes; `seven_day` and recognized model-week keys map to
10,080 minutes. Model-specific allowances remain separate. Unfamiliar window keys
with quota metadata retain an unknown duration. The CLI's `model_scoped` projection
is normalized; its underlying `limits` array stays in raw JSON to avoid counting the
same rows twice. Extra-usage dollar/spend sections aren't quota windows. No token or
dollar views are provided. Complete raw control responses are retained privately,
including any extra fields returned by the CLI, and are only exposed by `dump`.

## Fresh database schema

This version starts a new database at `~/.local/share/ai-usage-monitor/usage-v2.sqlite3`
(or `/data/usage-v2.sqlite3` in Docker). No migration is provided. Existing files
are not deleted. Pointing the Node application at an older schema fails with a
clear instruction to select a fresh path using `--db` or `AI_USAGE_DB`.

Snapshots and collection attempts are scoped by provider and account name. The
names default to `default`; set `CODEX_USAGE_ACCOUNT_NAME` or `CLAUDE_USAGE_ACCOUNT_NAME`
when switching between personal/work accounts. These are operator-supplied names,
not automatic account detection: change the name or database when changing login.
Deduplication, latest status, exports, and history respect this scope. SQLite uses
WAL mode, a 10-second busy timeout, and short transactions, allowing independent
SQLite readers while collection continues.

`mise run install` installs Node dependencies and builds the application locally.
The superseded Python implementation and systemd units are no longer distributed.
If an old timer is installed, stop it with `systemctl --user disable --now codex-usage.timer`.

### Existing installations

Shared configuration now uses `AI_USAGE_DB`, `AI_USAGE_TIMEZONE`, and
`AI_USAGE_SCHEDULE`. Update old `CODEX_USAGE_*` settings for those three options.
Account settings are now `CODEX_USAGE_ACCOUNT_NAME` and `CLAUDE_USAGE_ACCOUNT_NAME`.
Rename existing account settings while retaining their values to keep the same history.
Authentication paths have not changed.
To keep using an existing local database, set `AI_USAGE_DB` to its existing path.
No database files are moved or deleted automatically.

Compose now uses the project name `ai-usage-monitor`. If you already deployed
from a directory called `codex-monitor`, use `docker compose -p codex-monitor ...`
(or `COMPOSE_PROJECT_NAME=codex-monitor` in `.env`) for every Compose command to
keep the existing database and authentication volumes. Stop the previous service
before starting a replacement; do not run two collectors against the same file.
Do not use `down -v` when moving an installation.

## What the numbers mean

- Current usage shows all returned windows, identified by duration, not by
  `primary` or `secondary`. A weekly window is 10,080 minutes.
- Reset history shows `MAX(used_percent)` for each limit, duration, and reset time.
- Daily spend sums newly observed increases above each reset period's previous
  high-water mark. The first sample is a baseline, not spend during that day.
  A correction downward and recovery to the old maximum is not counted twice.
- After a detected reset, the first new percentage is included as observed new
  period usage. Usage immediately before the reset may have been missed. A
  changing reset timestamp before expiry is treated as uncertain, not a new spend.
- Weekly spend aggregates daily spend into Monday-start weeks. A day/week spanning
  several resets may exceed 100 percentage points. Different allowances are never
  added together.
- Increases are assigned to the later observation's day in the configured timezone.
  Baselines, missing fields, gaps over ten minutes, day boundaries, corrections,
  and resets are flagged. Missing days are absent, not fabricated as zero.

Raw JSON is preserved for future analysis. Errors are sanitized and logged to
stderr; failed reads create an attempt record but never a bogus usage snapshot.
No token or dollar metrics are normalized or calculated; raw provider responses may contain additional fields.

## Implementation and verification

`app/` contains the SSR dashboard; `server/` contains transport, storage,
analytics, CLI, and scheduling. `node-tests/` uses Node's test runner and fake
app-server processes; no account is required. Account status reads use the initialization schema generated from
installed Codex 0.160.0: initialize → initialized → account/rateLimits/read. Claude
uses the control protocol verified against CLI 2.1.289; its normalization and
account/provider isolation are covered by fixture-based tests.

The Docker image must still be built and exercised on the target Pi, including
login, persistent volumes, and restart behavior. `mise run docker:build` requires
a running Docker daemon.

See [adding a provider](docs/providers.md) for the adapter contract and
[publication checks](docs/publishing.md) for the secret and fixture review process.

## Published container images

The Container workflow runs checks, builds and smoke-tests `linux/amd64` and
`linux/arm64` images, then publishes to `ghcr.io/<owner>/<repository>`. Raspberry Pi
requires a 64-bit OS. Docker automatically selects the matching architecture.
Pull requests build and test without logging in or pushing to GHCR.

Pushes to `main` publish `latest` and `sha-<full-commit-sha>` tags. Version tags such
as `v0.3.0` publish `0.3.0` and a SHA tag; releases do not replace `latest`.
Publishing uses the repository's `GITHUB_TOKEN` with package-write permission.
Main publishing is serialized and superseded commits are skipped. SHA tags identify
source revisions; use an image digest for strictly immutable deployments.

GHCR package visibility is configured separately from repository visibility.
For anonymous pulls, make the package public in GitHub after first publication.
For a private package, authenticate Docker to GHCR using credentials with package
read access. These registry credentials are separate from provider logins.

### Standalone Compose example

Save this as `compose.yaml` in a directory on your server:

```yaml
name: ai-usage-monitor

services:
  monitor:
    image: ghcr.io/refractalize/ai-usage-monitor:latest
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      AI_USAGE_DB: /data/usage-v2.sqlite3
      CODEX_HOME: /codex-home
      USAGE_PROVIDERS: codex,claude
      CODEX_USAGE_ACCOUNT_NAME: default
      CLAUDE_USAGE_ACCOUNT_NAME: default
      AI_USAGE_TIMEZONE: UTC
    volumes:
      - usage-data:/data
      - codex-auth:/codex-home
      - claude-auth:/home/node
    stop_grace_period: 15s

volumes:
  usage-data:
  codex-auth:
  claude-auth:
```

`usage-data` stores SQLite and its WAL files. `codex-auth` stores Codex login and
configuration in `CODEX_HOME`. `claude-auth` preserves both `/home/node/.claude/`
and `/home/node/.claude.json`. These named volumes survive container replacement.

Pull the image, authenticate each provider, and start the monitor:

```sh
docker compose pull
docker compose run --rm monitor codex login --device-auth
docker compose run --rm monitor claude auth login --claudeai
docker compose up -d
```

If the container is already running, log in or reauthenticate with:

```sh
docker compose exec monitor codex login --device-auth
docker compose exec monitor claude auth login --claudeai
```

Check the saved login status:

```sh
docker compose exec monitor codex login status
docker compose exec monitor claude auth status
```

To open an interactive shell instead, run `docker compose exec monitor sh` and
run the same provider login commands inside it. Credentials are saved in the
mounted provider volumes and used by subsequent scheduled collections.

Follow each CLI's browser login instructions. The dashboard is available at
`http://localhost:3000`; use the SSH tunnel described above for a remote server.
To update to the latest image, run `docker compose pull` and `docker compose up -d`.
Do not run `docker compose down -v` unless you intend to delete usage history and
saved logins. Existing installations should keep their Compose project name to
reuse their volumes.

### Using the repository's production Compose file

The production Compose file already points to
`ghcr.io/refractalize/ai-usage-monitor:latest`. Run:

```sh
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml run --rm monitor codex login --device-auth
docker compose -f compose.production.yaml run --rm monitor claude auth login --claudeai
docker compose -f compose.production.yaml up -d
```

Use `-f compose.production.yaml` for all production Compose commands. It uses the
same project name, database volume, and authentication volumes as local Compose.
Existing installations must retain any `COMPOSE_PROJECT_NAME` override described
above. No host source checkout or local image build is required; download the
production Compose file to the target machine. Optional settings can go in `.env`.

To update, run `pull` then `up -d` again. To roll back, change the `image` field to a
previous `sha-<full-commit-sha>` tag or `ghcr.io/<owner>/<repository>@sha256:<digest>`
and repeat those commands. Database compatibility must still be considered when
rolling back application versions. Never use `down -v` during an update.

CI's ARM tests run under QEMU, with collection disabled and no subscription
credentials. They check CLI startup, HTTP health, and both dashboard pages.
Authentication and collection on a physical Raspberry Pi still need device testing.
