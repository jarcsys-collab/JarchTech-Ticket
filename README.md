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

## Microsoft Entra sign-in (implemented; not yet configured with real credentials)

There are two modes, chosen with `AUTH_MODE`:

| Mode | Use | Behavior |
| --- | --- | --- |
| `demo` (or unset locally) | Local only | The browser-only prototype with the Demo role selector, exactly as before. Refused when deployed. |
| `entra` | Required when deployed; optional locally | Microsoft sign-in is required for the whole app. Needs MongoDB and all of the Entra settings below. |

**Safety rules:**
- The server refuses to start if `AUTH_MODE=entra` is missing any setting, if Entra settings are present without `AUTH_MODE`, or if a deployed server would run in demo mode.
- If sign-in fails at runtime (Microsoft is unreachable, or a response is invalid), the user sees an error page. **It never falls back to demo mode.**

**Who can get in:**
- **Invitations only.** Signing in with Microsoft never grants access or a role on its own. A person must first be invited by email by a JarcTech Admin, or be the first Admin created with the bootstrap command.
- On their first sign-in, the invitation is permanently tied to their Entra account (object ID).
- Guests from other organizations, accounts from other tenants, and disabled users are denied with an "Access not granted" page. Admins can see those attempts in the sign-in log.

**Roles:**
- `Requestor`, `Admin` and `Developer` are stored on the server and read on every request.
- Any role in the browser (query string, header, cookie, or devtools) is ignored by the server.
- In signed-in mode the Demo role selector is hidden. The header shows the signed-in name, role, and **Sign out**; Admins also get a **Users** button for invitations, role changes, and disabling access.
- Admins cannot change their own role or access, and the last active Admin cannot be removed.

**Sessions:**
- Stored server-side in MongoDB. Only a hash of each session token is stored.
- They end after 8 hours idle or 24 hours in total, on sign-out, or immediately when a user is disabled.
- The cookie is `HttpOnly` and `SameSite=Lax`, and also `Secure` on https.
- Changes are only accepted from the app's own address (`APP_BASE_URL`).

> **Current limitation: this is not secure multi-user ticketing yet.**
>
> **Protected by the server:**
> - who can open the app (Microsoft sign-in plus an invitation)
> - roles
> - sessions
> - user management (Admins only)
>
> **Not yet production-ready:**
> - **Tickets are still stored only in each person's browser**, not on the server. They are not shared between people or devices, and nothing on the server enforces who may read or change them.
> - **Ticket ownership:** the Requestor name is pre-filled from the signed-in profile (read-only), and the Requestor list filters on that name. This is a display convenience, not access control.
> - **Developer filtering:** the Developer view still uses the demo developer identity, so it does not reflect real assignments.
>
> Shared tickets with server-enforced ownership, assignment, and role rules arrive with the ticket API. Existing browser records and recovery safeguards are unchanged in both modes.

### Local configuration (development app registration)

Add these to your local `.env`, which Git ignores. Never paste the values into chat.

```text
PORT=4177
AUTH_MODE=entra
APP_BASE_URL=http://localhost:4177
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<client secret Value>
SESSION_SECRET=<output of the command below>
# MONGODB_URI and MONGODB_DB_NAME stay as they are (jarctech_ticket_dev)
```

Generate `SESSION_SECRET` locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The development app registration must list exactly `http://localhost:4177/auth/callback` as a Web redirect URI. See `docs/AUTH-DESIGN.md` for every registration setting.

### One-time database commands (deliberate; run by the owner)

Both commands read the same `.env` and print the target database name. They refuse to run unless `--confirm-db` repeats that name exactly.

```powershell
npm.cmd run db:setup -- --confirm-db jarctech_ticket_dev
npm.cmd run admin:bootstrap -- --email <first-admin-work-email> --confirm-db jarctech_ticket_dev
```

- **`db:setup`** creates the `users`, `sessions`, and `events` collections with validators and indexes. It creates no users and is safe to re-run. Until it has run, `/readyz` reports `schema-missing`; the server itself never creates collections.
- **`admin:bootstrap`** creates one `invited` Admin for that work email. The person becomes active on their first Microsoft sign-in with that email. Everyone else is invited from the **Users** screen, where Admins can also revoke a pending invitation.
  - It always refuses once an Admin is active, and also refuses if that email already exists.
  - If the only Admin is a pending invitation (for example after a mistyped email), rerun it with `--replace-invitation`. This revokes the pending invitation and creates the new one. It never touches an Admin who has signed in.

Then start with `npm.cmd start` and open http://localhost:4177. You'll see the sign-in page.

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

