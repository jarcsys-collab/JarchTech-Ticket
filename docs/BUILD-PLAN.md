# Continue building with Claude Code

Use a separate feature branch per phase. Each phase should end with a working local app, relevant checks, and a reviewed commit. This ZIP is the starting prototype, not the finished production application.

## Phase 1 - Baseline and readable modules

Prompt:

> Read CLAUDE.md and the docs. Run the current checks and explain the existing architecture. Refactor the compact legacy ticket code into readable modules without changing the UI or agreed workflow. Preserve existing localStorage records and project dates. Verify ticket creation, assignment, Gantt creation, task persistence, and acceptance. Do not choose a backend or deploy yet.

Acceptance: same visible behavior, working data migration if schema changes, meaningful workflow coverage added.

## Phase 2 - Select the shared architecture

Prompt:

> Propose a shared database, authentication approach, and hosting plan suitable for our team. Ask how many users need access, whether company Microsoft/Google sign-in is required, and where the company permits hosting. Compare the simplest two options, including recurring costs and backups. Wait for my choice before adding external services.

Acceptance: agreed architecture decision recorded in docs. No secret values committed.

## Phase 3 - Real accounts and ticket API

Prompt:

> Implement the agreed backend and sign-in in a feature branch. Replace the Demo role selector with authenticated Requestor, Admin, and Developer roles. Enforce record visibility and allowed status transitions on the server. Requestors see only their tickets, admins see all, and developers see assigned work. Preserve the JARC UI and provide a safe import path for prototype data. Test unauthorized reads and writes.

Acceptance: persistent shared tickets, real identities, server-side authorization, migrations and access tests.

## Phase 4 - Projects and Gantt persistence

Prompt:

> Persist named projects, participants, requirements, criteria, dated tasks, and completion. Keep the two-step creation wizard and project-to-Gantt navigation. Validate dates on the server, prevent duplicate project creation for one ticket, and handle concurrent edits. Requestor project access is read-only except comments and acceptance.

Acceptance: shared timeline updates across sessions with audit history; invalid schedules rejected by API and UI.

## Phase 5 - Full delivery and linked changes

Prompt:

> Implement server-enforced review, assignment, planning, development, testing, acceptance, release, and closure. Keep meeting and change records inside ticket details, not sidebar tabs. Add the linked change assessment/agreement/approval lifecycle with approver identity, dates, and impact history. A correction to agreed criteria must stay on the original ticket.

Acceptance: integration tests across all role handoffs and rejected transitions.

## Phase 6 - Notifications and attachments

Prompt:

> Add the approved email/calendar provider and file storage. Show in-app notifications, send emails for required actions, and support planning invites and secure attachments. Test delivery retries, duplicate prevention, file limits, and permission checks. Keep integration secrets in environment variables.

Acceptance: verified delivery in a test account; retry behavior documented; no unauthorized attachment access.

## Phase 7 - Pilot and deployment

Prompt:

> Prepare a pilot release with automated workflow tests, backup/restore instructions, accessibility and responsive checks, deployment steps, and rollback. Run a complete Requestor -> Admin -> Developer -> Requestor walkthrough. Show remaining defects and the exact deployment plan before deploying.

Acceptance: owner approves pilot scope and hosting, restore tested, production checklist reflects actual results.

## Everyday Claude session

1. `git switch -c feature/descriptive-name` from a clean, updated main branch.
2. Run `claude` inside this repository.
3. Give one phase or bounded feature request. Review the diff before committing.
4. Run `npm.cmd run check` and `npm.cmd test` plus browser checks for changed flows.
5. Commit and push the branch; open a pull request on GitHub.
6. Merge after review. Keep main working and make the next branch from updated main.
