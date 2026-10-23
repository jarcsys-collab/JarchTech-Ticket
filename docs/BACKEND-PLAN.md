# Backend implementation plan

This plan follows the architecture in `docs/ARCHITECTURE.md`: GitHub, Railway, and MongoDB, all on the owner's existing accounts. It covers build-plan phases 3–5 (accounts and the ticket API, project and Gantt persistence, delivery and linked changes). Status: step 0 is complete, and the connection-ready part of step 2 is implemented. Atlas connectivity to the separate `jarctech_ticket_dev` database was verified locally (ping only, no writes). Nothing is deployed, and the UI still uses browser storage only. Authentication and API persistence are not started.

## What must not change

The approved JARC UI and branding; the current request form fields (title, name, department, category, target date, description, acceptance criteria); two-step project creation (scope, then dated tasks); one project per ticket; project-to-Gantt navigation; the ticket and linked-change workflows in `docs/WORKFLOW.md`; the acceptance → release → admin closure sequence; Tickets and Projects as the only sidebar entries; calendar dates stored without timezone drift; unscheduled tasks staying unscheduled.

## Sequence

Each step is its own branch and pull request. Steps 1–2 need no owner decisions. Steps 3 onwards need the decisions listed at the end.

| Step | Scope | Needs |
| --- | --- | --- |
| 0 | Architecture decision record, this plan, `.env.example` | Done |
| 1 | Finish the frontend module refactor: move ticket and change actions out of `app.js` behind a data adapter interface with a local (localStorage) adapter. No behavior change, verified the same way as earlier steps. CLAUDE.md requires this before browser state moves to the server. | Not started |
| 2 | Server foundation. **Done:** settings validation with redacted messages, optional `.env`, Railway `PORT`/`HOST`, `/healthz` and `/readyz`, static UI serving, clean shutdown, MongoDB connection (ping only), and tests against a temporary database. **Remaining:** collection validators and indexes, which are added with the first collections in step 4. | The owner approved the `mongodb` driver and the development-only `mongodb-memory-server` by asking for this step |
| 3 | Authentication, users, sessions, first-admin bootstrap, central permission policy, unauthorized-access tests. **Implemented on `feature/entra-auth`** (mock-tested); the ticket permission policy moves to step 4 with the ticket API. | D1, D2 decided; first Admin's email pending |
| 4 | Ticket API, and the UI switches to the API adapter in signed-in mode. **Beta stage done:** the shared beta simulation workspace (`BETA_SIMULATION=enabled`) stores tickets, projects, tasks, comments, activity, and linked changes in MongoDB, with server-validated workflow actions under simulated views. **Remaining:** real (non-simulated) ticket ownership and Admin/Developer role enforcement for production tickets. | Step 3 |
| 5 | Projects and Gantt API (phase 4) | Step 4 |
| 6 | Linked change lifecycle API (phase 5) | Step 4 |
| 7 | Import of existing local data | Step 4, D6 |
| 8 | Staging deployment on Railway, only after explicit approval | D3, D4, D5 |

## 1. Node.js backend for Railway

- **One service** serves both the UI (`public/`) and the API. Same origin, so there's no cross-origin (CORS) setup, and secure session cookies stay simple. `server.cjs` grows into `server/` modules. The local static mode keeps working while the API is built.
- **Railway compatibility:**
  - Listen on `process.env.PORT`.
  - Bind to `process.env.HOST`: `0.0.0.0` on Railway, `127.0.0.1` locally. Today the server always binds to `127.0.0.1`.
  - Start command `npm start`; Node version from `engines` (>=22).
  - A `railway.json` sets the health check path.
  - On `SIGTERM`, stop accepting requests, finish in-flight ones, and close the MongoDB client.
- **Dependencies:** the app currently has none. Proposed minimum, subject to owner approval (D7):
  - the official `mongodb` driver;
  - one sign-in library if company accounts are chosen (`openid-client`);
  - one development-only test database package (`mongodb-memory-server`).

  HTTP routing stays on `node:http` with a small router. Password hashing, if chosen, uses Node's built-in `crypto.scrypt`. A lockfile is committed.
- **Shared rules:** the server reuses `public/ticket-core.js` and `public/timeline-core.js`, which already export CommonJS modules. Date and record validation is therefore the same in the browser and on the server.

## 2. MongoDB collections and validation

Every collection gets a `$jsonSchema` validator (strict validation, errors rejected). The API also validates each request before writing. Calendar dates such as target dates and task start/end are stored as `YYYY-MM-DD` strings so they never shift across timezones. Moments in time (created, updated, event times) are stored as UTC dates. People are referenced by stable user IDs, plus a stored display-name snapshot.

