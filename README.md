# JarcTech Ticket

A working local prototype for JARC Technologies ticket intake, admin assignment, developer planning, and shared project Gantt tracking.

## Start here

1. Extract this ZIP. Open the folder containing this README and `package.json`.
2. Install Node.js 22 or newer if needed.
3. Open a terminal in this folder and run:

```powershell
npm start
```

Open **http://localhost:4175**. The browser prototype itself needs no packages. Run `npm.cmd install` once before the checks and tests, which use the MongoDB driver and a temporary test database.
If PowerShell blocks `npm.ps1`, use `npm.cmd start`.
If another app already uses that port:

```powershell
$env:PORT = '4176'
npm.cmd start
```

Use the URL printed in your terminal. Stop the server with Ctrl+C.

## What is included

- JARC teal styling and the project name **JarcTech Ticket**.
- Only ticket and project navigation; no Meetings or Change requests sidebar tabs.
- Admin: Tickets received shows all requestors' tickets for review, priority, assignment, information requests, rejection, and holds.
- Requestor: My ticket, current request form, progress monitoring, meeting confirmation, comments, and acceptance.
- Developer: My ticket shows assigned work. Planning meetings remain inside ticket details.
- Two-step project creation: project name, agreed requirements, criteria, target, then dated tasks.
- Projects list opens a Gantt chart with task dates, owner, requirement, task criteria, and completion.
- Linked scope changes remain inside each ticket and retain assessment, agreement, approval, testing, acceptance, release, and closure.
- Browser-local persistence, sample data, syntax checks, date tests, static server tests, backend foundation tests, and a GitHub Actions check.

The header's **Demo role** selector replaces the old three-button preview strip. It is a preview aid, not sign-in or access control. Requestor demo identity: Adriane Venzon. Developer demo identity: Miguel Santos.

## Continue with Claude Code and GitHub

Read [the Windows setup guide](docs/GETTING-STARTED.md), then [the phased build plan](docs/BUILD-PLAN.md). Claude Code reads the repository's [CLAUDE.md](CLAUDE.md) for context. The chosen architecture (GitHub, Railway, MongoDB) is recorded in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the backend plan is in [docs/BACKEND-PLAN.md](docs/BACKEND-PLAN.md). The app itself is still the browser-only prototype until that plan is implemented.

**Extract the ZIP before adding code to GitHub. Upload or commit its contents, not the ZIP itself.** The repository root should contain `package.json`, `server.cjs`, `CLAUDE.md`, `public/`, and `docs/`.

## Backend foundation (not used by the UI yet)

The server can connect to MongoDB and report its health, but **the UI still stores records only in the browser**. No ticket API exists yet, and nothing is read from or written to the database except a connection check (`ping`).

- **Without database settings:** `npm start` runs exactly as the browser-only prototype.
- **With database settings:** set `MONGODB_URI` and `MONGODB_DB_NAME` in a local `.env` (copy [`.env.example`](.env.example)) or as Railway variables, and the server checks the connection at start-up. Point local development at a development database, never production.
- **Endpoints:**
  - `GET /healthz` returns `200 {"status":"ok"}` while the process is running.
  - `GET /readyz` returns `200 {"status":"ready","database":"connected"}` when MongoDB answers. Otherwise it returns `503` with `database` set to `not-configured`, `unreachable`, or `stopping`.
  - Neither endpoint ever includes error details. Those go to the server log with credentials redacted.
- **Settings are validated at start-up.** Every problem is listed by variable name, and values are never shown. In production or on Railway the database settings are required, and the server binds to `0.0.0.0` on Railway's `PORT`.
- **Shutdown:** on `SIGTERM` or Ctrl+C the server stops accepting connections, lets in-flight requests finish (up to 8 seconds), closes the database connection, and exits.
- **`.env` precedence:** settings already in the environment win over `.env`. Tests and the browser walkthrough never read `.env`; they set `NODE_ENV=test` or `JARCTECH_ENV_FILE=none`.
- **Railway:** `railway.json` sets the start command and uses `/readyz` as the deploy health check. Nothing has been deployed.

