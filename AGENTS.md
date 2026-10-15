# Repository Guidelines

## Project Structure & Module Organization

The active application lives in `cairn-x/`; the earlier Python implementation is on the `main` branch. In `cairn-x/src/`, `server/` implements the Hono API and SQLite persistence, `scheduler/` manages dispatch and leases, `worker/` runs containerized execution, and `agents/` contains runtime code and prompts. Keep shared protocol types in `contracts/` and common utilities in `shared/`. The React workbench and its assets live in `web/`; server assets live in `server/static/`.

Tests are grouped by subsystem under `cairn-x/tests/`; frontend unit tests live in `tests/web/`. Root documentation lives in `README.md` and `docs/`; README images are in `README/`.

## Build, Test, and Development Commands

Use Node.js ≥22.19. Run these commands from `cairn-x/`:

- `npm ci`: install locked dependencies.
- `npm run build:web`: build the workbench into `dist-web/`.
- `npm run dev -- --config dispatch.yaml --import-config`: initialize development configuration and start Server plus Dispatcher; omit `--import-config` on subsequent runs. Requires configured credentials, Docker, the Worker image, and network setup described in the root README.
- `npm run dev:web`: start the Vite frontend development server.
- `npm test`: build the frontend, then run Vitest.
- `npm run typecheck`: check backend and frontend TypeScript.
- `npm run lint`: run oxlint correctness rules (`.oxlintrc.json`).
- `npm run check:deps`: runtime import-cycle and module-boundary checks (`scripts/check-deps.ts`).
- `npm run knip`: report unused files, dependencies, and exports.
- `npm run format:check` / `npm run format`: check or apply Prettier formatting across the worktree (`.prettierignore`).
- `npm run check`: local quality gate (typecheck → lint → format → dependency boundaries → knip → core regressions); this is the substitute for CI, run it before committing.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Prettier specifies tabs, a 100-character print width, double quotes, and trailing commas. Follow neighboring import conventions. Use camelCase for functions and variables, PascalCase for types and React components, and descriptive kebab-case filenames for backend modules. Keep API contracts centralized rather than duplicating shapes across components.

## Testing Guidelines

Name Vitest tests `*.test.ts`. Add regression tests for changed behavior, especially leases, cancellation, authentication, and execution protocols. Run focused tests with `npm test -- tests/orchestrator/heartbeat.test.ts`. No numeric coverage threshold is configured. Docker release tests require `CAIRN_TEST_DOCKER=1`, an isolated `CAIRN_TEST_NETWORK`, and `CAIRN_TEST_CONTROL_HOST`.

## Engineering Constraints

These are deliberate project decisions; do not "fix" them in contributions.

- No CI: the repository intentionally has no `.github/workflows` or other CI configuration. Quality gates run locally via `npm run check` (fast path) and the full `npm test` when the change warrants it. Docker E2E tests remain opt-in through `CAIRN_TEST_DOCKER=1`.
- No database migrations: schema changes carry no backward-compatibility contract. Do not add migration or backfill code (`PRAGMA user_version`, `ALTER TABLE` helpers, versioned migration modules). Keep `openDatabase()` on `CREATE TABLE IF NOT EXISTS` and keep schema and code consistent; tests create fresh databases and stale databases are discarded rather than upgraded.

## Commit & Pull Request Guidelines

History predominantly uses `fix(scope): description`, `perf(scope): description`, `docs: description`, and `chore: description`; follow that pattern. Keep commits focused. PRs should explain the problem, resulting behavior, and validation; link relevant issues and include screenshots for workbench changes.

## Security & Configuration

Start from `.env.example` and `dispatch.example.yaml`. Never commit credentials, `dispatch.yaml`, runtime `datas/`, or VPN files. Use separate `CAIRN_WEB_PASSWORD` and `CAIRN_API_TOKEN` values. Existing databases retain model and prompt settings; update them through workbench settings.