### Optional signed-in screen check (mock Microsoft sign-in)

`npm.cmd run walkthrough:auth` runs headless Chrome or Edge against the server in `AUTH_MODE=entra`. It uses a **mock** Entra provider and a **temporary** MongoDB, so it never contacts Microsoft or Atlas and never reads `.env`. It checks:
- the sign-in and access-denied pages, and that browser records survive sign-in
- the signed-in header, with the demo role selector hidden
- the pre-filled, read-only Requestor name
- that a Requestor cannot use the admin API
- sign-out
- the Admin Users screen: invite, revoke, and role change

Ports are chosen automatically. It uses a temporary browser profile and cleans up after success, failure, or Ctrl+C. Set `AUTH_CHECK_SCREENSHOTS` to a folder (for example `tmp/auth`) to save screenshots. It is not part of `npm test` or GitHub Actions.

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
| `server/http.cjs` | Cookies, JSON request bodies (size-limited), responses, and same-origin checks |
| `server/schema.cjs` | `users`, `sessions`, and `events` validators and indexes; created only by `npm run db:setup`, checked read-only by `/readyz` |
| `server/auth/index.cjs` | Sign-in routes, the signed-in API (`/api/v1/me`, Admin `/api/v1/users`), and the gate in front of the app |
| `server/auth/oidc.cjs` | Microsoft Entra OpenID Connect (code flow with PKCE, state, nonce, and ID token signature checks) via `openid-client` |
| `server/auth/store.cjs` | Admission rules, invitations, role changes, server-side sessions, and the audit log |
| `server/auth/pages.cjs`, `server/auth/tokens.cjs` | Sign-in, access-denied, signed-out, and error pages; random tokens and the encrypted sign-in flow cookie |
| `public/auth-client.js` | Signed-in mode only: header name and role, Sign out, and the Admin Users screen |
| `scripts/db-setup.cjs`, `scripts/admin-bootstrap.cjs`, `scripts/db-command.cjs` | The one-time database commands described above, and their shared confirmation and redaction handling |
| `scripts/auth-screens-check.mjs` | Optional signed-in screen check with a mock Entra provider and a temporary database (`npm run walkthrough:auth`) |
| `tests/helpers/mock-entra.cjs` | Local mock of Microsoft Entra's OpenID Connect endpoints for tests and the screen check |
| `railway.json` | Railway start command, `/readyz` deploy health check, and restart policy |
| `scripts/browser-walkthrough.mjs` | Optional headless-browser workflow and recovery check; not run in CI |
| `scripts/walkthrough-failure-paths.mjs` | Optional Windows-only check of walkthrough startup failures, crash handling, and Ctrl+C cleanup; not run in CI |
| `docs/REFERENCE-CHANGES.md` | Review annotations, implemented changes, interpretation, and open decisions |
| `docs/ARCHITECTURE.md` | Architecture decision (GitHub, Railway, MongoDB), secrets handling, and pending owner details |
| `docs/BACKEND-PLAN.md` | Backend implementation plan and the decisions it needs |
| `docs/AUTH-DESIGN.md` | Microsoft Entra sign-in design: admission rules, server-side sessions and roles, tests, app-registration settings, and open decisions (not implemented yet) |
| `.env.example` | Server settings with placeholders only; copy to the Git-ignored `.env` for local use |
| `docs/reference/annotated-review.pdf` | User-supplied annotated visual reference, retained unchanged |

## Prototype boundaries

All records are in this browser's localStorage (`jarc-helpdesk-v1`), not on the server. Separate browsers, devices, hostnames, and ports have separate data. The ZIP includes code and sample data, not your browser's working records. Existing local records are preserved; tasks without dates are labeled unscheduled. Fresh demo schedules are illustrative, not agreed business commitments.

If the stored records cannot be read or are missing required fields, the app opens a recovery screen instead of loading sample data. The original value is left untouched, an exact copy is saved under a `jarc-helpdesk-v1-backup-<timestamp>` key when possible, and automatic saving is paused. You can download the stored value, try again, or explicitly reset to sample data; backups are kept after a reset. If a save fails (for example, storage is full), the app warns that recent changes exist only in the open tab.

Microsoft Entra sign-in and server-side roles exist, but they control only who can open the app and who can manage users. Ticket records are still browser-local, so ticket permissions are not enforced by the server yet. Shared ticket storage and server-enforced ticket permissions, file uploads, and email/calendar delivery are future phases. Do not use this as a production multi-user system until those phases are built.

The current request form fields are intentionally retained. Category-specific forms await the owner's category definitions.

![Project Gantt example](docs/screenshots/project-gantt.jpg)