| Collection | Purpose and key fields | Indexes |
| --- | --- | --- |
| `users` | email (lowercase), display name, role (`Requestor`, `Admin`, or `Developer`), active flag, sign-in subject ID | unique email; unique sign-in subject |
| `sessions` | session ID hash, user ID, expiry. Only used if sessions are stored server-side. | TTL on expiry |
| `tickets` | ticket number (`JRC-…`), the current request fields, requestor ID, priority, status, developer ID, clarification and rejection reasons, planning meeting (date and time, location, confirmed flag, notes), testing summary, `version` | unique ticket number; requestor + updated; developer + status |
| `projects` | project number (`PRJ-…`), ticket ID, name, requirements, acceptance criteria, target date, participant IDs, tasks (embedded, each with a stable task ID, title, requirement, criteria, owner ID, optional start/end, done, schedule source), `version` | **unique ticket ID** (a project links to one ticket only) |
| `changes` | change number (`CR-…`), ticket ID, title, reason, criteria, status, impact assessment (impact, effort, revised date), requestor agreement, approval (approver ID, time), deferral review date, `version` | unique change number; ticket ID |
| `events` | append-only audit log and comments: subject (ticket, project, or change), actor ID, type, text, time | subject + time |
| `notifications` | in-app notices per user, read flag | user + time |
| `counters` | sequences for the `JRC-`, `CR-` and `PRJ-` numbers, kept continuous with imported numbers | — |
| `imports` | the original uploaded local data stored verbatim, its checksum, who uploaded it, the dry-run report, and status | unique checksum |

The `history` arrays that tickets and changes carry today become `events` records. The API returns them in the same order the UI shows.

**Concurrent edits:** every write includes the record's `version`. A stale version returns 409 Conflict, and the UI reloads the record instead of overwriting someone else's change.

**Status changes:** status moves only through a server-side transition table, described next. Clients cannot set arbitrary statuses.

## 3. Authentication and server-enforced permissions

The design depends on decision D2:

- **Company Microsoft or Google sign-in (recommended if the company uses either).** OpenID Connect authorization code flow with PKCE. Sign-in is restricted to the company tenant or domain. The app stores no passwords, and offboarding happens automatically when the company account is disabled.
- **Email and password.**
  - Passwords are hashed with `scrypt`, and sign-in attempts are rate-limited.
  - Accounts are created by an admin invitation.
  - Password reset needs an email provider, which isn't chosen yet (phase 6). Until then an admin would issue one-time reset links.

Common to both options:

- **Sessions:** an `HttpOnly`, `Secure`, `SameSite=Lax` cookie holding a server-side session. Write requests are also checked against the request's Origin header to block cross-site request forgery.
- **Roles:** stored in `users` and assigned by an admin. The demo role selector is removed in signed-in mode. The first admin is created by a one-time command for the email in `BOOTSTRAP_ADMIN_EMAIL`. There are no default accounts or passwords.
- **One permission policy module** decides every read and write.
  - **Reads:** Requestors see their own tickets, plus the linked projects and changes. Admins see everything. Developers see tickets assigned to them, plus the linked projects and changes. List queries are filtered in the database, not only in the UI.
  - **Writes:** a role × current status → allowed action table that mirrors today's UI rules. Examples:
    - Admin: review, set priority, assign, request clarification, reject with a reason, close after release.
    - Developer (assigned): schedule the planning meeting, create the project once, manage tasks and dates, submit testing results, confirm release.
    - Requestor (owner): confirm the meeting, comment, accept or return a correction.
  - **Project writes by requestors:** read-only, except comments and acceptance.
- **Responses:** a record the user may not read returns 404, so its existence isn't revealed. An action the user may not perform returns 403.
- **Tests:** a matrix test checks every role against every endpoint and status for unauthorized reads, writes, and transitions.

## 4. API endpoints replacing browser persistence

JSON under `/api/v1`. Every endpoint requires a session except the health checks and the sign-in routes.

| Area | Endpoints |
| --- | --- |
| Session | `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` (or `POST /auth/login` for passwords); `GET /api/v1/me` |
| Tickets | `GET /tickets` (filtered by role; search and status filter), `POST /tickets` (requestor, current fields), `GET /tickets/:id`, `POST /tickets/:id/actions` (`{action, reason?, priority?, developerId?, …}` checked against the transition table), `PUT /tickets/:id/meeting`, `POST /tickets/:id/meeting/confirm`, `POST /tickets/:id/comments` |
| Projects | `POST /tickets/:id/project` (scope and dated tasks created together, as in the two-step wizard; rejects a second project), `GET /projects`, `GET /projects/:id` (Gantt data), `PATCH /projects/:id/scope`, `POST /projects/:id/tasks`, `PATCH /projects/:id/tasks/:taskId`, `DELETE /projects/:id/tasks/:taskId` |
| Changes | `POST /tickets/:id/changes`, `GET /changes/:id`, `PUT /changes/:id/impact`, `POST /changes/:id/agree`, `POST /changes/:id/approve` (adds the project task, as today), `POST /changes/:id/actions` |
| Notifications | `GET /notifications`, `POST /notifications/read` |
| Admin | `GET/POST/PATCH /users`, `POST /imports` (dry run), `POST /imports/:id/commit`, `POST /imports/:id/rollback` |
| Health | `GET /healthz` (process is up), `GET /readyz` (MongoDB answers a ping) |

