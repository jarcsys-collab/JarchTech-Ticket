# JarcTech Ticket

A working local prototype for JARC Technologies ticket intake, admin assignment, developer planning, and shared project Gantt tracking.

## Start here

1. Extract this ZIP. Open the folder containing this README and `package.json`.
2. Install Node.js 22 or newer if needed.
3. Open a terminal in this folder and run:

```powershell
npm start
```

Open **http://localhost:4175**. There are no third-party packages to install for this version.
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
- Browser-local persistence, sample data, syntax checks, date tests, static server tests, and a GitHub Actions check.

The header's **Demo role** selector replaces the old three-button preview strip. It is a preview aid, not sign-in or access control. Requestor demo identity: Adriane Venzon. Developer demo identity: Miguel Santos.

## Continue with Claude Code and GitHub

Read [the Windows setup guide](docs/GETTING-STARTED.md), then [the phased build plan](docs/BUILD-PLAN.md). Claude Code reads the repository's [CLAUDE.md](CLAUDE.md) for context.

**Extract the ZIP before adding code to GitHub. Upload or commit its contents, not the ZIP itself.** The repository root should contain `package.json`, `server.cjs`, `CLAUDE.md`, `public/`, and `docs/`.

## Checks

```powershell
npm.cmd run check
npm.cmd test
```

## Source map

| File | Responsibility |
| --- | --- |
| `public/app.js` | Seed data, local state, ticket lifecycle, comments, notifications, linked change lifecycle |
| `public/projects.js` | Dated project creation, task forms, Gantt views, project detail edits |
| `public/timeline-core.js` | Validated UTC calendar dates and inclusive timeline calculations |
| `public/style.css`, `public/projects.css` | Base JARC styling and project/Gantt layouts |
| `server.cjs` | Local static file server; it has no ticket API or database |
| `docs/REFERENCE-CHANGES.md` | Review annotations, implemented changes, interpretation, and open decisions |
| `docs/reference/annotated-review.pdf` | User-supplied annotated visual reference, retained unchanged |

## Prototype boundaries

All records are in this browser's localStorage (`jarc-helpdesk-v1`), not on the server. Separate browsers, devices, hostnames, and ports have separate data. The ZIP includes code and sample data, not your browser's working records. Existing local records are preserved; tasks without dates are labeled unscheduled. Fresh demo schedules are illustrative, not agreed business commitments.

Real authentication, server-enforced permissions, a shared database, file uploads, and email/calendar delivery are future phases. Current UI role checks do not secure data. Do not use this as a production multi-user system until those phases are built.

The current request form fields are intentionally retained. Category-specific forms await the owner's category definitions.

![Project Gantt example](docs/screenshots/project-gantt.jpg)