## Checks

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
```

`npm test` includes backend tests against a temporary MongoDB started by `mongodb-memory-server` on `127.0.0.1`. It never uses `.env` or a shared database. The first run downloads the MongoDB test binary (about 80 MB) into `node_modules/.cache`. The `SIGTERM` shutdown test is skipped on Windows, because Windows cannot deliver that signal to a child process; it runs on Linux and macOS, including GitHub Actions.

### Optional browser walkthrough

`npm.cmd run walkthrough` drives a headless Chrome or Edge through the full workflow (submission, assignment, planning meeting, two-step project, invalid dates, Gantt save/reload, requestor read-only access, acceptance, release, closure) and the stored-data recovery cases. It is not part of `npm test` or GitHub Actions because it needs a local browser.

- Requires Node 22+ and Chrome or Edge in a standard install location, or `BROWSER_PATH` set to the browser executable.
- Starts its own server on port 4190 (`WALKTHROUGH_PORT`) and uses debugging port 9333 (`WALKTHROUGH_DEBUG_PORT`). It refuses to start if any process is listening on either port (not only web servers) or the port cannot be used, and names the port and setting to change.
- Uses a temporary browser profile that is deleted afterwards, with its own test data. It never opens your normal browser profile or other ports, so working records are untouched.
- If the server or browser fails to start, it explains why (for example a wrong `BROWSER_PATH`) instead of failing the workflow checks.
- On success, failure, or Ctrl+C it stops only the server and browser it started, with their child processes, and deletes the temporary profile. Other browsers and servers, including one running `npm start`, are never stopped.
- Exit codes: `0` all checks passed, `1` a check failed, `2` could not start, `130` cancelled.
- Set `WALKTHROUGH_SCREENSHOTS` to a folder to save screenshots (for example `tmp/`, which Git ignores).

```powershell
npm.cmd run walkthrough
$env:WALKTHROUGH_SCREENSHOTS = 'tmp'; npm.cmd run walkthrough
```

### Optional walkthrough failure-path check (Windows only)

`npm.cmd run walkthrough:failures` checks that the walkthrough fails clearly and cleans up after itself. It covers ports held by non-web listeners (IPv4 and IPv6), a missing or broken browser, invalid port settings, a server that crashes or never becomes ready, a browser crash mid-run, and a real Ctrl+C both mid-run and during setup. After each case it confirms no walkthrough processes or temporary profiles remain, both ports are free, and servers or browsers that were already running are still running. It takes about three minutes.

- Windows only. It uses Windows PowerShell to list processes and to send Ctrl+C to a hidden console window. It exits with a message on other systems. Linux and macOS have not been tested, for either this check or the walkthrough's cleanup.
- Requires the same Node and browser setup as the walkthrough, and the same free ports (`WALKTHROUGH_PORT`, `WALKTHROUGH_DEBUG_PORT`). It refuses to start if another walkthrough is running.
- It never stops an existing app server or browser. The only process it stops directly is the walkthrough's own headless browser, in the crash case. Fixtures are created in a temporary folder and deleted afterwards. Nothing is written to the repository.
- Not part of `npm test` or GitHub Actions.

```powershell
npm.cmd run walkthrough:failures
```

## Source map

Browser scripts are classic scripts that share top-level names, so `index.html` loads them in dependency order: `timeline-core.js`, `ticket-core.js`, `ui-common.js`, `recovery-view.js`, `app.js`, `projects.js`. `projects.js` wraps `open` and `detail`, so those remain function declarations.

| File | Responsibility |
| --- | --- |
| `public/ticket-core.js` | Statuses, demo identities, role visibility, progress, safe localStorage load/save, and stored-data recovery |
| `public/ui-common.js` | Shared display helpers (escaping, status pills, people, progress bars, toast) and the side drawer dialog with its close, overlay, and Escape handling |
| `public/recovery-view.js` | Recovery screen for unreadable or invalid stored records: download, retry, and confirmed reset |
| `public/app.js` | Seed data, app state, ticket list and detail, ticket lifecycle, comments, notifications, linked change lifecycle |
| `public/projects.js` | Dated project creation, task forms, Gantt views, project detail edits |
| `public/timeline-core.js` | Validated UTC calendar dates and inclusive timeline calculations |
| `public/style.css`, `public/projects.css` | Base JARC styling and project/Gantt layouts |
| `server.cjs` | Server entry point: loads settings (and an optional local `.env`), starts the server, and shuts down cleanly |
| `server/app.cjs` | Static file serving for the prototype, plus `/healthz` and `/readyz`; no ticket API yet |
| `server/config.cjs` | Environment variable validation and `.env` loading that never overrides existing settings |
| `server/database.cjs` | MongoDB client for the configured database; currently used only for the readiness ping |
| `server/redact.cjs` | Removes connection strings, usernames, and passwords from logged text |
| `railway.json` | Railway start command, `/readyz` deploy health check, and restart policy |
| `scripts/browser-walkthrough.mjs` | Optional headless-browser workflow and recovery check; not run in CI |
| `scripts/walkthrough-failure-paths.mjs` | Optional Windows-only check of walkthrough startup failures, crash handling, and Ctrl+C cleanup; not run in CI |
| `docs/REFERENCE-CHANGES.md` | Review annotations, implemented changes, interpretation, and open decisions |
| `docs/ARCHITECTURE.md` | Architecture decision (GitHub, Railway, MongoDB), secrets handling, and pending owner details |
| `docs/BACKEND-PLAN.md` | Backend implementation plan and the decisions it needs |
| `.env.example` | Server settings with placeholders only; copy to the Git-ignored `.env` for local use |
| `docs/reference/annotated-review.pdf` | User-supplied annotated visual reference, retained unchanged |

## Prototype boundaries

All records are in this browser's localStorage (`jarc-helpdesk-v1`), not on the server. Separate browsers, devices, hostnames, and ports have separate data. The ZIP includes code and sample data, not your browser's working records. Existing local records are preserved; tasks without dates are labeled unscheduled. Fresh demo schedules are illustrative, not agreed business commitments.

If the stored records cannot be read or are missing required fields, the app opens a recovery screen instead of loading sample data. The original value is left untouched, an exact copy is saved under a `jarc-helpdesk-v1-backup-<timestamp>` key when possible, and automatic saving is paused. You can download the stored value, try again, or explicitly reset to sample data; backups are kept after a reset. If a save fails (for example, storage is full), the app warns that recent changes exist only in the open tab.

Real authentication, server-enforced permissions, shared data storage, file uploads, and email/calendar delivery are future phases. The server can check a MongoDB connection, but the UI does not use the database yet. Current UI role checks do not secure data. Do not use this as a production multi-user system until those phases are built.

The current request form fields are intentionally retained. Category-specific forms await the owner's category definitions.

![Project Gantt example](docs/screenshots/project-gantt.jpg)