**UI switch-over:** the data adapter from step 1 gets an API implementation. The UI keeps rendering the same state shape. Actions call the API and re-render from the returned records, so markup and screens stay as they are. Validation errors from the server appear in the existing toast.

## 5. Deliberate import of existing local data

1. **Export:** an admin-visible "Export local data" action downloads the exact `jarc-helpdesk-v1` value, and any `-backup-` copies, as a file. The browser's records are not changed or deleted.
2. **Dry run:** the admin uploads the file to `POST /imports`. The server stores the original **verbatim**, with a checksum, and validates it using the same rules as recovery mode. It returns a report and writes nothing else. The report covers:
   - record counts;
   - names that need mapping to user accounts (for example "Adriane Venzon" to a real account);
   - ticket and change number conflicts;
   - the sample demo records (`JRC-1037`–`JRC-1042`, `CR-201`), excluded by default;
   - tasks that will stay unscheduled;
   - demo dates, flagged as illustrative.
3. **Commit:** after the admin confirms the mapping, all records are written in one database transaction, each tagged with the import ID. Existing numbers are kept and the counters move past them. History becomes `events` with the original timestamps where they can be read; otherwise the original text is preserved.
4. **Reversible:** `rollback` removes records carrying that import ID, but only those not edited since the import; any others are reported. Importing the same file twice is refused, matched by checksum.
5. **Originals preserved:** the uploaded file stays in `imports`, and the browser copy stays in the browser until a person removes it.

If the MongoDB deployment doesn't support transactions (for example a single standalone server), the commit runs as a staged write with the import ID marker and an automatic rollback on failure. This is decision D1.

## 6. Environment variables, health checks, tests, deployment

- **Environment variables:** listed in `.env.example`, with placeholders only. Locally they're loaded from `.env`, which is ignored by Git, using Node's built-in `--env-file`. On Railway they're set as service variables. The server refuses to start in production if a required variable is missing or `SESSION_SECRET` is weak, and it never logs connection strings.
- **Health checks:** `/healthz` reports whether the process is alive. `/readyz` checks MongoDB and is used as Railway's deploy health check, so a misconfigured database stops a bad deploy.
- **Tests:**
  - Unit tests with `node:test`: the permission matrix, the transition table, validation, and import mapping.
  - API integration tests against a temporary database (`mongodb-memory-server`, locally and in GitHub Actions; no account or cost involved), including unauthorized read and write tests for every role.
  - The existing browser walkthrough extended to sign in as each role against a temporary database.
  - Tests never use a shared or production database.
- **Deployment (step 8, only after approval):**
  1. In the existing Railway project, use the agreed environment (staging first). Add a service from the GitHub repository only with the owner's permission.
  2. Set the variables in Railway. The owner enters the MongoDB connection string directly in Railway, never in chat.
  3. Configure MongoDB network access for Railway. Railway's outbound IP addresses change unless static outbound IPs are enabled, which affects an Atlas IP access list.
  4. Deploy, confirm `/readyz`, and run a smoke test as each role.
  5. Roll back with Railway's redeploy of the previous deployment. Database changes are kept backward-compatible so a rollback is safe.

  Backups follow the existing MongoDB plan's capabilities. A restore test is part of phase 7.

## Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Is the existing MongoDB deployment **Atlas**, Railway-hosted MongoDB, or another instance? Which plan or tier? | **Decided 2026-10-22: Atlas.** The tier is still to confirm, because it affects backups. |
| D2 | **Company Microsoft or Google accounts**, or **email and password**? | **Decided 2026-10-22: Microsoft Entra ID** (OpenID Connect) |
| D3 | Which **existing Railway project and environment** should be used, and may a new service be added to it (usage-billed on your plan)? | A staging environment first |
| D4 | Database names and users: may we use one database per environment (for example `jarctech_ticket_staging`, `jarctech_ticket_prod`), each with its own user that has `readWrite` on that database only? You create the users and enter the credentials in Railway and your local `.env`. | Yes |
| D5 | MongoDB network access for Railway: an Atlas IP access list, or Railway static outbound IPs if your plan includes them? | Decide after D1 and D3 |
| D6 | Import scope: import only real records and exclude the sample demo data? Who maps prototype names to accounts? | Exclude samples; an admin maps names |
| D7 | Approve the minimal dependencies (`mongodb`, plus `openid-client` if D2 is company accounts, and the development-only `mongodb-memory-server`)? | `mongodb` and `mongodb-memory-server` were added in step 2. `openid-client` waits for the Entra step. |
| D8 | Initial users and roles, and the first admin's email. These aren't secrets, but they're needed before step 3. | — |
| D9 | Keep the browser-only demo mode available after sign-in exists? | Keep it, only when no backend is configured |
